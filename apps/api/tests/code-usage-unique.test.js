'use strict';
/**
 * Le code à usage unique du portail redevable.
 *
 * Dernier des chemins que la constitution nomme comme devant être éprouvés
 * avant tout — « les seuls chemins où un défaut coûte de l'argent réel ou de
 * la confiance ». Il n'était couvert par aucun test.
 *
 * Ce qui se joue ici n'est pas de l'argent mais des DONNÉES PERSONNELLES. Le
 * portail donne accès au dossier fiscal d'un commerçant : ses montants dus,
 * son historique, son adresse. Un code à six chiffres sans limite de
 * tentatives se devine en un million d'essais, c'est-à-dire en quelques
 * minutes de script. Les trois garde-fous — durée de validité, nombre de
 * tentatives, nombre de demandes par heure — sont ce qui sépare un code court
 * commode d'une porte ouverte.
 *
 * Le service est éprouvé directement : passer par HTTP ferait intervenir la
 * limitation de débit du serveur, qui masquerait ce qu'on veut mesurer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, un, fermer } = require('./aide');

const otp = require('../src/services/otp.service');

test.after(fermer);

const SERIE = String(Date.now()).slice(-7);
const TELEPHONE = `+22178${SERIE}`;

/** Contexte super-admin : le portail n'est porteur d'aucun jeton. */
const contexte = { superAdmin: true, ip: '127.0.0.1' };

async function commune() {
  const c = await un("SELECT id FROM app.commune WHERE code = 'GTFC'");
  return c.id;
}

/**
 * Pose un code directement en base, empreinte comprise, pour éprouver la
 * vérification sans passer par l'envoi du SMS.
 */
async function poserCode(communeId, code, { secondes = 300, tentatives = 3 } = {}) {
  await q(`UPDATE app.code_acces SET consomme_le = now()
            WHERE telephone = $1 AND consomme_le IS NULL`, [TELEPHONE]);
  const [l] = await q(`
    INSERT INTO app.code_acces
      (commune_id, telephone, code_empreinte, sel, usage, expire_le, max_tentatives)
    SELECT $1, $2,
           encode(digest($3 || s.sel, 'sha256'), 'hex'), s.sel,
           'connexion', now() + ($4 || ' seconds')::interval, $5
      FROM (SELECT app.code_aleatoire(16) AS sel) s
    RETURNING id, sel`,
  [communeId, TELEPHONE, code, String(secondes), tentatives]);
  return l;
}

test.after(async () => {
  await q('DELETE FROM app.code_acces WHERE telephone = $1', [TELEPHONE]).catch(() => {});
});

test('un code juste ouvre l\'accès, et une seule fois', async () => {
  const communeId = await commune();
  await poserCode(communeId, '123456');

  const r = await otp.verifier(contexte, {
    communeId, telephone: TELEPHONE, code: '123456',
  });
  assert.ok(r, 'un code juste doit être accepté');

  // Rejouer le même code doit échouer : c'est un code à usage UNIQUE. Sans
  // cela, un code intercepté resterait valable jusqu'à son expiration.
  await assert.rejects(
    otp.verifier(contexte, { communeId, telephone: TELEPHONE, code: '123456' }),
    /invalide|expir/i,
    'un code déjà consommé doit être refusé');
});

test('trois tentatives fausses épuisent le code', async () => {
  const communeId = await commune();
  await poserCode(communeId, '654321', { tentatives: 3 });

  for (let i = 1; i <= 2; i += 1) {
    await assert.rejects(
      otp.verifier(contexte, { communeId, telephone: TELEPHONE, code: '000000' }),
      /tentative/i, `échec ${i} : le message doit annoncer ce qu'il reste`);
  }

  // Troisième échec : le code est brûlé, pas seulement refusé.
  await assert.rejects(
    otp.verifier(contexte, { communeId, telephone: TELEPHONE, code: '000000' }),
    /invalide/i);

  // Et le BON code ne fonctionne plus — c'est tout l'intérêt : au-delà de
  // trois essais, deviner devient sans objet.
  await assert.rejects(
    otp.verifier(contexte, { communeId, telephone: TELEPHONE, code: '654321' }),
    /invalide|expir/i,
    'le code doit être brûlé après épuisement des tentatives');
});

