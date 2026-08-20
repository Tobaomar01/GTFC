#!/usr/bin/env node
/**
 * Recette fonctionnelle du modèle « redevable ».
 *
 *   node scripts/recette-redevables.js
 *   API_URL=http://192.168.0.10:4000 node scripts/recette-redevables.js
 *
 * Enchaîne les parcours réels : l'agent sur le terrain, puis le redevable sur
 * son portail, puis le superviseur en instruction. Chaque contrôle échoue
 * bruyamment plutôt que de continuer sur une hypothèse fausse.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POURQUOI UN REDEVABLE JETABLE À CHAQUE PASSAGE
 *
 *  Le portail plafonne les demandes de code à cinq par heure et par numéro.
 *  Une recette qui réutiliserait toujours le même numéro passerait la
 *  première fois, puis échouerait les suivantes — en accusant le portail
 *  alors que la limite fonctionne exactement comme prévu.
 *
 *  Chaque exécution fabrique donc son propre redevable, avec un numéro dérivé
 *  de l'horloge. La recette est rejouable autant de fois qu'on veut.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const COMMUNE = process.env.COMMUNE_SLUG || 'gtfc';
const IDENTIFIANT = process.env.RECETTE_TEL || '+221700000002';
const MOT_DE_PASSE = process.env.RECETTE_MDP || 'GtfcDemo2026!';

let jeton = null;
let cookiePortail = null;
let reussis = 0;
let echoues = 0;

const C = {
  ok: (t) => `\x1b[32m✓\x1b[0m ${t}`,
  ko: (t) => `\x1b[31m✗\x1b[0m ${t}`,
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

async function appel(methode, chemin, corps = null, { portail = false } = {}) {
  const entetes = { 'Content-Type': 'application/json' };
  if (jeton && !portail) entetes.Authorization = `Bearer ${jeton}`;
  if (portail && cookiePortail) entetes.Cookie = cookiePortail;

  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: entetes,
    body: corps ? JSON.stringify(corps) : undefined,
  });

  const brut = await r.text();
  let json = null;
  try { json = JSON.parse(brut); } catch { /* réponse non JSON */ }

  const cookie = r.headers.get('set-cookie');
  if (cookie) [cookiePortail] = cookie.split(';');

  return { statut: r.status, json, brut, donnees: json?.donnees };
}

function verifier(libelle, condition, detail = '') {
  if (condition) {
    console.log(`  ${C.ok(libelle)}`);
    reussis += 1;
  } else {
    console.log(`  ${C.ko(libelle)}`);
    if (detail) console.log(`      ${C.gris(String(detail).slice(0, 180))}`);
    echoues += 1;
  }
}

const titre = (t) => console.log(`\n  ${C.gras(t)}`);

