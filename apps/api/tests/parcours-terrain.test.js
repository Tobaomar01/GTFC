'use strict';
/**
 * Le parcours du terrain, à travers l'API réelle.
 *
 * Les autres tests éprouvent la base, ou une fonction isolée. Celui-ci part de
 * ce que fait un agent — il synchronise une fiche relevée hors ligne — et
 * suit ce qu'elle devient. C'est le seul angle sous lequel se voit un défaut
 * de CHAÎNAGE : chaque maillon peut être juste et la chaîne rompue.
 *
 * Il en a trouvé un. Le serveur génère le jeton QR dans la transaction de
 * synchronisation, et le téléphone l'attend (`commerces.repo.confirmerCreation`)
 * pour poser le sticker sur la devanture. Entre les deux, la liste blanche qui
 * compose la réponse ne le recopiait pas : tous les commerces recensés hors
 * ligne — c'est-à-dire la quasi-totalité — repartaient sans QR imprimable.
 * Aucune ligne n'était fausse ; c'est le passage de relais qui manquait.
 *
 * Le test travaille sur la base de recette et ARCHIVE ce qu'il crée plutôt que
 * de le supprimer : une écriture ne disparaît pas, c'est le premier principe
 * du projet. Il ne touche à aucun paiement.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const app = require('../src/app');

// Marque unique par exécution : le serveur déduplique les identifiants de
// synchronisation — c'est précisément ce qu'on veut éprouver — donc rejouer la
// même marque ferait passer le test pour de mauvaises raisons.
const SERIE = String(Date.now()).slice(-8);
const MARQUE = `ZZ-TEST-${SERIE}`;
const TEL = `+2217700${SERIE.slice(-5)}`;
const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const AGENT = '+221700000011';

let serveur; let base; let jeton; let point;
const creations = { commerces: [], redevables: [] };

async function appel(chemin, { methode = 'GET', corps = null, auth = true } = {}) {
  const reponse = await fetch(base + chemin, {
    method: methode,
    headers: {
      'content-type': 'application/json',
      ...(auth && jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await reponse.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* réponse non JSON */ }
  return { statut: reponse.status, json, texte };
}

/** Un lot de synchronisation, tel que l'envoie le téléphone. */
function lot(identifiantLocal, donnees) {
  return {
    identifiant_client: `test-parcours-${identifiantLocal}`,
    appareil_id: 'test-parcours',
    version_app: '0.0.0-test',
    operations: [{
      entite: 'commerce',
      operation: 'creation',
      identifiant_local: identifiantLocal,
      horodatage_client: new Date().toISOString(),
      donnees,
    }],
  };
}

async function categorie() {
  const c = await un(`SELECT id FROM ref.categorie_commerce
                       WHERE actif AND archive_le IS NULL ORDER BY code LIMIT 1`);
  return c.id;
}

/** Synchronise une fiche et retient ce qu'elle a créé, pour l'archiver ensuite. */
async function recenser(suffixe, donnees) {
  const reponse = await appel('/sync/batch', {
    methode: 'POST',
    corps: lot(`${MARQUE}-${suffixe}`, {
      categorie_id: await categorie(), ...point, ...donnees,
    }),
  });
  assert.equal(reponse.statut, 200, reponse.texte);
  const op = reponse.json.donnees.resultats[0];
  assert.equal(op.statut, 'traite', JSON.stringify(op));
  if (op.entite_id) creations.commerces.push(op.entite_id);
  return op;
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;

  // Résidus d'exécutions interrompues : sans quoi les comptages porteraient
  // sur des fiches d'hier.
  await q(`UPDATE app.commerce
              SET archive_le = now(), statut = 'archive',
                  motif_archivage = 'fiche de test automatisé'
            WHERE enseigne LIKE 'ZZ-TEST-%' AND archive_le IS NULL`);

  const centre = await un(
    `SELECT round(ST_X(ST_Centroid(geom))::numeric, 5) AS lon,
            round(ST_Y(ST_Centroid(geom))::numeric, 5) AS lat
       FROM app.commune LIMIT 1`);
  point = { longitude: Number(centre.lon), latitude: Number(centre.lat), precision_gps_m: 6 };

  const connexion = await appel('/auth/login', {
    methode: 'POST', auth: false, corps: { telephone: AGENT, mot_de_passe: MDP },
  });
  assert.equal(connexion.statut, 200, `connexion agent refusée : ${connexion.texte}`);
  jeton = connexion.json.donnees.jeton_acces;
  assert.ok(jeton, `jeton absent de la réponse : ${connexion.texte}`);
});