test('un code périmé est refusé, même juste', async () => {
  // On attend l'expiration plutôt que de la fabriquer : la base REFUSE
  // d'enregistrer un code déjà périmé (contrainte code_expiration_future),
  // et c'est une bonne chose — un code mort-né serait un code qu'on croit
  // envoyé. D'où une seconde d'attente réelle.
  const communeId = await commune();
  await poserCode(communeId, '111111', { secondes: 1 });
  await new Promise((r) => { setTimeout(r, 1300); });

  await assert.rejects(
    otp.verifier(contexte, { communeId, telephone: TELEPHONE, code: '111111' }),
    /invalide|expir/i);
});

test('le refus ne distingue pas « faux » de « expiré »', async () => {
  // Deux messages différents diraient à qui essaie si le numéro a un code en
  // cours — donc si le numéro est connu du système.
  const communeId = await commune();
  await poserCode(communeId, '222222', { secondes: 1 });
  await new Promise((r) => { setTimeout(r, 1300); });

  const messages = [];
  for (const code of ['222222', '999999']) {
    try { await otp.verifier(contexte, { communeId, telephone: TELEPHONE, code }); }
    catch (e) { messages.push(e.message); }
  }
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1],
    `« ${messages[0]} » et « ${messages[1]} » se distinguent`);
});

test('un numéro sans code en cours reçoit le même refus', async () => {
  const communeId = await commune();
  await q('DELETE FROM app.code_acces WHERE telephone = $1', [TELEPHONE]);

  await assert.rejects(
    otp.verifier(contexte, { communeId, telephone: TELEPHONE, code: '333333' }),
    /Code invalide ou expiré/,
    'un numéro inconnu ne doit pas se distinguer d\'un code faux');
});

test('les demandes sont plafonnées par heure', async () => {
  // Sans plafond, on redemande un code jusqu'à en obtenir un qu'on a le temps
  // d'intercepter — et le redevable reçoit une pluie de SMS qu'il n'a pas
  // demandés.
  const communeId = await commune();
  const p = await un(`
    SELECT coalesce(otp_max_par_heure, 5) AS max
      FROM app.commune_parametre WHERE commune_id = $1`, [communeId]);
  const plafond = Number(p?.max ?? 5);

  const autorise = await un(
    'SELECT * FROM app.code_acces_autorise($1, $2, $3::smallint)',
    [communeId, TELEPHONE, plafond]);
  assert.ok('autorise' in autorise || 'reste' in autorise,
    `la fonction de plafonnement doit renvoyer un verdict : ${JSON.stringify(autorise)}`);

  // On sature la fenêtre, puis on vérifie que la porte se ferme.
  for (let i = 0; i < plafond; i += 1) await poserCode(communeId, '444444');

  const apres = await un(
    'SELECT * FROM app.code_acces_autorise($1, $2, $3::smallint)',
    [communeId, TELEPHONE, plafond]);
  const verdict = apres.autorise ?? apres.ok ?? apres.permis;
  assert.equal(verdict, false,
    `${plafond} demandes en une heure doivent fermer la porte : ${JSON.stringify(apres)}`);
});

test('le code n\'est jamais stocké en clair', async () => {
  // Une base lue par un tiers ne doit pas livrer les codes en cours.
  const communeId = await commune();
  await poserCode(communeId, '555555');

  const l = await un(`
    SELECT code_empreinte, sel FROM app.code_acces
     WHERE telephone = $1 AND consomme_le IS NULL
     ORDER BY cree_le DESC LIMIT 1`, [TELEPHONE]);
  assert.ok(l, 'le code doit exister en base');
  assert.notEqual(l.code_empreinte, '555555');
  assert.equal(l.code_empreinte.length, 64, 'une empreinte SHA-256 fait 64 caractères');
  assert.ok(l.sel && l.sel.length >= 8,
    'un sel est nécessaire : sans lui, la même empreinte trahit le même code');

  const colonnes = await q(`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'code_acces'
       AND column_name IN ('code', 'code_clair', 'valeur')`);
  assert.equal(colonnes.length, 0, 'aucune colonne ne doit porter le code en clair');
});
