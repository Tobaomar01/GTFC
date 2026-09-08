'use strict';
/**
 * Le chemin de l'argent : signature du webhook et idempotence de
 * l'encaissement.
 *
 * La constitution nomme ces deux points parmi les rares où les tests doivent
 * précéder le code, « les seuls chemins où un défaut coûte de l'argent réel ou
 * de la confiance ». Ils n'étaient couverts par aucun test.
 *
 * Ce qu'ils protègent, concrètement :
 *
 *   · la SIGNATURE est la seule chose qui distingue un encaissement réel d'un
 *     encaissement inventé. Une vérification qui laisse passer un corps modifié
 *     permet à quiconque connaît l'adresse du webhook de solder n'importe quel
 *     avis ;
 *   · l'IDEMPOTENCE : Wave réémet ses webhooks jusqu'à recevoir un 2xx. Le même
 *     paiement arrive donc plusieurs fois. Encaisser deux fois marquerait un
 *     avis payé au double, fausserait le recouvrement, et le redevable
 *     découvrirait un crédit qu'il n'a pas versé.
 *
 * Le test crée un vrai paiement, puis le CONTRE-PASSE : une écriture
 * financière ne se supprime pas, la correction prend la forme d'une écriture
 * inverse. C'est aussi la façon dont la commune corrigera une erreur réelle.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { q, un, enTransaction, fermer } = require('./aide');

const config = require('../src/config/env');
const app = require('../src/app');

const SECRET = config.wave.webhookSecret;
const SERIE = String(Date.now()).slice(-10);

let serveur; let base;
const aNettoyer = { transactions: [], paiements: [] };

function signer(corps, { secret = SECRET, horodatage = Math.floor(Date.now() / 1000) } = {}) {
  const v1 = crypto.createHmac('sha256', secret).update(`${horodatage}.${corps}`).digest('hex');
  return `t=${horodatage},v1=${v1}`;
}

async function webhook(corps, entete) {
  const r = await fetch(`${base}/webhooks/wave`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(entete === null ? {} : { 'wave-signature': entete ?? signer(corps) }),
    },
    body: corps,
  });
  return { statut: r.status, texte: await r.text() };
}

/** Un avis réel, avec du reste à payer, et sa session Wave. */
async function preparerSession(sessionId) {
  const avis = await un(`
    SELECT a.id, a.commune_id, a.commerce_id, a.montant_restant, a.montant_paye,
           r.telephone
      FROM app.avis_imposition a
      JOIN app.redevable r ON r.id = a.redevable_id
     WHERE a.annule_le IS NULL AND a.montant_restant > 1000
     ORDER BY a.montant_restant DESC LIMIT 1`);
  assert.ok(avis, 'il faut un avis avec du reste à payer pour éprouver l\'encaissement');

  const [tr] = await q(`
    INSERT INTO app.transaction_wave
      (commune_id, avis_id, wave_session_id, montant, telephone, statut)
    VALUES ($1, $2, $3, $4, $5, 'initiee')
    RETURNING id`,
  [avis.commune_id, avis.id, sessionId, 1000, avis.telephone ?? '+221770000000']);
  aNettoyer.transactions.push(tr.id);

  return avis;
}

const evenement = (sessionId, montant = 1000) => JSON.stringify({
  type: 'checkout_session_completed',
  data: { id: sessionId, amount: montant, transaction_id: `T-${sessionId}` },
});

test.before(async () => {
  assert.ok(SECRET, 'WAVE_WEBHOOK_SECRET doit être configuré pour ce test');
  serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  base = `http://127.0.0.1:${serveur.address().port}`;
});

test.after(async () => {
  // Les transactions Wave ne sont pas des écritures financières : elles
  // peuvent disparaître. Les PAIEMENTS, non — ils sont contre-passés dans le
  // test lui-même, et leur trace subsiste, comme il se doit.
  for (const id of aNettoyer.transactions) {
    await q('DELETE FROM app.transaction_wave WHERE id = $1', [id]).catch(() => {});
  }
  await fermer();
  await new Promise((r) => serveur.close(r));
});

// ---------------------------------------------------------------------------
//  Signature
// ---------------------------------------------------------------------------

test('une signature valide est acceptée', async () => {
  const corps = evenement(`sess-ok-${SERIE}`);
  const r = await webhook(corps);
  assert.equal(r.statut, 200, r.texte);
});

test('un corps modifié après signature est refusé', async () => {
  // Le cas qui compte : on intercepte un webhook légitime et on augmente le
  // montant. Sans vérification du corps, l'avis serait soldé pour rien.
  const corps = evenement(`sess-alt-${SERIE}`, 1000);
  const entete = signer(corps);
  const corpsFalsifie = evenement(`sess-alt-${SERIE}`, 999999);

  const r = await webhook(corpsFalsifie, entete);
  assert.equal(r.statut, 401, `un corps modifié doit être refusé : ${r.texte}`);
});