test.after(async () => {
  // On archive, on ne supprime pas.
  for (const id of creations.commerces) {
    await q(`UPDATE app.commerce
                SET archive_le = now(), statut = 'archive',
                    motif_archivage = 'fiche de test automatisé'
              WHERE id = $1 AND archive_le IS NULL`, [id]);
  }
  for (const id of creations.redevables) {
    await q(`UPDATE app.redevable
                SET archive_le = now(), motif_archivage = 'fiche de test automatisé'
              WHERE id = $1 AND archive_le IS NULL
                AND NOT EXISTS (SELECT 1 FROM app.avis_imposition a
                                 WHERE a.redevable_id = $1)`, [id]);
  }
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('une fiche synchronisée repart avec son QR imprimable', async () => {
  const op = await recenser('1', {
    enseigne: `${MARQUE} Boutique Un`,
    gerant_nom: 'Diallo', gerant_prenom: 'Awa', gerant_telephone: TEL,
  });

  // Le téléphone stocke ce jeton et imprime le sticker hors ligne. Sans lui,
  // l'agent repart sans QR à coller et devra repasser.
  assert.ok(op.qr_jeton, 'le jeton QR n\'est pas revenu au téléphone');

  const qr = await un(
    'SELECT commerce_id, actif FROM app.qr_code WHERE jeton = $1', [op.qr_jeton]);
  assert.ok(qr, 'le jeton renvoyé ne correspond à aucun QR en base');
  assert.equal(qr.commerce_id, op.entite_id);
  assert.equal(qr.actif, true);
});

test('la fiche est rattachée à un redevable, donc facturable', async () => {
  const commerce = await un(
    `SELECT id, code, redevable_id FROM app.commerce
      WHERE enseigne = $1 AND archive_le IS NULL`, [`${MARQUE} Boutique Un`]);
  assert.ok(commerce, 'commerce de test introuvable');

  // La génération des avis parcourt les REDEVABLES et n'atteint un commerce
  // que par ce lien. Un commerce sans redevable serait recensé, géolocalisé,
  // taxé — et jamais facturé.
  assert.ok(commerce.redevable_id, `${commerce.code} ne serait jamais facturé`);
  creations.redevables.push(commerce.redevable_id);

  const redevable = await un(
    'SELECT nom, telephone, origine FROM app.redevable WHERE id = $1',
    [commerce.redevable_id]);
  assert.equal(redevable.nom, 'Diallo');
  assert.equal(redevable.telephone, TEL);
  assert.equal(redevable.origine, 'terrain');
});

test('rejouer le même lot ne crée pas de doublon', async () => {
  // C'est le cas ordinaire : coupure réseau en cours d'envoi, le téléphone
  // réémet le lot au retour du signal.
  const rejeu = await appel('/sync/batch', {
    methode: 'POST',
    corps: lot(`${MARQUE}-1`, {
      categorie_id: await categorie(), ...point,
      enseigne: `${MARQUE} Boutique Un`, gerant_nom: 'Diallo', gerant_telephone: TEL,
    }),
  });
  assert.equal(rejeu.statut, 200, rejeu.texte);

  const n = await un(`SELECT count(*)::int AS n FROM app.commerce
                       WHERE enseigne = $1 AND archive_le IS NULL`,
  [`${MARQUE} Boutique Un`]);
  assert.equal(n.n, 1, 'le rejeu a créé un second commerce');
});

test('deux boutiques du même numéro n\'ont qu\'un redevable', async () => {
  await recenser('2', {
    enseigne: `${MARQUE} Boutique Deux`,
    gerant_nom: 'Diallo', gerant_prenom: 'Awa', gerant_telephone: TEL,
  });

  const distincts = await q(
    `SELECT DISTINCT redevable_id FROM app.commerce
      WHERE enseigne IN ($1, $2) AND archive_le IS NULL`,
    [`${MARQUE} Boutique Un`, `${MARQUE} Boutique Deux`]);

  // Deux redevables, ce serait deux factures pour la même personne, alors que
  // la règle est une facture consolidée unique par redevable.
  assert.equal(distincts.length, 1,
    'le même commerçant a été dédoublé : il recevrait deux factures');
});

test('une fiche sans gérant produit un redevable non joignable', async () => {
  // Boutique fermée, gérant absent : l'agent recense la devanture et repart.
  const op = await recenser('3', { enseigne: `${MARQUE} Boutique Fermee` });

  const commerce = await un(
    'SELECT redevable_id FROM app.commerce WHERE id = $1', [op.entite_id]);
  creations.redevables.push(commerce.redevable_id);

  const redevable = await un(
    'SELECT nom, telephone FROM app.redevable WHERE id = $1', [commerce.redevable_id]);

  // À défaut de gérant, l'enseigne fait office de désignation : un dossier
  // sans nom serait introuvable au guichet.
  assert.equal(redevable.nom, `${MARQUE} Boutique Fermee`);

  // Mais SANS NUMÉRO. Le pilote n'a qu'un canal de recouvrement : le SMS
  // mensuel portant le lien Wave. Ce redevable est donc recensé, imposable, et
  // hors d'atteinte : sa fiche doit être complétée au second passage avant
  // toute émission d'avis.
  assert.equal(redevable.telephone, null);
});

test('les taxes rattachées couvrent la période : l\'avis ne sera pas vide', async () => {
  const commerce = await un(
    `SELECT id, code FROM app.commerce
      WHERE enseigne = $1 AND archive_le IS NULL`, [`${MARQUE} Boutique Un`]);

  const couvrantes = await un(`
    SELECT count(*)::int AS n
      FROM app.commerce_taxe ct
      CROSS JOIN LATERAL (SELECT date_debut, date_fin FROM app.periode_fiscale
                           WHERE NOT close ORDER BY date_debut DESC LIMIT 1) p
     WHERE ct.commerce_id = $1 AND ct.actif
       AND ct.periode && daterange(p.date_debut, p.date_fin, '[]')`, [commerce.id]);

  // La patente est inconditionnelle : tout commerce la doit, et son
  // rattachement est automatique. Zéro ici signifierait un avis à zéro franc.
  assert.ok(couvrantes.n >= 1,
    `aucune taxe ne couvre la période pour ${commerce.code} : son avis serait vide`);
});
