'use strict';
/**
 * La contestation : le recours d'un commerçant qui juge son avis injuste.
 *
 * C'est la seule procédure du dispositif où la commune peut se tromper et le
 * reconnaître. Elle n'était couverte par aucun test.
 *
 * Deux règles y comptent plus que les autres.
 *
 * Le DÉPÔT NE SUSPEND PAS le recouvrement. C'est une décision explicite du
 * commanditaire : si contester suspendait, contester deviendrait un moyen de
 * ne pas payer, et la procédure se retournerait contre ce qu'elle protège. Un
 * superviseur peut suspendre — mais en le motivant, et cela reste une décision
 * prise, pas une conséquence automatique.
 *
 * Et TOUTE DÉCISION EST MOTIVÉE, acceptée comme rejetée. Un rejet sans motif
 * n'est pas contestable à son tour ; c'est une fin de non-recevoir déguisée en
 * procédure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const app = require('../src/app');

const MDP = process.env.MDP_DEMO ?? 'GtfcDemo2026!';
const AGENT = '+221700000011';
const SUPERVISEUR = '+221700000003';
const MAIRE = '+221700000005';
const SERIE = String(Date.now()).slice(-8);

let serveur; let base;
const jetons = {};
const creees = [];

async function appel(chemin, { methode = 'GET', corps = null, jeton = null } = {}) {
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

async function connecter(telephone) {
  if (jetons[telephone]) return jetons[telephone];
  const r = await appel('/auth/login', {
    methode: 'POST', corps: { telephone, mot_de_passe: MDP },
  });
  assert.equal(r.statut, 200, `connexion ${telephone} : ${r.texte}`);
  jetons[telephone] = r.json.donnees.jeton_acces;
  return jetons[telephone];
}

/** Dépose une contestation, comme le ferait un agent au guichet. */
async function deposer(suffixe = '') {
  const jeton = await connecter(AGENT);
  const cible = await un(`
    SELECT r.id AS redevable_id,
           (SELECT id FROM ref.motif_contestation ORDER BY code LIMIT 1) AS motif_id
      FROM app.redevable r WHERE r.archive_le IS NULL LIMIT 1`);

  const r = await appel('/contestations', {
    methode: 'POST', jeton,
    corps: {
      redevable_id: cible.redevable_id,
      motif_id: cible.motif_id,
      description: `ZZ-TEST-${SERIE}${suffixe} — la catégorie retenue ne correspond pas`,
      canal: 'guichet',
    },
  });
  assert.equal(r.statut, 201, r.texte);
  creees.push(r.json.donnees.id);
  return r.json.donnees;
}

test.before(async () => {
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  // Une contestation retirée reste au registre : c'est une trace de recours,
  // pas une écriture financière, mais elle a valeur de preuve. On la marque
  // plutôt que de l'effacer.
  for (const id of creees) {
    await q(`UPDATE app.contestation
                SET statut = 'retiree', modifie_le = now()
              WHERE id = $1 AND statut NOT IN ('acceptee','rejetee','retiree')`, [id])
      .catch(() => {});
  }
  await fermer();
  await new Promise((r) => serveur.close(r));
});

test('les six motifs du document sont proposés', async () => {
  const jeton = await connecter(AGENT);
  const r = await appel('/motifs-contestation', { jeton });
  assert.equal(r.statut, 200, r.texte);
  assert.equal(r.json.donnees.length, 6,
    'six motifs ont été arrêtés : en proposer d\'autres fausse les statistiques de recours');
});

test('déposer une contestation NE SUSPEND PAS le recouvrement', async () => {
  // La règle la plus importante de cette procédure. Si contester suspendait,
  // contester deviendrait un moyen de ne pas payer.
  const c = await deposer('-a');

  const ligne = await un(
    'SELECT suspend_recouvrement, statut, date_limite FROM app.contestation WHERE id = $1',
    [c.id]);
  assert.equal(ligne.suspend_recouvrement, false,
    'le dépôt a suspendu le recouvrement');
  assert.equal(ligne.statut, 'soumise');
  assert.ok(ligne.date_limite, 'un délai de traitement doit être fixé au dépôt');
});

test('le dépôt est tracé, et numéroté', async () => {
  const c = await deposer('-b');
  assert.match(c.numero, /\w/, 'la contestation doit porter un numéro opposable');

  const trace = await un(`
    SELECT count(*)::int AS n FROM audit.journal
     WHERE entite = 'contestation' AND entite_id = $1`, [c.id]);
  assert.ok(trace.n >= 1, 'un recours non tracé ne prouve rien');
});

test('une description trop courte est refusée', async () => {
  // « Pas d'accord » ne permet ni d'instruire, ni de répondre.
  const jeton = await connecter(AGENT);
  const cible = await un(`
    SELECT r.id AS redevable_id,
           (SELECT id FROM ref.motif_contestation LIMIT 1) AS motif_id
      FROM app.redevable r WHERE r.archive_le IS NULL LIMIT 1`);
  const r = await appel('/contestations', {
    methode: 'POST', jeton,
    corps: { redevable_id: cible.redevable_id, motif_id: cible.motif_id, description: 'non' },
  });
  assert.equal(r.statut, 400, `attendu 400, obtenu ${r.statut}`);
});

