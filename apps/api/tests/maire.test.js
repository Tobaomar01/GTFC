'use strict';
/**
 * Le maire, côté municipalité.
 *
 * Deux organisations travaillent sur ce dispositif, et une seule était
 * représentée dans les rôles. Côté exploitant, le chef de projet détient les
 * décisions dérogatoires. Côté municipalité, le maire constate la recette qui
 * lui revient — sans dépendre d'un compte prêté par l'exploitant, ce qui est
 * la situation qu'il fallait éviter.
 *
 * Il consulte, et rien d'autre. La restriction n'est pas posée route par
 * route : elle est vérifiée à l'intérieur de l'authentification, donc sur
 * TOUTE route protégée, y compris celles qui n'existent pas encore. Un garde
 * oublié sur une route neuve rouvrirait la porte en silence, et personne ne
 * s'en apercevrait avant qu'une écriture n'ait eu lieu.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { un, fermer } = require('./aide');

const app = require('../src/app');

const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const MAIRE = '+221700000005';

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
  return { statut: r.status, texte: await r.text() };
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;

  const c = await appel('/auth/login', {
    methode: 'POST', corps: { telephone: MAIRE, mot_de_passe: MDP },
  });
  assert.equal(c.statut, 200, `connexion du maire refusée : ${c.texte}`);
  jeton = JSON.parse(c.texte).donnees.jeton_acces;
});

test.after(async () => {
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('un compte maire existe et se connecte', async () => {
  const compte = await un(
    "SELECT telephone, commune_id FROM app.utilisateur WHERE role = 'maire' LIMIT 1");
  assert.ok(compte, 'aucun maire : la municipalité dépendrait d\'un compte prêté');
  assert.ok(compte.commune_id, 'le maire est rattaché à sa commune');
  assert.ok(jeton);
});

test('le maire voit la recette de sa commune', async () => {
  for (const chemin of ['/stats/tableau-bord', '/commerces?limite=5', '/avis?limite=5',
    '/paiements?limite=5', '/stats/agents', '/rues']) {
    const r = await appel(chemin);
    assert.ok(r.statut === 200 || r.statut === 404,
      `${chemin} : ${r.statut} — le maire doit pouvoir consulter (${r.texte.slice(0, 120)})`);
  }
});

test('le maire ne peut rien écrire, sur aucune route', async () => {
  // Un échantillon volontairement large : recensement, encaissement,
  // paramétrage, comptes. Ce ne sont pas des refus route par route mais un
  // seul refus, prononcé à l'authentification.
  const ecritures = [
    ['POST', '/commerces', { enseigne: 'ZZ', categorie_id: null }],
    ['POST', '/paiements', { commerce_id: null, montant: 1000 }],
    ['POST', '/agents', { nom: 'ZZ', prenom: 'ZZ', telephone: '+221779999999', role: 'agent', mot_de_passe_provisoire: 'MotDePasse2026!' }],
    ['POST', '/periodes', { annee: 2027 }],
    ['POST', '/sync/batch', { identifiant_client: 'maire-test', operations: [] }],
    ['PATCH', '/commerces/00000000-0000-0000-0000-000000000000', { enseigne: 'ZZ' }],
    ['DELETE', '/commerces/00000000-0000-0000-0000-000000000000', null],
  ];

  for (const [methode, chemin, corps] of ecritures) {
    const r = await appel(chemin, { methode, corps });
    assert.equal(r.statut, 403,
      `${methode} ${chemin} : attendu 403, obtenu ${r.statut} — `
      + `${r.texte.slice(0, 160)}`);
  }
});

test('le refus dit pourquoi, sans accuser', async () => {
  // Le maire n'est pas un intrus : le message doit expliquer un partage des
  // rôles, pas signaler une tentative.
  const r = await appel('/periodes', { methode: 'POST', corps: { annee: 2028 } });
  assert.equal(r.statut, 403);
  assert.match(JSON.parse(r.texte).erreur.message, /consultation seule/i);
});

test('le maire n\'accède pas au registre des dérogations', async () => {
  // Il relève de la municipalité ; les décisions dérogatoires relèvent de
  // l'exploitant, sous double vérification.
  const r = await appel('/derogations');
  assert.equal(r.statut, 403, `attendu 403, obtenu ${r.statut}`);
});
