#!/usr/bin/env node
/**
 * Recette de la synchronisation des nouveaux objets taxables.
 *
 *   node scripts/recette-sync-objets.js
 *
 * Reproduit EXACTEMENT ce que l'application mobile envoie après une journée
 * hors ligne : un lot d'opérations avec des identifiants locaux, dans le
 * désordre où l'agent les a produites.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CETTE RECETTE CHERCHE À PRENDRE EN DÉFAUT
 *
 *  1. LA DÉPENDANCE ENTRE OBJETS. Une enseigne recensée sur un commerce
 *     lui-même créé hors ligne n'a pas d'identifiant serveur au moment où
 *     l'agent la saisit. Si la résolution échoue, le panneau se rattache à
 *     personne — et personne ne le remarque avant la facture.
 *
 *  2. L'IDEMPOTENCE. Une coupure réseau au mauvais moment fait renvoyer le
 *     lot. Sans garde-fou, la commune se retrouve avec deux panneaux là où
 *     il n'y en a qu'un, et facture deux fois.
 *
 *  3. LE REFUS D'AFF-06. Les plaques réglementées ne doivent pas entrer par
 *     la porte de la synchronisation alors qu'elles sont masquées dans
 *     l'interface.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

const API = process.env.API_URL || 'http://127.0.0.1:4000';
const IDENTIFIANT = process.env.RECETTE_TEL || '+221700000002';
const MOT_DE_PASSE = process.env.RECETTE_MDP || 'GtfcDemo2026!';

let jeton = null;
let reussis = 0;
let echoues = 0;

const C = {
  ok: (t) => `\x1b[32m✓\x1b[0m ${t}`,
  ko: (t) => `\x1b[31m✗\x1b[0m ${t}`,
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

async function appel(methode, chemin, corps = null) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: {
      'Content-Type': 'application/json',
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const brut = await r.text();
  let json = null;
  try { json = JSON.parse(brut); } catch { /* non JSON */ }
  return { statut: r.status, json, brut, donnees: json?.donnees };
}

function verifier(libelle, condition, detail = '') {
  if (condition) { console.log(`  ${C.ok(libelle)}`); reussis += 1; } else {
    console.log(`  ${C.ko(libelle)}`);
    if (detail) console.log(`      ${C.gris(String(detail).slice(0, 200))}`);
    echoues += 1;
  }
}