(async () => {
  console.log(`\n${C.gras('Recette — modèle redevable')}   ${C.gris(API)}\n`);

  // ------------------------------------------------------------- connexion
  const co = await appel('POST', '/auth/login', {
    telephone: IDENTIFIANT, mot_de_passe: MOT_DE_PASSE,
  });
  if (co.statut !== 200) {
    console.log(`  ${C.ko(`connexion impossible (${co.statut})`)}`);
    console.log(`      ${C.gris(co.brut.slice(0, 200))}`);
    console.log('\n  L\'API tourne-t-elle ? bash scripts/demo-locale.sh etat\n');
    process.exit(1);
  }
  jeton = co.donnees.jeton_acces ?? co.donnees.acces ?? co.donnees.token;
  verifier('connexion', Boolean(jeton));

  // ------------------------------------------------ redevable de la recette
  // Numéro dérivé de l'horloge : jamais deux fois le même, donc jamais de
  // collision avec un dossier existant ni avec le plafond horaire de codes.
  const suffixe = String(Date.now()).slice(-8);
  const telTest = `+22178${suffixe}`;

  titre('Redevables');
  const liste = await appel('GET', '/redevables?limite=5');
  verifier('liste des redevables',
    liste.statut === 200 && liste.donnees.length > 0, `statut ${liste.statut}`);

  const creation = await appel('POST', '/redevables', {
    type_redevable: 'personne_physique',
    nom: 'Recette', prenom: 'Automatique',
    telephone: telTest,
  });
  verifier('création d\'un redevable', creation.statut === 201 && Boolean(creation.donnees?.id),
    `statut ${creation.statut} ${creation.brut}`);
  const sujet = creation.donnees;
  if (!sujet) { console.log('\n  Recette interrompue.\n'); process.exit(1); }

  const fiche = await appel('GET', `/redevables/${sujet.id}`);
  verifier('dossier consolidé (objets, avis, contestations)',
    fiche.statut === 200 && Array.isArray(fiche.donnees.objets)
    && Array.isArray(fiche.donnees.avis), `statut ${fiche.statut}`);

  const doublon = await appel('POST', '/redevables', {
    type_redevable: 'personne_physique', nom: 'Doublon', telephone: telTest,
  });
  verifier('numéro déjà pris → 409, avec le dossier existant en réponse',
    doublon.statut === 409 && Boolean(doublon.json?.erreur?.details?.redevable_id),
    `statut ${doublon.statut}`);

  const morale = await appel('POST', '/redevables', {
    type_redevable: 'personne_morale', nom: 'Sans raison sociale',
  });
  verifier('personne morale sans raison sociale → 400',
    morale.statut === 400, `statut ${morale.statut}`);

  // ------------------------------------------------- vérification du numéro
  titre('Vérification du numéro (code à usage unique)');
  const envoi = await appel('POST', `/redevables/${sujet.id}/telephone/code`);
  verifier('envoi du code',
    envoi.statut === 200 && Boolean(envoi.donnees?.code_simule || envoi.donnees?.expire_le),
    `statut ${envoi.statut} ${envoi.brut}`);

  const code = envoi.donnees?.code_simule;
  if (!code) {
    console.log(`      ${C.gris('Opérateur SMS raccordé : la suite du parcours code ne peut pas être automatisée.')}`);
  } else {
    const faux = await appel('POST', `/redevables/${sujet.id}/telephone/verifier`,
      { code: code === '000000' ? '111111' : '000000' });
    verifier('code faux refusé, tentatives décomptées',
      faux.statut === 401 && /tentative/i.test(faux.json?.erreur?.message ?? ''),
      `statut ${faux.statut} ${faux.brut.slice(0, 120)}`);

    const bon = await appel('POST', `/redevables/${sujet.id}/telephone/verifier`, { code });
    verifier('code juste → numéro vérifié',
      bon.statut === 200 && bon.donnees?.statut_telephone === 'verifie',
      `statut ${bon.statut} ${bon.brut.slice(0, 150)}`);

    const rejoue = await appel('POST', `/redevables/${sujet.id}/telephone/verifier`, { code });
    verifier('code non rejouable', rejoue.statut === 401, `statut ${rejoue.statut}`);
  }

  // ----------------------------------------------------------------- rues
  titre('Rues — phase 0');
  const importRues = await appel('POST', '/rues/import', {
    source: 'pdc',
    rues: [
      { code: 'GT-63', nom: 'Rue GT 63', type_voie: 'rue', variantes: ['rue gt63'] },
      { code: 'C-41', nom: 'Rue 41 Colobane', type_voie: 'rue', variantes: [] },
    ],
  });
  const bilan = importRues.donnees ?? {};
  verifier('import de rues (rejouable)',
    importRues.statut === 200 && (bilan.crees + bilan.inchangees + bilan.traces_completes) === 2,
    `statut ${importRues.statut} ${importRues.brut.slice(0, 150)}`);

  const reimport = await appel('POST', '/rues/import', {
    source: 'osm',
    rues: [{ code: 'GT-63', nom: 'Rue GT soixante-trois', variantes: ['GT63'] }],
  });
  verifier('réimport : le libellé validé par la mairie n\'est pas écrasé',
    reimport.statut === 200 && reimport.donnees.crees === 0,
    `crees=${reimport.donnees?.crees}`);

  const variante = await appel('GET', '/rues?q=gt63');
  verifier('recherche par graphie alternative',
    variante.statut === 200 && variante.donnees.length >= 1,
    `${variante.donnees?.length} résultat(s)`);

  const couverture = await appel('GET', '/rues/couverture');
  verifier('tableau de couverture du recensement',
    couverture.statut === 200 && couverture.donnees.total_rues >= 2,
    `statut ${couverture.statut}`);

  // ---------------------------------------------------------- objets taxables
  titre('Objets taxables');
  const affichages = await appel('GET', '/affichages?limite=1');
  verifier('dispositifs d\'affichage (enseignes reprises)',
    affichages.statut === 200 && affichages.donnees.length >= 1, `statut ${affichages.statut}`);

  const dispo = affichages.donnees?.[0];
  if (dispo) {
    const montant = await appel('GET', `/affichages/${dispo.id}/montant`);
    verifier('calcul du montant d\'un support',
      montant.statut === 200, `statut ${montant.statut} ${montant.brut.slice(0, 120)}`);
  }

  const chantiers = await appel('GET', '/chantiers');
  verifier('liste des chantiers', chantiers.statut === 200, `statut ${chantiers.statut}`);

  // ------------------------------------------------------------------ portail
  titre('Portail du redevable');
  const inconnu = await appel('POST', '/portail/code',
    { commune: COMMUNE, telephone: '+221700000000' }, { portail: true });
  verifier('numéro inconnu : réponse indistincte (l\'API n\'est pas un annuaire)',
    inconnu.statut === 200 && inconnu.donnees?.envoye === true, `statut ${inconnu.statut}`);

  const demande = await appel('POST', '/portail/code',
    { commune: COMMUNE, telephone: telTest }, { portail: true });
  verifier('demande de code sur un numéro vérifié',
    demande.statut === 200, `statut ${demande.statut} ${demande.brut.slice(0, 150)}`);

  const codePortail = demande.donnees?.code_simule;
  if (codePortail) {
    const session = await appel('POST', '/portail/session',
      { commune: COMMUNE, telephone: telTest, code: codePortail }, { portail: true });
    verifier('ouverture de session',
      session.statut === 200 && session.donnees?.connecte === true,
      `statut ${session.statut} ${session.brut.slice(0, 150)}`);
    verifier('le jeton de session n\'apparaît pas dans le corps de la réponse',
      !/jeton|token/i.test(JSON.stringify(session.donnees ?? {})));

    const dossier = await appel('GET', '/portail/dossier', null, { portail: true });
    verifier('consultation du dossier',
      dossier.statut === 200 && Boolean(dossier.donnees?.redevable),
      `statut ${dossier.statut} ${dossier.brut.slice(0, 150)}`);
    verifier('aucun avis au brouillon exposé au redevable',
      (dossier.donnees?.avis ?? []).every((a) => a.statut !== 'brouillon'));

    const changement = await appel('POST', '/portail/telephone',
      { nouveau_telephone: '+221770000001' }, { portail: true });
    verifier('changement de numéro refusé depuis le portail',
      changement.statut === 403, `statut ${changement.statut}`);

    // Cloisonnement : l'avis d'un autre redevable doit rester introuvable.
    const autre = liste.donnees.find((r) => r.id !== sujet.id);
    if (autre) {
      const ficheAutre = await appel('GET', `/redevables/${autre.id}`);
      const avisAutre = ficheAutre.donnees?.avis?.[0];
      if (avisAutre) {
        const vol = await appel('GET', `/portail/avis/${avisAutre.id}`, null, { portail: true });
        verifier('avis d\'un tiers inaccessible depuis le portail',
          vol.statut === 404, `statut ${vol.statut}`);
      }
    }

    const motifs = await appel('GET', '/portail/motifs-contestation', null, { portail: true });
    verifier('motifs de contestation exposés',
      motifs.statut === 200 && motifs.donnees.length === 6,
      `${motifs.donnees?.length} motif(s)`);

    const contestation = await appel('POST', '/portail/contestations', {
      motif_id: motifs.donnees?.[0]?.id,
      description: 'Ma catégorie d\'activité ne correspond pas à mon commerce.',
    }, { portail: true });
    verifier('dépôt d\'une contestation',
      contestation.statut === 201 && Boolean(contestation.donnees?.numero),
      `statut ${contestation.statut} ${contestation.brut.slice(0, 150)}`);

    await appel('POST', '/portail/deconnexion', null, { portail: true });
    const apres = await appel('GET', '/portail/dossier', null, { portail: true });
    verifier('session fermée → dossier inaccessible',
      apres.statut === 401, `statut ${apres.statut}`);
  }

  // -------------------------------------------------------------- instruction
  titre('Instruction côté mairie');
  const file = await appel('GET', '/contestations?statut=soumise');
  verifier('file d\'instruction',
    file.statut === 200 && Array.isArray(file.donnees), `statut ${file.statut}`);

  const ct = file.donnees?.[0];
  if (ct) {
    const sansMotif = await appel('POST', `/contestations/${ct.id}/instruire`, {
      statut: 'en_instruction', suspend_recouvrement: true,
    });
    verifier('suspension du recouvrement sans motif → refusée',
      sansMotif.statut === 400, `statut ${sansMotif.statut}`);

    const rejetSec = await appel('POST', `/contestations/${ct.id}/resoudre`, {
      decision: 'rejetee', motif_decision: 'non',
    });
    verifier('rejet non motivé → refusé', rejetSec.statut === 400, `statut ${rejetSec.statut}`);

    const resolu = await appel('POST', `/contestations/${ct.id}/resoudre`, {
      decision: 'acceptee',
      motif_decision: 'Catégorie corrigée en ACT-12 après vérification sur place.',
    });
    verifier('résolution motivée acceptée',
      resolu.statut === 200 && resolu.donnees?.statut === 'acceptee',
      `statut ${resolu.statut}`);
  } else {
    console.log(`      ${C.gris('Aucune contestation en attente : étape sautée.')}`);
  }

  // ------------------------------------------------------------------- bilan
  console.log(`\n  ${C.gras(`${reussis} réussi(s), ${echoues} échec(s)`)}`);
  console.log(`  ${C.gris(`Redevable de recette : ${sujet.code} (${telTest}) — archivable depuis le dashboard.`)}\n`);
  process.exit(echoues > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\n  ${C.ko(e.message)}\n`);
  process.exit(1);
});
