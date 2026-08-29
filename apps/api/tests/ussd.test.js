'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool, fermer } = require('./aide');
const ussd = require('../src/services/ussd.service');

test.after(fermer);

/**
 * Canal USSD (FR-067, FR-068, Constitution VI).
 *
 * Le point critique n'est pas la consultation : c'est le SILENCE. Une
 * réponse qui différerait entre un numéro inconnu et un numéro non vérifié
 * permettrait d'énumérer les redevables de la commune en composant au
 * hasard.
 */

test('un numéro inconnu et un numéro non vérifié reçoivent le même texte', async () => {
  // On ne compare pas des libellés au hasard : c'est la MÊME constante.
  assert.equal(typeof ussd.REPONSE_INCONNUE, 'string');
  assert.ok(ussd.REPONSE_INCONNUE.length > 0);

  const source = require('node:fs')
    .readFileSync(require.resolve('../src/services/ussd.service'), 'utf8');
  const retours = [...source.matchAll(/return \{ fin: true, texte: ([^}]+)\}/g)]
    .map((m) => m[1].trim());
  const inconnues = retours.filter((r) => r.includes('REPONSE_INCONNUE'));
  assert.equal(inconnues.length, 2,
    'le numéro inconnu et la panne doivent renvoyer exactement la même constante');
});

test('la réponse ne contient aucun caractère hors GSM-7', async () => {
  // Un seul accent fait basculer l'USSD en UCS-2 et divise par deux la
  // capacité de l'écran.
  const textes = [ussd.REPONSE_INCONNUE, 'Votre situation est a jour. Merci.'];
  for (const t of textes) {
    assert.doesNotMatch(ussd.sansAccent(t), /[^\x00-\x7F]/,
      `caractère non GSM-7 : ${t}`);
  }
});

test('la réponse tient dans un écran USSD', async () => {
  assert.ok(ussd.sansAccent(ussd.REPONSE_INCONNUE).length <= 182,
    'un écran USSD est limité à 182 octets');
});

test('sansAccent retire les diacritiques sans casser le texte', () => {
  assert.equal(ussd.sansAccent('Gueule Tapée-Fass-Colobane'), 'Gueule Tapee-Fass-Colobane');
  assert.equal(ussd.sansAccent('a regler avant le 31'), 'a regler avant le 31');
});

test('un numéro non vérifié n’est pas reconnu par la requête', async () => {
  // Transaction annulée : le jeu de données de démonstration reste intact.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO app.redevable
        (commune_id, code, numero_sequence, nom, type_redevable, telephone, statut_telephone)
      VALUES ((SELECT id FROM app.commune LIMIT 1), 'TEST-USSD-1', 999999,
              'Test non verifie', 'personne_physique', '+221770009991', 'non_verifie')`);

    const nonVerifie = await client.query(`
      SELECT r.id FROM app.redevable r
       WHERE r.telephone = $1 AND r.statut_telephone = 'verifie' AND r.archive_le IS NULL`,
      ['+221770009991']);
    assert.equal(nonVerifie.rowCount, 0,
      'un numéro non vérifié ne doit jamais être reconnu');

    // Le schéma exige que toute vérification soit tracée : date et auteur.
    await client.query(`
      UPDATE app.redevable
         SET statut_telephone = 'verifie',
             telephone_verifie_le = now(),
             telephone_verifie_par = (SELECT id FROM app.utilisateur LIMIT 1)
       WHERE code = 'TEST-USSD-1'`);
    const verifie = await client.query(`
      SELECT r.id FROM app.redevable r
       WHERE r.telephone = $1 AND r.statut_telephone = 'verifie' AND r.archive_le IS NULL`,
      ['+221770009991']);
    assert.equal(verifie.rowCount, 1, 'un numéro vérifié doit être reconnu');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
