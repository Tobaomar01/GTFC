#!/usr/bin/env node
/**
 * Recette du portail redevable, à travers le mandataire Next.js.
 *
 *   node scripts/recette-portail.js
 *
 * Ne teste PAS l'API directement : c'est le chemin réel du navigateur qui est
 * éprouvé — /api/portail/* → mandataire → API — parce que c'est là que se
 * joue le relais du cookie de session, et que c'est le maillon le plus
 * fragile de la chaîne.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CETTE RECETTE CHERCHE À PRENDRE EN DÉFAUT
 *
 *  · le jeton de session qui fuirait dans le corps d'une réponse, donc à
 *    portée du JavaScript de la page ;
 *  · un chemin forgé qui atteindrait /commerces avec un cookie de redevable ;
 *  · l'énumération des numéros : une réponse différente selon qu'un dossier
 *    existe ou non transformerait le portail en annuaire de la commune.
 * ─────────────────────────────────────────────────────────────────────────
 */

'use strict';

const PORTAIL = process.env.PORTAIL_URL || 'http://127.0.0.1:3000';
const API = process.env.API_URL || 'http://127.0.0.1:4000';
const COMMUNE = process.env.COMMUNE_SLUG || 'gtfc';
const IDENTIFIANT = process.env.RECETTE_TEL || '+221700000002';
const MOT_DE_PASSE = process.env.RECETTE_MDP || 'GtfcDemo2026!';

let cookie = null;
let reussis = 0;
let echoues = 0;

