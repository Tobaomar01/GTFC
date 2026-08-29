'use strict';
/**
 * Le chef de projet et son registre, éprouvés par l'API.
 *
 * Le rôle existait en base depuis la migration 0043, l'API le gardait, le
 * registre du tableau de bord lui était réservé — et AUCUN chemin ne
 * permettait d'ouvrir un tel compte. Ni le script d'installation, ni la route
 * de création d'agent ne l'acceptaient. Sur une installation neuve, personne
 * ne pouvait donc accorder une exonération ni valider un montant forcé : le
 * mécanisme entier, explicitement demandé par le commanditaire, était
 * inaccessible.
 *
 * Rien n'était en panne. Chaque pièce fonctionnait ; il manquait la porte
 * d'entrée. C'est pourquoi ces tests passent par l'API et par la connexion
 * réelle, pas par le seul intergiciel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { un, fermer } = require('./aide');

const app = require('../src/app');

const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const CHEF_PROJET = '+221700000004';
const ADMIN = '+221700000002';
const AGENT = '+221700000011';

let serveur; let base;

async function appel(chemin, { methode = 'GET', corps = null, jeton = null } = {}) {
  const reponse = await fetch(base + chemin, {
    method: methode,
    headers: {
      'content-type': 'application/json',
      ...(jeton ? { authorization: `Bearer ${jeton}` } : {}),
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await reponse.text();
  let json = null;
  try { json = JSON.parse(texte); } catch { /* réponse non JSON */ }
  return { statut: reponse.status, json, texte };
}

