'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Le module importe des dépendances Expo indisponibles hors application :
// on n'éprouve ici que la fonction d'agrégation, extraite du fichier source.
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(
  path.resolve(__dirname, '../src/services/localisation.js'), 'utf8');

const debut = source.indexOf('function distanceM');
const fin = source.indexOf('/**\n * Relève une position');
// eslint-disable-next-line no-new-func
const { agreger } = new Function(
  `${source.slice(debut, fin).replace(/export function/g, 'function')}
   return { agreger };`)();

/**
 * Agrégation des mesures GPS.
 *
 * L'ancienne version gardait la meilleure mesure. Ces tests verrouillent ce
 * qui la remplace : une moyenne pondérée, débarrassée des aberrations, dont
 * la précision annoncée reflète la dispersion réelle et non l'optimisme du
 * capteur.
 */

const M = (lon, lat, precision) => ({ longitude: lon, latitude: lat, precision,
                                      releve_le: '2026-08-29T10:00:00Z' });

test('une mesure unique est rendue telle quelle', () => {
  const r = agreger([M(-17.44, 14.69, 12)]);
  assert.equal(r.nb_mesures, 1);
  assert.equal(r.precision_gps_m, 12);
});

test('aucune mesure ne donne rien plutôt qu’un point à zéro', () => {
  assert.equal(agreger([]), null);
});

test('la moyenne se place au centre de mesures dispersées', () => {
  const r = agreger([
    M(-17.4400, 14.6900, 10), M(-17.4402, 14.6900, 10),
    M(-17.4400, 14.6902, 10), M(-17.4402, 14.6902, 10),
  ]);
  assert.ok(Math.abs(r.longitude - (-17.4401)) < 1e-6);
  assert.ok(Math.abs(r.latitude - 14.6901) < 1e-6);
  assert.equal(r.nb_mesures, 4);
});

test('une mesure du réseau mobile à 500 m est écartée', () => {
  // Sans ce filtre, une seule mesure aberrante déplacerait le point de
  // plusieurs centaines de mètres.
  const bonnes = Array.from({ length: 6 }, (_, i) =>
    M(-17.4400 + i * 1e-6, 14.6900, 8));
  const r = agreger([...bonnes, M(-17.4450, 14.6950, 500)]);
  assert.equal(r.nb_ecartees, 1);
  assert.ok(Math.abs(r.longitude - (-17.44)) < 1e-4,
    'le point ne doit pas avoir été tiré vers l’aberration');
});

test('une mesure précise pèse plus qu’une imprécise', () => {
  const r = agreger([M(-17.4400, 14.6900, 4), M(-17.4420, 14.6900, 40)]);
  // Poids en 1/précision² : la mesure à 4 m pèse cent fois celle à 40 m.
  assert.ok(Math.abs(r.longitude - (-17.4400)) < 0.0001,
    `attendu proche de -17.4400, obtenu ${r.longitude}`);
});

test('la précision annoncée reflète la dispersion, non l’optimisme du capteur', () => {
  // Quatre mesures qui se prétendent à 5 m mais s'étalent sur ~20 m.
  const r = agreger([
    M(-17.44000, 14.69000, 5), M(-17.44020, 14.69000, 5),
    M(-17.44000, 14.69020, 5), M(-17.44020, 14.69020, 5),
  ]);
  assert.ok(r.precision_gps_m > 5,
    `annoncer ${r.precision_gps_m} m alors que les mesures s'étalent serait mentir`);
});

test('on ne prétend jamais descendre sous 3 mètres', () => {
  const identiques = Array.from({ length: 20 }, () => M(-17.44, 14.69, 3));
  const r = agreger(identiques);
  assert.ok(r.precision_gps_m >= 3,
    'un téléphone ne fait pas mieux que quelques mètres, même en moyennant');
});

test('moyenner réduit réellement l’erreur annoncée', () => {
  const une = agreger([M(-17.4400, 14.6900, 30)]);
  const vingt = agreger(Array.from({ length: 20 }, (_, i) =>
    M(-17.4400 + (i % 5) * 2e-6, 14.6900 + (i % 3) * 2e-6, 30)));
  assert.ok(vingt.precision_gps_m < une.precision_gps_m / 2,
    `20 mesures devraient au moins diviser l'erreur par deux : `
    + `${une.precision_gps_m} → ${vingt.precision_gps_m}`);
});

test('l’origine reste satellite : ce n’est pas une saisie manuelle', () => {
  assert.equal(agreger([M(-17.44, 14.69, 10)]).origine, 'satellite');
});