const C = {
  ok: (t) => `\x1b[32m✓\x1b[0m ${t}`,
  ko: (t) => `\x1b[31m✗\x1b[0m ${t}`,
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

function verifier(libelle, condition, detail = '') {
  if (condition) { console.log(`  ${C.ok(libelle)}`); reussis += 1; } else {
    console.log(`  ${C.ko(libelle)}`);
    if (detail) console.log(`      ${C.gris(String(detail).slice(0, 200))}`);
    echoues += 1;
  }
}

/** Appel du portail tel que le ferait le navigateur. */
async function portail(chemin, corps = null) {
  const r = await fetch(`${PORTAIL}/api/portail/${chemin}`, {
    method: corps ? 'POST' : 'GET',
    headers: {
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
    redirect: 'manual',
  });
  const brut = await r.text();
  let json = null;
  try { json = JSON.parse(brut); } catch { /* non JSON */ }

  const pose = r.headers.get('set-cookie');
  if (pose) {
    const paire = pose.split(';')[0];
    if (paire.startsWith('gtfc_portail=')) {
      cookie = paire.endsWith('=') ? null : paire;
    }
  }
  return {
    statut: r.status, json, brut, donnees: json?.donnees, entetes: r.headers,
  };
}

(async () => {
  console.log(`\n${C.gras('Recette — portail redevable')}   ${C.gris(PORTAIL)}\n`);

  // --- Préparer un redevable joignable ------------------------------------
  // Le portail exige un numéro VÉRIFIÉ : c'est tout l'objet du contrôle. On
  // fabrique donc le dossier via l'API, comme le ferait un agent.
  const co = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telephone: IDENTIFIANT, mot_de_passe: MOT_DE_PASSE }),
  });
  if (!co.ok) {
    console.log(`  ${C.ko('API injoignable — lancez la démonstration locale')}\n`);
    process.exit(1);
  }
  const session = await co.json();
  const jeton = session.donnees.jeton_acces ?? session.donnees.acces;

  const appelApi = async (methode, chemin, corps) => {
    const r = await fetch(`${API}${chemin}`, {
      method: methode,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jeton}` },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    return { statut: r.status, json: await r.json().catch(() => null) };
  };

  const tel = `+22178${String(Date.now()).slice(-8)}`;
  const creation = await appelApi('POST', '/redevables', {
    type_redevable: 'personne_physique', nom: 'Portail', prenom: 'Recette', telephone: tel,
  });
  if (creation.statut !== 201) {
    console.log(`  ${C.ko(`préparation impossible (${creation.statut})`)}\n`);
    process.exit(1);
  }
  const redevableId = creation.json.donnees.id;

  const envoiCode = await appelApi('POST', `/redevables/${redevableId}/telephone/code`);
  const codeVerif = envoiCode.json?.donnees?.code_simule;
  if (!codeVerif) {
    console.log(`  ${C.gris('Opérateur SMS raccordé : recette non automatisable.')}\n`);
    process.exit(0);
  }
  await appelApi('POST', `/redevables/${redevableId}/telephone/verifier`, { code: codeVerif });
  console.log(`  ${C.gris(`Redevable de recette prêt : ${tel}`)}\n`);

  // --- Le parcours -------------------------------------------------------
  console.log(`  ${C.gras('Connexion')}`);

  const inconnu = await portail('code', { commune: COMMUNE, telephone: '+221700000000' });
  const connu = await portail('code', { commune: COMMUNE, telephone: tel });

  verifier('numéro connu et numéro inconnu : même code de statut',
    inconnu.statut === connu.statut, `${inconnu.statut} vs ${connu.statut}`);
  verifier('numéro connu et numéro inconnu : même message',
    inconnu.donnees?.message === connu.donnees?.message,
    `"${inconnu.donnees?.message}" vs "${connu.donnees?.message}"`);

  const code = connu.donnees?.code_simule;
  verifier('code émis', Boolean(code), connu.brut.slice(0, 150));

  const mauvais = await portail('session', {
    commune: COMMUNE, telephone: tel, code: code === '000000' ? '111111' : '000000',
  });
  verifier('code faux refusé', mauvais.statut === 401, `statut ${mauvais.statut}`);

  const ouverture = await portail('session', { commune: COMMUNE, telephone: tel, code });
  verifier('session ouverte', ouverture.statut === 200 && ouverture.donnees?.connecte === true,
    `statut ${ouverture.statut} ${ouverture.brut.slice(0, 150)}`);

  verifier('le cookie de session est posé par le mandataire', Boolean(cookie),
    `cookie=${cookie}`);
  verifier('le cookie est httpOnly',
    /httponly/i.test(ouverture.entetes.get('set-cookie') ?? ''),
    ouverture.entetes.get('set-cookie'));
  verifier('le jeton n\'apparaît pas dans le corps de la réponse',
    !/jeton|token/i.test(JSON.stringify(ouverture.donnees ?? {})));

  // --- Le dossier --------------------------------------------------------
  console.log(`\n  ${C.gras('Dossier')}`);
  const dossier = await portail('dossier');
  verifier('dossier accessible', dossier.statut === 200 && Boolean(dossier.donnees?.redevable),
    `statut ${dossier.statut} ${dossier.brut.slice(0, 150)}`);
  verifier('le dossier est bien celui du redevable connecté',
    dossier.donnees?.redevable?.telephone === tel,
    `${dossier.donnees?.redevable?.telephone} vs ${tel}`);
  verifier('aucun avis au brouillon exposé',
    (dossier.donnees?.avis ?? []).every((a) => a.statut !== 'brouillon'));

  const motifs = await portail('motifs-contestation');
  verifier('motifs de contestation', motifs.statut === 200 && motifs.donnees?.length === 6,
    `${motifs.donnees?.length} motif(s)`);

  const contestation = await portail('contestations', {
    motif_id: motifs.donnees?.[0]?.id,
    description: 'Le montant ne correspond pas à la surface que j\'occupe réellement.',
  });
  verifier('dépôt d\'une contestation depuis le portail',
    contestation.statut === 201 && Boolean(contestation.donnees?.numero),
    `statut ${contestation.statut} ${contestation.brut.slice(0, 150)}`);

  // --- Cloisonnement -----------------------------------------------------
  console.log(`\n  ${C.gras('Cloisonnement')}`);

  const interdit = await portail('../commerces');
  verifier('chemin forgé vers /commerces refusé',
    interdit.statut === 403 || interdit.statut === 404,
    `statut ${interdit.statut}`);

  const changement = await portail('telephone', { nouveau_telephone: '+221770000001' });
  verifier('changement de numéro refusé depuis le portail',
    changement.statut === 403, `statut ${changement.statut}`);

  // --- Déconnexion -------------------------------------------------------
  console.log(`\n  ${C.gras('Déconnexion')}`);
  const deco = await portail('deconnexion', {});
  verifier('déconnexion acceptée', deco.statut === 200, `statut ${deco.statut}`);

  const apres = await portail('dossier');
  verifier('dossier inaccessible après déconnexion', apres.statut === 401,
    `statut ${apres.statut}`);

  console.log(`\n  ${C.gras(`${reussis} réussi(s), ${echoues} échec(s)`)}\n`);
  process.exit(echoues > 0 ? 1 : 0);
})().catch((e) => {
  console.error(`\n  ${C.ko(e.message)}\n`);
  process.exit(1);
});
