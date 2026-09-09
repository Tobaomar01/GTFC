'use strict';
/**
 * Ce que devient la session de celui qui change son mot de passe.
 *
 * LE DÉFAUT QUI A MOTIVÉ CE FICHIER, mesuré le 09/09/2026 en préparant l'essai
 * de l'application de terrain sur un vrai téléphone.
 *
 * `changerMotDePasse` appelle `deconnecterPartout`, qui révoque TOUTES les
 * sessions du compte — y compris celle qui vient d'appeler. La route, elle,
 * répondait « Vos AUTRES appareils ont été déconnectés ». Le téléphone s'y
 * fiait : il gardait sa session, continuait un quart d'heure sur son jeton
 * d'accès, puis se retrouvait éjecté à l'écran de connexion, en pleine
 * tournée — et la connexion EXIGE du réseau. La journée de recensement restait
 * prisonnière du téléphone jusqu'à retrouver de la couverture.
 *
 * On ne change pas le comportement du serveur : couper toutes les sessions
 * après un changement de mot de passe est la bonne règle. Ce qui était faux,
 * c'est ce qu'il en DISAIT, et donc ce que le client en déduisait.
 *
 * Ce test épingle la règle réelle. Si un jour quelqu'un décide d'épargner la
 * session appelante, il tombera ici — et saura qu'un écran de l'application
 * mobile en dépend (apps/mobile/src/ecrans/ConnexionEcran.js).
 *
 * Il travaille sur un compte qu'il crée pour lui seul, et l'archive ensuite :
 * toucher aux comptes de démonstration ferait cascader les autres suites.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { q, un, fermer } = require('./aide');

const app = require('../src/app');

const SERIE = String(Date.now()).slice(-8);
const TEL = `+2217799${SERIE.slice(-5)}`;
const MDP_INITIAL = 'MotDePasseInitial1';
const MDP_NOUVEAU = 'MotDePasseSuivant2';

let serveur; let base; let compteId;

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

const connexion = () => appel('/auth/login', {
  methode: 'POST',
  corps: { telephone: TEL, mot_de_passe: MDP_INITIAL },
});

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;

  const commune = await un('SELECT id FROM app.commune ORDER BY cree_le LIMIT 1');
  const hash = await bcrypt.hash(MDP_INITIAL, 10);
  const cree = await un(
    `INSERT INTO app.utilisateur (commune_id, nom, prenom, telephone, role,
                                  mot_de_passe_hash, doit_changer_mdp)
     VALUES ($1, 'ESSAI-MDP', 'Compte', $2, 'agent', $3, true)
     RETURNING id`,
    [commune.id, TEL, hash],
  );
  compteId = cree.id;
});

test.after(async () => {
  if (compteId) {
    // Archiver, pas supprimer : une écriture ne disparaît pas. L'index unique
    // du téléphone ne porte que sur les comptes non archivés, donc rejouer la
    // suite reste possible.
    await q('UPDATE app.utilisateur SET archive_le = now(), actif = false WHERE id = $1',
      [compteId]);
  }
  await new Promise((r) => serveur.close(r));
  await fermer();
});

test('la session qui change le mot de passe est coupée, elle aussi', async () => {
  const ouverte = await connexion();
  assert.equal(ouverte.statut, 200, ouverte.texte);
  const { jeton_acces: acces, jeton_rafraichissement: rafraichissement } = ouverte.json.donnees;

  const change = await appel('/auth/mot-de-passe', {
    methode: 'POST',
    jeton: acces,
    corps: { ancien_mot_de_passe: MDP_INITIAL, nouveau_mot_de_passe: MDP_NOUVEAU },
  });
  assert.equal(change.statut, 200, change.texte);

  // Le point qui compte pour le téléphone : son propre jeton ne vaut plus rien.
  const rejoue = await appel('/auth/refresh', {
    methode: 'POST',
    corps: { jeton_rafraichissement: rafraichissement },
  });
  assert.equal(rejoue.statut, 401,
    'le jeton de rafraîchissement de l\'appelant survit au changement de mot de '
    + `passe : l'application mobile n'a plus besoin de se reconnecter (${rejoue.texte.slice(0, 160)})`);
});

test('la réponse annonce que la reconnexion est nécessaire', async () => {
  // Le client ne peut pas deviner ce que le serveur vient de faire à sa
  // session. Il lui reste à le lire. Le message qui disait « vos AUTRES
  // appareils » n'était pas une maladresse de style : il affirmait le
  // contraire de ce qui se passait.
  const ouverte = await appel('/auth/login', {
    methode: 'POST',
    corps: { telephone: TEL, mot_de_passe: MDP_NOUVEAU },
  });
  assert.equal(ouverte.statut, 200, ouverte.texte);

  const change = await appel('/auth/mot-de-passe', {
    methode: 'POST',
    jeton: ouverte.json.donnees.jeton_acces,
    corps: { ancien_mot_de_passe: MDP_NOUVEAU, nouveau_mot_de_passe: MDP_INITIAL },
  });
  assert.equal(change.statut, 200, change.texte);

  assert.equal(change.json.donnees.reconnexion_requise, true,
    'la réponse ne dit pas que la session appelante est fermée');
  assert.match(change.json.donnees.message, /y compris celle-ci/i,
    `message trompeur pour le client : « ${change.json.donnees.message} »`);
});