test('suspendre le recouvrement exige un motif', async () => {
  const c = await deposer('-c');
  const jeton = await connecter(SUPERVISEUR);

  // Sans motif : refusé. La suspension gèle une créance publique ; elle se
  // justifie.
  const sansMotif = await appel(`/contestations/${c.id}/instruire`, {
    methode: 'POST', jeton,
    corps: { statut: 'en_instruction', suspend_recouvrement: true },
  });
  assert.equal(sansMotif.statut, 400,
    `une suspension sans motif a été acceptée : ${sansMotif.texte.slice(0, 160)}`);

  // Avec motif : accepté, et c'est une décision, pas un automatisme.
  const avecMotif = await appel(`/contestations/${c.id}/instruire`, {
    methode: 'POST', jeton,
    corps: {
      statut: 'visite_demandee',
      suspend_recouvrement: true,
      motif_suspension: 'Double enregistrement probable, vérification sur place demandée',
    },
  });
  assert.equal(avecMotif.statut, 200, avecMotif.texte);

  const ligne = await un(
    'SELECT suspend_recouvrement FROM app.contestation WHERE id = $1', [c.id]);
  assert.equal(ligne.suspend_recouvrement, true);
});

test('toute décision est motivée, et la suspension tombe avec elle', async () => {
  const c = await deposer('-d');
  const jeton = await connecter(SUPERVISEUR);

  // On REGARDE la réponse. Une version antérieure de ce test appelait sans
  // vérifier : l'instruction échouait en 500 à chaque fois, et le test passait
  // quand même parce que la suite ne dépendait pas d'elle.
  const instruction = await appel(`/contestations/${c.id}/instruire`, {
    methode: 'POST', jeton,
    corps: {
      statut: 'en_instruction',
      suspend_recouvrement: true,
      motif_suspension: 'Vérification demandée',
    },
  });
  assert.equal(instruction.statut, 200, instruction.texte);

  // Un rejet sans motif n'est pas contestable à son tour : c'est une fin de
  // non-recevoir déguisée en procédure.
  const sansMotif = await appel(`/contestations/${c.id}/resoudre`, {
    methode: 'POST', jeton, corps: { decision: 'rejetee', motif_decision: 'non' },
  });
  assert.equal(sansMotif.statut, 400, 'un rejet sans motivation a été accepté');

  const r = await appel(`/contestations/${c.id}/resoudre`, {
    methode: 'POST', jeton,
    corps: {
      decision: 'acceptee',
      motif_decision: 'Catégorie corrigée : boutique et non supérette, avis rectifié',
    },
  });
  assert.equal(r.statut, 200, r.texte);

  const ligne = await un(`SELECT statut, suspend_recouvrement, resolue_par, motif_decision
                            FROM app.contestation WHERE id = $1`, [c.id]);
  assert.equal(ligne.statut, 'acceptee');
  // Laisser la suspension courir après décision gèlerait la créance
  // indéfiniment.
  assert.equal(ligne.suspend_recouvrement, false);
  assert.ok(ligne.resolue_par, 'la décision doit être attribuable');
});

test('une contestation résolue ne se résout pas deux fois', async () => {
  const c = await deposer('-e');
  const jeton = await connecter(SUPERVISEUR);
  const corps = {
    decision: 'rejetee',
    motif_decision: 'Le montant correspond au barème délibéré pour cette catégorie',
  };

  assert.equal((await appel(`/contestations/${c.id}/resoudre`,
    { methode: 'POST', jeton, corps })).statut, 200);

  const rejeu = await appel(`/contestations/${c.id}/resoudre`, { methode: 'POST', jeton, corps });
  assert.equal(rejeu.statut, 409,
    'rejouer la décision écraserait la première, et sa date, et son auteur');
});

test('un agent ne tranche pas ce qu\'il a saisi', async () => {
  // Il recueille le recours ; l'instruire et le trancher revient au
  // superviseur. Réunir les deux mettrait l'agent en position d'annuler une
  // taxe qu'il a lui-même établie.
  const c = await deposer('-f');
  const jeton = await connecter(AGENT);
  const r = await appel(`/contestations/${c.id}/resoudre`, {
    methode: 'POST', jeton,
    corps: { decision: 'acceptee', motif_decision: 'Je considère la demande fondée' },
  });
  assert.equal(r.statut, 403, `un agent a tranché une contestation : ${r.statut}`);
});

test('le maire consulte les recours mais n\'en dépose aucun', async () => {
  const jeton = await connecter(MAIRE);
  assert.equal((await appel('/contestations', { jeton })).statut, 200);

  const cible = await un('SELECT id FROM app.redevable WHERE archive_le IS NULL LIMIT 1');
  const motif = await un('SELECT id FROM ref.motif_contestation LIMIT 1');
  const r = await appel('/contestations', {
    methode: 'POST', jeton,
    corps: {
      redevable_id: cible.id, motif_id: motif.id,
      description: 'ZZ-TEST tentative depuis un profil de consultation',
    },
  });
  assert.equal(r.statut, 403, `le maire a déposé une contestation : ${r.statut}`);
});