test('une signature calculée avec un autre secret est refusée', async () => {
  const corps = evenement(`sess-secret-${SERIE}`);
  const r = await webhook(corps, signer(corps, { secret: 'mauvais-secret' }));
  assert.equal(r.statut, 401);
});

test('un horodatage périmé est refusé', async () => {
  // Sans fenêtre temporelle, une requête interceptée resterait rejouable
  // indéfiniment — signature comprise, puisqu'elle est valide.
  const corps = evenement(`sess-vieux-${SERIE}`);
  const vieux = Math.floor(Date.now() / 1000) - 3600;
  const r = await webhook(corps, signer(corps, { horodatage: vieux }));
  assert.equal(r.statut, 401);
});

test('une signature absente ou mal formée est refusée', async () => {
  const corps = evenement(`sess-sans-${SERIE}`);
  assert.equal((await webhook(corps, null)).statut, 401);
  assert.equal((await webhook(corps, 'nimportequoi')).statut, 401);
  assert.equal((await webhook(corps, 't=123')).statut, 401);
  // Signature plus courte que l'attendue : la comparaison à temps constant
  // lève si les longueurs diffèrent. Elle doit être gardée en amont.
  assert.equal((await webhook(corps, `t=${Math.floor(Date.now() / 1000)},v1=ab`)).statut, 401);
});

test('le refus ne dit pas pourquoi', async () => {
  // Détailler le motif aiderait à ajuster une contrefaçon jusqu'à ce qu'elle
  // passe.
  const corps = evenement(`sess-muet-${SERIE}`);
  const r = await webhook(corps, signer(corps, { secret: 'mauvais' }));
  assert.doesNotMatch(r.texte, /horodatage|hmac|secret|attendue/i);
});

// ---------------------------------------------------------------------------
//  Idempotence de l'encaissement
// ---------------------------------------------------------------------------

test('le même paiement livré deux fois n\'encaisse qu\'une fois', async () => {
  const sessionId = `sess-idem-${SERIE}`;
  const avant = await preparerSession(sessionId);
  const corps = evenement(sessionId, 1000);

  const premier = await webhook(corps);
  assert.equal(premier.statut, 200, premier.texte);

  // Wave réémet jusqu'à recevoir un 2xx : la deuxième livraison est le cas
  // NORMAL, pas une attaque.
  const second = await webhook(corps);
  assert.equal(second.statut, 200, second.texte);

  const paiements = await q(`
    SELECT id, montant FROM app.paiement
     WHERE avis_id = $1 AND reference LIKE 'WAVE-%' AND annule_le IS NULL`, [avant.id]);
  const notres = paiements.filter((p) => Number(p.montant) === 1000);
  assert.equal(notres.length, 1,
    `${notres.length} paiements créés pour une seule session Wave`);
  aNettoyer.paiements.push(notres[0].id);

  const apres = await un(
    'SELECT montant_paye, montant_restant FROM app.avis_imposition WHERE id = $1', [avant.id]);
  assert.equal(Number(apres.montant_paye), Number(avant.montant_paye) + 1000,
    'l\'avis a été crédité deux fois');
  assert.equal(Number(apres.montant_restant), Number(avant.montant_restant) - 1000);
});

test('la contre-passation rétablit le solde, sans effacer la trace', async () => {
  const paiementId = aNettoyer.paiements[0];
  assert.ok(paiementId, 'le test précédent doit avoir produit un paiement');

  const avant = await un(`
    SELECT a.id, a.montant_paye FROM app.avis_imposition a
      JOIN app.paiement p ON p.avis_id = a.id WHERE p.id = $1`, [paiementId]);

  await q(`UPDATE app.paiement
              SET annule_le = now(), motif_annulation = 'contre-passation de test'
            WHERE id = $1 AND annule_le IS NULL`, [paiementId]);

  const apres = await un(
    'SELECT montant_paye FROM app.avis_imposition WHERE id = $1', [avant.id]);
  assert.equal(Number(apres.montant_paye), Number(avant.montant_paye) - 1000,
    'annuler un paiement doit rendre le montant au solde dû');

  // La ligne demeure : une écriture financière ne se supprime pas, elle se
  // contre-passe. C'est ce qui rend le contrôle a posteriori possible.
  const trace = await un(
    'SELECT id, annule_le, motif_annulation FROM app.paiement WHERE id = $1', [paiementId]);
  assert.ok(trace && trace.annule_le && trace.motif_annulation);
});