async function connecter(telephone) {
  const r = await appel('/auth/login', {
    methode: 'POST', corps: { telephone, mot_de_passe: MDP },
  });
  assert.equal(r.statut, 200, `connexion ${telephone} refusée : ${r.texte}`);
  return r.json.donnees.jeton_acces;
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('un compte chef de projet existe et peut se connecter', async () => {
  const compte = await un(
    "SELECT telephone, actif FROM app.utilisateur WHERE role = 'chef_projet' LIMIT 1");
  assert.ok(compte, 'aucun chef de projet : le registre des dérogations est inaccessible');

  const jeton = await connecter(CHEF_PROJET);
  assert.ok(jeton);
});

test('le chef de projet accède au registre des dérogations', async () => {
  const jeton = await connecter(CHEF_PROJET);
  const r = await appel('/derogations', { jeton });
  assert.equal(r.statut, 200, r.texte);
});

test('le chef de projet saisit, mais ne valide pas', async () => {
  // La double vérification traverse les deux organisations : l'exploitant
  // instruit, la municipalité conclut. Laisser le chef de projet valider sa
  // propre saisie — ou celle d'un collègue — rendrait à l'exploitant un droit
  // sur les échéances que la constitution lui refuse (principe III).
  const jeton = await connecter(CHEF_PROJET);
  const r = await appel('/derogations/00000000-0000-0000-0000-000000000000/validation',
    { methode: 'POST', jeton });
  assert.equal(r.statut, 403,
    `le chef de projet ne doit pas valider : ${r.statut} — ${r.texte.slice(0, 160)}`);

  const e = await appel('/exonerations/00000000-0000-0000-0000-000000000000/validation',
    { methode: 'POST', jeton });
  assert.equal(e.statut, 403, `exonération : ${e.statut} — ${e.texte.slice(0, 160)}`);
});

test('l\'administrateur de la commune n\'y accède pas', async () => {
  // Il détient le barème, pas les dérogations. Réunir les deux permettrait de
  // fixer une dette puis de la remettre.
  const jeton = await connecter(ADMIN);
  const r = await appel('/derogations', { jeton });
  assert.equal(r.statut, 403, `attendu 403, obtenu ${r.statut} : ${r.texte}`);
});

test('l\'agent de terrain n\'y accède pas non plus', async () => {
  const jeton = await connecter(AGENT);
  const r = await appel('/derogations', { jeton });
  assert.equal(r.statut, 403, `attendu 403, obtenu ${r.statut} : ${r.texte}`);
});

test('l\'administrateur ne peut pas nommer un chef de projet', async () => {
  // Sans cette garde il contournerait la séparation en s'attribuant le rôle,
  // ou en le donnant à un compte qu'il contrôle.
  const jeton = await connecter(ADMIN);
  const r = await appel('/agents', {
    methode: 'POST', jeton,
    corps: {
      nom: 'ZZ-TEST', prenom: 'Nomination',
      telephone: '+221779999901',
      role: 'chef_projet',
      mot_de_passe_provisoire: 'MotDePasse2026!',
    },
  });
  assert.equal(r.statut, 403, `attendu 403, obtenu ${r.statut} : ${r.texte}`);

  const cree = await un(
    "SELECT id FROM app.utilisateur WHERE telephone = '+221779999901'");
  assert.equal(cree, undefined, 'le compte n\'aurait pas dû être créé');
});

test('l\'administrateur ne peut pas non plus promouvoir un compte existant', async () => {
  // La garde de la création ne suffit pas : sans la même à la modification,
  // il suffisait de créer un agent puis de l'élever.
  const jeton = await connecter(ADMIN);
  const agent = await un(
    "SELECT id, role FROM app.utilisateur WHERE telephone = $1", [AGENT]);

  const r = await appel(`/agents/${agent.id}`, {
    methode: 'PATCH', jeton, corps: { role: 'chef_projet' },
  });
  assert.equal(r.statut, 403, `attendu 403, obtenu ${r.statut} : ${r.texte}`);

  const apres = await un('SELECT role FROM app.utilisateur WHERE id = $1', [agent.id]);
  assert.equal(apres.role, agent.role, 'le rôle a été modifié malgré le refus');
});

test('le chef de projet voit l\'ensemble du dispositif', async () => {
  // Il conduit le déploiement : un responsable à qui les écrans sont fermés
  // ne peut pas soutenir ce qu'il déploie.
  const jeton = await connecter(CHEF_PROJET);
  for (const chemin of ['/stats/tableau-bord', '/commerces?limite=5', '/avis?limite=5',
    '/paiements?limite=5', '/stats/agents', '/agents', '/rues', '/taxes/baremes',
    '/periodes', '/audit?limite=5']) {
    const r = await appel(chemin, { jeton });
    assert.ok(r.statut === 200 || r.statut === 404,
      `${chemin} : ${r.statut} — ${r.texte.slice(0, 140)}`);
  }
});

test('le chef de projet n\'écrit ni le barème ni les échéances', async () => {
  // La constitution interdit au personnel de l'exploitant technique du
  // partenariat tout droit sur les échéances et sur le barème (principe III).
  // Voir tout n'est pas pouvoir tout.
  const jeton = await connecter(CHEF_PROJET);
  const interdits = [
    ['POST', '/taxes/baremes', { code: 'zz' }],
    ['POST', '/periodes', { annee: 2029 }],
    ['POST', '/paiements', { commerce_id: null, montant: 1000 }],
    ['POST', '/commerces', { enseigne: 'ZZ' }],
    ['POST', '/agents', { nom: 'ZZ', prenom: 'ZZ', telephone: '+221779999902', role: 'agent', mot_de_passe_provisoire: 'MotDePasse2026!' }],
  ];
  for (const [methode, chemin, corps] of interdits) {
    const r = await appel(chemin, { methode, corps, jeton });
    assert.equal(r.statut, 403,
      `${methode} ${chemin} : attendu 403, obtenu ${r.statut} — ${r.texte.slice(0, 140)}`);
  }
});

test('le chef de projet garde la main sur ce qu\'il instruit', async () => {
  // Ses saisies restent ouvertes : sans effet tant que la municipalité n'a
  // pas validé, elles préparent une décision plutôt qu'elles ne l'appliquent.
  // Un corps incomplet doit être refusé pour ce motif, non pour cause de
  // profil en consultation.
  const jeton = await connecter(CHEF_PROJET);
  for (const chemin of ['/derogations/montant-force', '/exonerations']) {
    const r = await appel(chemin, { methode: 'POST', corps: {}, jeton });
    assert.notEqual(r.statut, 403,
      `${chemin} est fermé au chef de projet : ${r.texte.slice(0, 140)}`);
  }
});
