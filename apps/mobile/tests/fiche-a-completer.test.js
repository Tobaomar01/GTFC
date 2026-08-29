'use strict';
/**
 * La règle « fiche à reprendre ».
 *
 * Elle est écrite deux fois, et c'est délibéré : côté serveur dans une colonne
 * calculée (migration 0052), côté téléphone pour que le marquage apparaisse
 * avant la synchronisation. Deux écritures d'une même règle divergent tôt ou
 * tard ; ces tests verrouillent la version embarquée, et le commentaire de
 * chacune renvoie à l'autre.
 *
 * Ce qu'elle décide est concret. Une fiche sans NUMÉRO ne rapportera jamais un
 * franc : le pilote n'a qu'un canal de recouvrement, le SMS mensuel portant le
 * lien Wave. Une fiche sans NOM produit un avis adressé à une enseigne, qui
 * n'est opposable à personne.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Le module importe des dépendances Expo indisponibles hors application :
// on extrait la seule fonction éprouvée ici.
const source = fs.readFileSync(
  path.resolve(__dirname, '../src/bdd/commerces.repo.js'), 'utf8');
const debut = source.indexOf('export function ficheACompleter');
const fin = source.indexOf('export async function creerCommerce');
// eslint-disable-next-line no-new-func
const { ficheACompleter } = new Function(
  `${source.slice(debut, fin).replace('export function', 'function')}
   return { ficheACompleter };`)();

test('nom et numéro relevés : la fiche est complète', () => {
  assert.equal(
    ficheACompleter({ gerant_nom: 'Diallo', gerant_telephone: '+221770000001' }), false);
});

test('le numéro de paiement suffit, même sans numéro du gérant', () => {
  // C'est le cas courant : le gérant fait payer depuis le compte du
  // propriétaire, ou depuis un second téléphone.
  assert.equal(
    ficheACompleter({ gerant_nom: 'Diallo', telephone_paiement: '+221770000002' }), false);
});

test('sans numéro, la fiche est à reprendre', () => {
  // Recensée, géolocalisée, taxée — et hors d'atteinte du seul canal de
  // recouvrement du pilote.
  assert.equal(ficheACompleter({ gerant_nom: 'Diallo' }), true);
});

test('sans nom de gérant, la fiche est à reprendre', () => {
  assert.equal(ficheACompleter({ gerant_telephone: '+221770000003' }), true);
});

test('boutique ouverte, personne pour répondre : à reprendre', () => {
  assert.equal(ficheACompleter({}), true);
});

test('des espaces ne valent pas une identité', () => {
  // Un champ rempli d'espaces passerait un test de nullité et laisserait la
  // fiche pour terminée. C'est la façon la plus discrète de perdre un dossier.
  assert.equal(ficheACompleter({ gerant_nom: '   ', gerant_telephone: '+221770000004' }), true);
  assert.equal(ficheACompleter({ gerant_nom: 'Diallo', gerant_telephone: '  ' }), true);
});