test('un montant supérieur au reste dû est plafonné', async () => {
  // Un écart d'arrondi côté opérateur ne doit pas créer un trop-perçu : la
  // base refuse qu'un avis soit payé au-delà de son montant.
  const sessionId = `sess-trop-${SERIE}`;
  const avis = await preparerSession(sessionId);
  const exces = Number(avis.montant_restant) + 500000;

  const r = await webhook(evenement(sessionId, exces));
  assert.equal(r.statut, 200, r.texte);

  const apres = await un(
    'SELECT montant_paye, montant_total FROM app.avis_imposition WHERE id = $1', [avis.id]);
  assert.ok(Number(apres.montant_paye) <= Number(apres.montant_total),
    'un versement supérieur au dû a créé un trop-perçu');

  const [p] = await q(`
    SELECT id FROM app.paiement
     WHERE avis_id = $1 AND reference = $2`, [avis.id, `WAVE-${sessionId.slice(-16).toUpperCase()}`]);
  if (p) {
    await q(`UPDATE app.paiement SET annule_le = now(),
                motif_annulation = 'contre-passation de test' WHERE id = $1`, [p.id]);
  }
});

test('une session inconnue est acceptée sans rien encaisser', async () => {
  // Wave cesse de réémettre sur un 2xx. Refuser une session qu'on ne connaît
  // pas la ferait réémettre indéfiniment, sans que rien ne s'arrange.
  const corps = evenement(`sess-fantome-${SERIE}`);
  const r = await webhook(corps);
  assert.equal(r.statut, 200, r.texte);

  const p = await un(
    'SELECT id FROM app.paiement WHERE reference = $1',
    [`WAVE-${`sess-fantome-${SERIE}`.slice(-16).toUpperCase()}`]);
  assert.equal(p, undefined, 'une session inconnue ne doit rien encaisser');
});

// ===========================================================================
//  Le rapprochement : savoir reconnaître un désaccord avec l'opérateur
//
//  La constitution l'exige : « En cas de désaccord entre le système et
//  l'opérateur de mobile money, l'encaissement DOIT être bloqué et présenté
//  comme en attente. Il NE DOIT jamais être présumé. »
//
//  Encore faut-il SAVOIR reconnaître un désaccord. Rien ne comparait
//  app.transaction_wave à app.paiement. Un webhook perdu — et tout opérateur
//  en perd — laissait un redevable qui a payé et qui doit toujours. Un agent
//  serait allé lui réclamer une somme déjà réglée, le reçu sur son téléphone.
//  C'est la pire visite possible, et elle était invisible côté mairie.
// ===========================================================================

test('un encaissement Wave sans paiement imputé est signalé', async () => {
  await enTransaction(async (client) => {
    const { rows: [avis] } = await client.query(
      'SELECT id, commune_id FROM app.avis_imposition LIMIT 1');
    assert.ok(avis, 'aucun avis : le jeu de données est vide');

    await client.query(`
      INSERT INTO app.transaction_wave (commune_id, avis_id, wave_session_id, montant,
                                        devise, telephone, statut, environnement,
                                        expire_le, confirme_le)
      VALUES ($1, $2, 'cos_test_rapprochement', 5000, 'XOF', '+221700000000',
              'reussie', 'sandbox', now() + interval '1 day', now())`,
    [avis.commune_id, avis.id]);

    const { rows } = await client.query(`
      SELECT gravite FROM app.v_rapprochement_wave
       WHERE wave_session_id = 'cos_test_rapprochement'`);
    assert.equal(rows.length, 1,
      'un encaissement confirmé par Wave sans paiement imputé passe inaperçu');
    assert.equal(rows[0].gravite, 'erreur',
      'ce désaccord n\'est qu\'un avertissement : personne ne le regardera');

    const { rows: coherence } = await client.query(
      "SELECT nb FROM app.verifier_coherence($1) WHERE controle LIKE '%encaisse_non_impute%'",
      [avis.commune_id]);
    assert.equal(Number(coherence[0]?.nb), 1,
      'le contrôle de cohérence quotidien ne remonte pas le désaccord');
  });
});

// Pas de test « le rapprochement est vide » : il affirmerait un invariant GLOBAL
// alors que les tests voisins de ce fichier creent legitimement des transactions
// Wave en cours de route. Il ne saurait pas distinguer un vrai desaccord d'un
// residu d'essai — et un test qui echoue pour la mauvaise raison finit ignore.
//
// Ce controle-la est OPERATIONNEL, pas unitaire : app.verifier_coherence() le
// porte, et la tache quotidienne de 6h30 le regarde sur les donnees reelles.
