'use strict';
/**
 * Un conflit tranché par la mairie doit redescendre sur le téléphone.
 *
 * CE QUI A ÉTÉ CONSTATÉ le 09/09/2026, en suivant le chemin d'un conflit de
 * bout en bout.
 *
 * Le téléphone marque l'opération « conflit » et ne la rejoue plus — c'est
 * juste, il ne doit rien écraser. Mais il n'avait AUCUN moyen d'apprendre la
 * décision du superviseur : le client n'appelle pas /sync/conflits, qui est
 * d'ailleurs réservé au rôle superviseur.
 *
 * Le conflit était donc une impasse, avec trois conséquences durables :
 *
 *   - la fiche restait marquée « modifiée localement », donc sautée par la
 *     fusion des données du serveur : l'agent voyait un solde et un statut
 *     fiscal figés au jour du conflit, pour toujours ;
 *   - la mention « N élément(s) à examiner » ne s'éteignait jamais, et un
 *     avertissement qui ne s'éteint pas cesse d'être lu ;
 *   - la décision du superviseur, prise et tracée en base, n'avait aucun effet
 *     visible sur le terrain.
 *
 * Le paquet hors ligne porte désormais `conflits_resolus`. Ce test vérifie
 * qu'il les porte, et — ce qui compte autant — qu'il ne porte QUE ceux de
 * l'agent qui demande.
 *
 * Il fabrique son propre lot et sa propre opération, et les supprime ensuite :
 * ce sont des traces techniques, pas des écritures métier.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const app = require('../src/app');

const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const AGENT = '+221700000011';
const AUTRE_AGENT = '+221700000012';
const MARQUE = `ZZ-CONFLIT-${String(Date.now()).slice(-8)}`;

let serveur; let base;
const lotsCrees = [];

async function connexion(telephone) {
  const reponse = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ telephone, mot_de_passe: MDP }),
  });
  const json = await reponse.json();
  assert.equal(reponse.status, 200, JSON.stringify(json));
  return json.donnees.jeton_acces;
}

async function paquet(jeton) {
  const reponse = await fetch(`${base}/sync/paquet`, {
    headers: { authorization: `Bearer ${jeton}` },
  });
  const json = await reponse.json();
  assert.equal(reponse.status, 200, JSON.stringify(json));
  return json.donnees;
}

/**
 * Pose un conflit DÉJÀ RÉSOLU pour un agent donné, comme le ferait la mairie
 * après avoir tranché depuis le tableau de bord.
 */
async function conflitResolu(telephoneAgent, marque, resolution) {
  const agent = await un(
    'SELECT id, commune_id FROM app.utilisateur WHERE telephone = $1', [telephoneAgent]);
  assert.ok(agent, `l'agent ${telephoneAgent} doit exister dans le jeu de démonstration`);

  const lot = await un(`
    INSERT INTO app.sync_lot (commune_id, agent_id, identifiant_client, appareil_id)
    VALUES ($1, $2, $3, 'test-conflit')
    RETURNING id`, [agent.commune_id, agent.id, `${marque}-lot`]);
  lotsCrees.push(lot.id);

  await q(`
    INSERT INTO app.sync_operation (
      commune_id, lot_id, ordre, identifiant_local, entite, operation, donnees,
      horodatage_client, statut, resolution, resolu_le, resolu_par, message)
    VALUES ($1, $2, 1, $3, 'commerce', 'modification', '{}'::jsonb,
            now(), 'traite', $4, now(), $5, 'tranché pour le test')`,
  [agent.commune_id, lot.id, marque, resolution, agent.id]);

  return agent;
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  for (const id of lotsCrees) {
    await q('DELETE FROM app.sync_operation WHERE lot_id = $1', [id]);
    await q('DELETE FROM app.sync_lot WHERE id = $1', [id]);
  }
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('le paquet porte les conflits que la mairie a tranchés', async () => {
  await conflitResolu(AGENT, `${MARQUE}-A`, 'client');

  const jeton = await connexion(AGENT);
  const p = await paquet(jeton);

  assert.ok(Array.isArray(p.conflits_resolus),
    'le paquet ne porte pas de liste conflits_resolus : le téléphone n\'a aucun moyen '
    + 'd\'apprendre la décision du superviseur');

  const trouve = p.conflits_resolus.find((c) => c.identifiant_local === `${MARQUE}-A`);
  assert.ok(trouve, 'le conflit tranché ne redescend pas : la fiche restera gelée sur le téléphone');
  assert.equal(trouve.resolution, 'client');
  assert.equal(trouve.entite, 'commerce');
  assert.ok(trouve.resolu_le, 'sans la date, le téléphone ne peut pas ordonner les décisions');
});

test('un agent ne reçoit PAS les conflits d\'un autre', async () => {
  // Même commune, autre agent. Le paquet est une donnée de terrain : il ne doit
  // pas répandre les décisions prises sur le travail d'un collègue.
  await conflitResolu(AUTRE_AGENT, `${MARQUE}-B`, 'serveur');

  const jeton = await connexion(AGENT);
  const p = await paquet(jeton);

  const fuite = (p.conflits_resolus ?? []).find((c) => c.identifiant_local === `${MARQUE}-B`);
  assert.equal(fuite, undefined,
    'le paquet d\'un agent contient le conflit d\'un autre agent');

  // Et l'agent concerné, lui, le reçoit bien : sans cette moitié, le test
  // passerait aussi sur une liste toujours vide.
  const jetonAutre = await connexion(AUTRE_AGENT);
  const pAutre = await paquet(jetonAutre);
  assert.ok((pAutre.conflits_resolus ?? []).some((c) => c.identifiant_local === `${MARQUE}-B`),
    'l\'agent concerné ne reçoit pas son propre conflit tranché');
});
