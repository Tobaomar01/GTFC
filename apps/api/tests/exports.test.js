'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { versCsv, champCsv } = require('../src/services/export.service');

/**
 * Réversibilité (FR-064, SC-018).
 *
 * Dans un partenariat public-privé, la réversibilité est la seule garantie
 * concrète que la commune reste propriétaire de son assiette fiscale à la
 * fin du contrat. Elle suppose des formats ouverts — et lisibles.
 */

test('les caractères spéciaux sont échappés selon le RFC 4180', () => {
  assert.equal(champCsv('Boutique "Chez Ndiaye"'), '"Boutique ""Chez Ndiaye"""');
  assert.equal(champCsv('Fass; Colobane'), '"Fass; Colobane"');
  assert.equal(champCsv('ligne1\nligne2'), '"ligne1\nligne2"');
});

test('un zéro n’est pas confondu avec une absence de valeur', () => {
  assert.equal(champCsv(0), '0');
  assert.equal(champCsv(null), '');
  assert.equal(champCsv(undefined), '');
});

test('le CSV porte un BOM et un point-virgule', () => {
  // Sans eux, Excel en configuration francophone met tout dans une seule
  // colonne et casse les accents : un export illisible n'est pas un export.
  const csv = versCsv([{ a: 1, b: 'Gueule Tapée' }],
    [{ cle: 'a', titre: 'A' }, { cle: 'b', titre: 'Quartier' }]);
  assert.ok(csv.startsWith('﻿'), 'BOM UTF-8 manquant');
  assert.match(csv, /A;Quartier\r\n/);
  assert.match(csv, /Gueule Tapée/);
});

test('les dates sortent en ISO 8601, non dans un format local', () => {
  const d = new Date('2026-08-29T10:00:00Z');
  assert.equal(champCsv(d), '2026-08-29T10:00:00.000Z');
});

test('les fins de ligne sont CRLF, comme l’exige le RFC', () => {
  const csv = versCsv([{ a: 1 }, { a: 2 }], [{ cle: 'a', titre: 'A' }]);
  assert.equal(csv.split('\r\n').length, 4, 'entête + 2 lignes + fin');
});
