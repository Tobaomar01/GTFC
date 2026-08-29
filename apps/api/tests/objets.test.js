'use strict';
/**
 * Dispositifs d'affichage et chantiers — les objets taxables qui ne sont pas
 * des commerces.
 *
 * Deux de leurs routes étaient rompues de la même façon que l'instruction
 * d'une contestation : un paramètre que PostgreSQL ne pouvait pas typer, donc
 * une erreur 500 à CHAQUE appel. Déposer un panneau publicitaire et constater
 * l'avancement d'un chantier n'ont jamais fonctionné.
 *
 * Le défaut est invisible à la lecture — la requête est correcte en SQL, elle
 * ne l'est pas en SQL PRÉPARÉ, où le type doit se déduire du contexte. Seul un
 * appel réel le montre.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const app = require('../src/app');

const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const AGENT = '+221700000011';

let serveur; let base; let jeton;

async function appel(chemin, { methode = 'GET', corps = null } = {}) {
  const r = await fetch(base + chemin, {
    method: methode,
    headers: {
      'content-type': 'application/json',
      ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* non JSON */ }
  return { statut: r.status, json, texte };
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
  const c = await appel('/auth/login', {
    methode: 'POST', corps: { telephone: AGENT, mot_de_passe: MDP },
  });
  assert.equal(c.statut, 200, c.texte);
  jeton = c.json.donnees.jeton_acces;
});

test.after(async () => {
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('déposer un dispositif d\'affichage, sans note', async () => {
  // SANS note : c'est le cas ordinaire, et c'est celui qui échouait. Le
  // paramètre valait null, et PostgreSQL refusait la requête entière.
  const avant = await un(`
    SELECT id, code FROM app.dispositif_affichage
     WHERE actif AND archive_le IS NULL LIMIT 1`);
  assert.ok(avant, 'il faut un dispositif actif pour éprouver le dépôt');

  const r = await appel(`/affichages/${avant.id}/deposer`, {
    methode: 'POST',
    corps: { date_depose: new Date().toISOString().slice(0, 10) },
  });
  assert.equal(r.statut, 200, `le dépôt a échoué : ${r.texte.slice(0, 200)}`);
  assert.equal(r.json.donnees.actif, false);

  // On remet en place : le jeu de démonstration doit rester utilisable.
  await q(`UPDATE app.dispositif_affichage
              SET actif = true, date_depose = NULL WHERE id = $1`, [avant.id]);
});

test('constater l\'avancement d\'un chantier, sans note', async () => {
  const chantier = await un(`
    SELECT id, code, statut, surface_m2 FROM app.chantier
     WHERE archive_le IS NULL LIMIT 1`);
  assert.ok(chantier, 'il faut un chantier pour éprouver le constat');

  const r = await appel(`/chantiers/${chantier.id}/constat`, {
    methode: 'POST', corps: { statut: 'en_cours' },
  });
  assert.equal(r.statut, 200, `le constat a échoué : ${r.texte.slice(0, 200)}`);

  await q('UPDATE app.chantier SET statut = $2 WHERE id = $1',
    [chantier.id, chantier.statut]);
});

test('une note fournie est bien ajoutée à la suite des précédentes', async () => {
  // L'autre moitié du contrat : le transtypage ne doit pas avoir changé le
  // comportement quand la note EST là.
  const chantier = await un(
    'SELECT id, statut, notes FROM app.chantier WHERE archive_le IS NULL LIMIT 1');
  const marque = `ZZ-TEST-${Date.now()}`;

  const r = await appel(`/chantiers/${chantier.id}/constat`, {
    methode: 'POST', corps: { statut: 'en_cours', notes: marque },
  });
  assert.equal(r.statut, 200, r.texte);

  const apres = await un('SELECT notes FROM app.chantier WHERE id = $1', [chantier.id]);
  assert.match(apres.notes ?? '', new RegExp(marque));
  if (chantier.notes) {
    assert.match(apres.notes, new RegExp(chantier.notes.split('\n')[0].slice(0, 20)),
      'les notes précédentes ont été écrasées au lieu d\'être complétées');
  }

  await q('UPDATE app.chantier SET notes = $2, statut = $3 WHERE id = $1',
    [chantier.id, chantier.notes, chantier.statut]);
});

test('un chantier reste non facturable pendant le pilote', async () => {
  const r = await un(
    'SELECT count(*)::int AS n FROM app.chantier WHERE facturable AND archive_le IS NULL');
  assert.equal(r.n, 0,
    'le chantier est recensé et redevable de la TODP, mais n\'est pas facturé durant le pilote');
});