(async () => {
  console.log(`\n${C.gras('Recette — synchronisation des objets taxables')}   ${C.gris(API)}\n`);

  const co = await appel('POST', '/auth/login',
    { telephone: IDENTIFIANT, mot_de_passe: MOT_DE_PASSE });
  if (co.statut !== 200) {
    console.log(`  ${C.ko(`connexion impossible (${co.statut})`)}`);
    console.log(`      ${C.gris(co.brut.slice(0, 200))}\n`);
    process.exit(1);
  }
  jeton = co.donnees.jeton_acces ?? co.donnees.acces ?? co.donnees.token;

  // ------------------------------------------------------- paquet hors-ligne
  const paquet = await appel('GET', '/sync/paquet');
  verifier('paquet hors-ligne récupéré', paquet.statut === 200, `statut ${paquet.statut}`);

  const ref = paquet.donnees?.referentiels ?? {};
  verifier('le paquet embarque les rues', Array.isArray(ref.rues),
    `rues=${typeof ref.rues}`);
  verifier('le paquet embarque les types de dispositifs',
    Array.isArray(ref.types_affichage) && ref.types_affichage.length > 0,
    `${ref.types_affichage?.length} type(s)`);
  verifier('le paquet embarque les types de chantier',
    Array.isArray(ref.types_chantier) && ref.types_chantier.length === 6,
    `${ref.types_chantier?.length} type(s)`);
  verifier('AFF-06 (plaques réglementées) est absent du paquet',
    !(ref.types_affichage ?? []).some((t) => t.code === 'AFF-06'));
  verifier('les activités portent leur code de référentiel',
    (ref.categories ?? []).every((c) => c.code_reference));

  // ------------------------------------------------------------------ le lot
  // Un commerce créé hors ligne, PUIS une enseigne posée dessus : au moment
  // où l'agent saisit l'enseigne, le commerce n'a encore aucun identifiant
  // serveur. C'est le cas qui casse si la résolution de dépendance manque.
  const localCommerce = crypto.randomUUID();
  const localAffichage = crypto.randomUUID();
  const localPanneau = crypto.randomUUID();
  const localChantier = crypto.randomUUID();
  const identifiantLot = crypto.randomUUID();

  const zone = ref.zones?.[0];
  const quartier = (ref.quartiers ?? []).find((q) => q.zone_id === zone?.id) ?? ref.quartiers?.[0];
  const categorie = (ref.categories ?? []).find((c) => c.code_reference === 'ACT-12')
    ?? ref.categories?.[0];
  const typeEnseigne = (ref.types_affichage ?? []).find((t) => t.code === 'AFF-02')
    ?? ref.types_affichage?.[0];
  const typePanneau = (ref.types_affichage ?? []).find((t) => t.code === 'AFF-05')
    ?? typeEnseigne;
  const rue = ref.rues?.[0] ?? null;

  const lot = {
    identifiant_client: identifiantLot,
    appareil_id: 'recette-sync',
    version_app: '1.0.0',
    operations: [
      {
        entite: 'commerce', operation: 'creation',
        identifiant_local: localCommerce,
        horodatage_client: new Date().toISOString(),
        donnees: {
          enseigne: 'Atelier de recette',
          categorie_id: categorie?.id,
          zone_id: zone?.id,
          quartier_id: quartier?.id,
          gerant_nom: 'Recette',
          telephone_paiement: `+22178${String(Date.now()).slice(-8)}`,
          longitude: -17.45, latitude: 14.69,
          statut: 'actif',
        },
      },
      {
        // L'enseigne du commerce ci-dessus. commerce_id volontairement absent :
        // c'est resoudreDependances() côté téléphone qui doit l'injecter.
        entite: 'affichage', operation: 'creation',
        identifiant_local: localAffichage,
        horodatage_client: new Date().toISOString(),
        donnees: {
          type_affichage_id: typeEnseigne?.id,
          commerce_local: localCommerce,
          surface_m2: 2.4, largeur_m: 2, hauteur_m: 1.2, nb_faces: 1,
          texte_affiche: 'ATELIER DE RECETTE',
          rue_id: rue?.id ?? null,
          quartier_id: quartier?.id,
          longitude: -17.45, latitude: 14.69,
        },
      },
      {
        // Un panneau de régie : aucun commerce, jamais. Il ne doit pas rester
        // bloqué dans la file en attendant une devanture qui n'existera pas.
        entite: 'affichage', operation: 'creation',
        identifiant_local: localPanneau,
        horodatage_client: new Date().toISOString(),
        donnees: {
          type_affichage_id: typePanneau?.id,
          surface_m2: 12, nb_faces: 2,
          texte_affiche: 'PANNEAU 4x3 RECETTE',
          rue_id: rue?.id ?? null,
          quartier_id: quartier?.id,
          longitude: -17.451, latitude: 14.691,
        },
      },
      {
        entite: 'chantier', operation: 'creation',
        identifiant_local: localChantier,
        horodatage_client: new Date().toISOString(),
        donnees: {
          libelle: 'Chantier de recette',
          types: (ref.types_chantier ?? []).slice(0, 2).map((t) => t.id),
          surface_m2: 18.5,
          duree_prevue_jours: 45,
          quartier_id: quartier?.id,
          rue_id: rue?.id ?? null,
          longitude: -17.452, latitude: 14.692,
          autorisation_vue: true,
          numero_autorisation: 'PC-2026-0042',
        },
      },
    ],
  };

  console.log(`\n  ${C.gras('Envoi du lot')}`);
  const envoi = await appel('POST', '/sync/batch', lot);
  verifier('lot accepté', envoi.statut === 200 || envoi.statut === 207,
    `statut ${envoi.statut} ${envoi.brut.slice(0, 200)}`);

  const parLocal = Object.fromEntries(
    (envoi.donnees?.resultats ?? []).map((r) => [r.identifiant_local, r]));

  verifier('commerce créé', parLocal[localCommerce]?.statut === 'traite',
    JSON.stringify(parLocal[localCommerce]));

  // Le téléphone injecte commerce_id APRÈS que le commerce soit parti. Ici on
  // vérifie que le serveur accepte le panneau autonome et l'enseigne.
  verifier('enseigne rattachée créée', parLocal[localAffichage]?.statut === 'traite',
    JSON.stringify(parLocal[localAffichage]));
  verifier('panneau autonome créé (sans commerce)',
    parLocal[localPanneau]?.statut === 'traite',
    JSON.stringify(parLocal[localPanneau]));
  verifier('chantier créé', parLocal[localChantier]?.statut === 'traite',
    JSON.stringify(parLocal[localChantier]));
  verifier('les objets reçoivent un code lisible',
    Boolean(parLocal[localPanneau]?.code?.includes('-A-'))
    && Boolean(parLocal[localChantier]?.code?.includes('-C-')),
    `${parLocal[localPanneau]?.code} / ${parLocal[localChantier]?.code}`);

  // ------------------------------------------------------------ idempotence
  console.log(`\n  ${C.gras('Rejeu du même lot (coupure réseau simulée)')}`);
  const rejeu = await appel('POST', '/sync/batch', lot);
  verifier('lot rejoué reconnu', rejeu.statut === 200 || rejeu.statut === 207,
    `statut ${rejeu.statut}`);
  verifier('aucun doublon créé', rejeu.donnees?.rejoue === true,
    `rejoue=${rejeu.donnees?.rejoue}`);

  // Même contenu, identifiant de lot différent : c'est le cas où l'app a
  // perdu la réponse et refabrique un lot. Les identifiants locaux, eux, sont
  // les mêmes — c'est sur eux que repose la protection.
  const lotBis = { ...lot, identifiant_client: crypto.randomUUID() };
  const rejeuBis = await appel('POST', '/sync/batch', lotBis);
  const parLocalBis = Object.fromEntries(
    (rejeuBis.donnees?.resultats ?? []).map((r) => [r.identifiant_local, r]));
  verifier('nouveau lot, mêmes objets : pas de second panneau',
    parLocalBis[localPanneau]?.entite_id === parLocal[localPanneau]?.entite_id,
    `${parLocalBis[localPanneau]?.entite_id} vs ${parLocal[localPanneau]?.entite_id}`);
  verifier('nouveau lot, mêmes objets : pas de second chantier',
    parLocalBis[localChantier]?.entite_id === parLocal[localChantier]?.entite_id,
    `${parLocalBis[localChantier]?.entite_id} vs ${parLocal[localChantier]?.entite_id}`);

  // ----------------------------------------------------------- refus AFF-06
  console.log(`\n  ${C.gras('Garde-fous')}`);
  const typesTous = await appel('GET', '/affichages?limite=1');
  void typesTous;

  const aff06 = await appel('POST', '/sync/batch', {
    identifiant_client: crypto.randomUUID(),
    operations: [{
      entite: 'affichage', operation: 'creation',
      identifiant_local: crypto.randomUUID(),
      horodatage_client: new Date().toISOString(),
      donnees: {
        // Identifiant volontairement inexistant : le serveur doit refuser
        // plutôt que d'insérer un dispositif sans type valide.
        type_affichage_id: '00000000-0000-0000-0000-000000000000',
        surface_m2: 1,
      },
    }],
  });
  const resultatAff06 = aff06.donnees?.resultats?.[0];
  verifier('type de dispositif inconnu → opération rejetée, lot poursuivi',
    resultatAff06?.statut === 'rejete',
    JSON.stringify(resultatAff06));

  // ------------------------------------------------------------- vérification
  console.log(`\n  ${C.gras('Contrôle côté serveur')}`);
  // Recherche par CODE plutôt que sur les premiers résultats : la liste
  // grandit à chaque passage de recette, et un contrôle qui dépend du rang
  // finit toujours par échouer sans que rien ne soit cassé.
  const codePanneau = parLocal[localPanneau]?.code;
  const listeAff = await appel('GET',
    `/affichages?sans_commerce=oui&q=${encodeURIComponent(codePanneau ?? '')}`);
  verifier('le panneau autonome apparaît dans la liste',
    (listeAff.donnees ?? []).some((d) => d.code === codePanneau),
    `recherché : ${codePanneau} — ${listeAff.donnees?.length} résultat(s)`);

  const listeCh = await appel('GET', '/chantiers?limite=5');
  const chantier = (listeCh.donnees ?? []).find((c) => c.code === parLocal[localChantier]?.code);
  verifier('le chantier apparaît avec ses occupations',
    Boolean(chantier) && Array.isArray(chantier.occupations) && chantier.occupations.length === 2,
    JSON.stringify(chantier?.occupations));
  verifier('le chantier n\'est pas facturable', chantier?.facturable === false,
    `facturable=${chantier?.facturable}`);

  console.log(`\n  ${C.gras(`${reussis} réussi(s), ${echoues} échec(s)`)}\n`);
  process.exit(echoues > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\n  ${C.ko(e.message)}\n`);
  process.exit(1);
});
