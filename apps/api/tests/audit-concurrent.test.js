'use strict';
/**
 * Le journal d'audit sous écritures simultanées.
 *
 * Le chaînage lisait la dernière empreinte puis écrivait la suivante, sans
 * rien entre les deux. Deux écritures séparées de cinq millisecondes se sont
 * accrochées au même parent, et la chaîne a paru rompue.
 *
 * Le symptôme est bénin, la conséquence ne l'est pas. Sur le terrain plusieurs
 * agents synchronisent en même temps : la rupture serait quotidienne, pour des
 * raisons parfaitement innocentes. Or une rupture est censée signifier une
 * altération. Un signal qui se déclenche tous les jours sans raison n'est plus
 * un signal — celui qui le surveille cesse de le regarder, et c'est le jour
 * d'une vraie altération que personne ne verra rien.
 *
 * Ce test PROVOQUE la condition au lieu de l'attendre : il envoie plusieurs
 * recensements de front. Sans le verrou de la migration 0055, il échoue.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const app = require('../src/app');

const SERIE = String(Date.now()).slice(-8);
const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const AGENT = '+221700000011';
const SIMULTANEES = 8;

let serveur; let base; let jeton; let point; let categorieId;

async function appel(chemin, { methode = 'GET', corps = null } = {}) {
  const r = await fetch(base + chemin, {
    method: methode,
    headers: {
      'content-type': 'application/json',
      ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { statut: r.status, texte: await r.text() };
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;

  const centre = await un(
    `SELECT round(ST_X(ST_Centroid(geom))::numeric, 5) AS lon,
            round(ST_Y(ST_Centroid(geom))::numeric, 5) AS lat
       FROM app.commune LIMIT 1`);
  point = { longitude: Number(centre.lon), latitude: Number(centre.lat) };

  const cat = await un(`SELECT id FROM ref.categorie_commerce
                         WHERE actif AND archive_le IS NULL ORDER BY code LIMIT 1`);
  categorieId = cat.id;

  const c = await appel('/auth/login', {
    methode: 'POST', corps: { telephone: AGENT, mot_de_passe: MDP },
  });
  assert.equal(c.statut, 200, c.texte);
  jeton = JSON.parse(c.texte).donnees.jeton_acces;
});

test.after(async () => {
  await q(`UPDATE app.commerce
              SET archive_le = now(), statut = 'archive',
                  motif_archivage = 'fiche de test automatisé'
            WHERE enseigne LIKE $1 AND archive_le IS NULL`, [`ZZ-CONC-${SERIE}%`]);
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('des recensements simultanés ne rompent pas la chaîne d\'audit', async () => {
  const avant = await q('SELECT * FROM audit.verifier_chaine()');
  assert.equal(avant.length, 0,
    `la chaîne était déjà rompue avant le test : ${JSON.stringify(avant[0])}`);

  // De front, sans attendre les unes les autres : c'est la situation d'une
  // équipe qui synchronise en fin de tournée.
  const envois = Array.from({ length: SIMULTANEES }, (_, i) => appel('/sync/batch', {
    methode: 'POST',
    corps: {
      identifiant_client: `test-concurrence-${SERIE}-${i}`,
      appareil_id: 'test-concurrence',
      operations: [{
        entite: 'commerce',
        operation: 'creation',
        identifiant_local: `ZZ-CONC-${SERIE}-${i}`,
        horodatage_client: new Date().toISOString(),
        donnees: {
          categorie_id: categorieId,
          enseigne: `ZZ-CONC-${SERIE} Boutique ${i}`,
          gerant_nom: 'Simultané',
          gerant_telephone: `+22177${String(SERIE).slice(-6)}`,
          ...point,
        },
      }],
    },
  }));

  const reponses = await Promise.all(envois);
  const acceptes = reponses.filter((r) => r.statut === 200).length;
  assert.ok(acceptes >= SIMULTANEES - 1,
    `${acceptes}/${SIMULTANEES} lots acceptés — le reste : `
    + reponses.filter((r) => r.statut !== 200).map((r) => r.texte).join(' | '));

  const apres = await q('SELECT * FROM audit.verifier_chaine()');
  assert.equal(apres.length, 0,
    'la chaîne est rompue après des écritures simultanées : '
    + JSON.stringify(apres[0]));
});

test('aucune entrée du journal ne partage son parent avec une autre', async () => {
  // Formulation directe du défaut : deux entrées accrochées à la même
  // empreinte précédente sont un dédoublement de la chaîne, que la
  // vérification séquentielle ne signale qu'une fois.
  const doublons = await q(`
    SELECT empreinte_precedente, count(*)::int AS n
      FROM audit.journal
     WHERE empreinte_precedente IS NOT NULL
     GROUP BY empreinte_precedente
    HAVING count(*) > 1`);
  assert.equal(doublons.length, 0,
    `${doublons.length} empreinte(s) servant de parent à plusieurs entrées`);
});
