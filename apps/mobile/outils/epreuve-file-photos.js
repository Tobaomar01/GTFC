#!/usr/bin/env node
/**
 * Éprouve les requêtes qui décident du sort d'une photo.
 *
 *   node --experimental-sqlite outils/epreuve-file-photos.js
 *
 * POURQUOI. Elles répondent à deux questions dont dépend ce que l'agent voit :
 * combien de photos vont partir, et lesquelles ne partiront plus. Une erreur
 * d'ordre de paramètres ou une parenthèse mal placée ne se verrait qu'au
 * téléphone, sur le cas rare — la photo bloquée — c'est-à-dire jamais pendant
 * les essais.
 *
 * CE QUI A ÉTÉ CONSTATÉ le 09/09/2026. `compterPhotosEnAttente` comptait TOUTES
 * les photos non envoyées, y compris celles qui ne pouvaient plus partir. Le
 * bandeau orange « N élément(s) à envoyer » ne retombait donc jamais à zéro, la
 * déconnexion restait refusée en permanence, et les photos réellement perdues
 * n'apparaissaient nulle part : la liste « à examiner » ne lit que la file
 * d'opérations.
 *
 * ON NE RECOPIE PAS LES REQUÊTES. Une copie continuerait de passer après une
 * modification de sync.repo.js, et l'épreuve porterait alors sur du code que
 * personne n'exécute. On les LIT dans src/bdd/requetes-photos.js, qui existe
 * pour ça : sync.repo.js tire expo-sqlite, donc React Native, et ne se charge
 * pas hors d'un téléphone.
 *
 * Sortie non nulle si une situation est mal classée.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TENTATIVES_MAX = 5;

// ---------------------------------------------------------------------------
//  Les requêtes, lues dans le code
// ---------------------------------------------------------------------------
const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'bdd', 'requetes-photos.js'), 'utf8');

function extraire(nom) {
  const motif = new RegExp('export const ' + nom + ' = `([\\s\\S]*?)`;');
  const m = SOURCE.match(motif);
  if (!m) throw new Error(nom + ' est introuvable dans requetes-photos.js');
  return m[1];
}

// Les gabarits imbriquent ${SQL_COMMERCE_BLOQUE} : on le substitue comme le
// ferait JavaScript au chargement du module.
const COMMERCE_BLOQUE = extraire('SQL_COMMERCE_BLOQUE');
const sqlDe = (nom) => extraire(nom).split('${SQL_COMMERCE_BLOQUE}').join(COMMERCE_BLOQUE);

const SQL_COMPTE = sqlDe('SQL_COMPTER_PHOTOS_EN_ATTENTE');
const SQL_BLOQUEES = sqlDe('SQL_PHOTOS_BLOQUEES');

// ---------------------------------------------------------------------------
//  Une base minimale, aux mêmes colonnes que schema.js
// ---------------------------------------------------------------------------
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE commerce (id_local TEXT PRIMARY KEY, id_serveur TEXT, enseigne TEXT);
CREATE TABLE photo_locale (
  id_local TEXT PRIMARY KEY, commerce_local TEXT NOT NULL, type TEXT,
  chemin_fichier TEXT, prise_le TEXT, envoyee INTEGER NOT NULL DEFAULT 0,
  tentatives INTEGER NOT NULL DEFAULT 0, derniere_erreur TEXT);
CREATE TABLE operation_sync (
  id INTEGER PRIMARY KEY AUTOINCREMENT, identifiant_local TEXT NOT NULL,
  entite TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'en_attente',
  tentatives INTEGER NOT NULL DEFAULT 0);
`);

const commerce = (id, serveur, enseigne) =>
  db.prepare('INSERT INTO commerce VALUES (?,?,?)').run(id, serveur, enseigne);
const photo = (id, cl, tentatives = 0, envoyee = 0) =>
  db.prepare(`INSERT INTO photo_locale (id_local, commerce_local, type, chemin_fichier,
              prise_le, envoyee, tentatives) VALUES (?,?,'devanture','/x','2026-09-09',?,?)`)
    .run(id, cl, envoyee, tentatives);
const operation = (idLocal, statut, tentatives = 0) =>
  db.prepare(`INSERT INTO operation_sync (identifiant_local, entite, statut, tentatives)
              VALUES (?, 'commerce', ?, ?)`).run(idLocal, statut, tentatives);

// ---------------------------------------------------------------------------
//  Les six situations qu'un agent rencontre
// ---------------------------------------------------------------------------
// A. fiche déjà sur le serveur, photo à envoyer               -> EN ATTENTE
commerce('A', 'srv-A', 'Boutique A'); photo('pA', 'A'); operation('A', 'confirmee');

// B. fiche pas encore partie, mais sa file avance             -> EN ATTENTE
//    C'est le cas ORDINAIRE, celui du recensement de la minute d'avant. Le
//    déclarer bloqué ferait crier le contrôle tous les jours.
commerce('B', null, 'Boutique B'); photo('pB', 'B'); operation('B', 'en_attente');

// C. fiche REJETÉE par le serveur                             -> BLOQUÉE
commerce('C', null, 'Boutique C'); photo('pC', 'C'); operation('C', 'rejetee');

// D. fiche qui a épuisé ses tentatives                        -> BLOQUÉE
commerce('D', null, 'Boutique D'); photo('pD', 'D');
operation('D', 'en_attente', TENTATIVES_MAX);

// E. photo refusée cinq fois, fiche pourtant remontée         -> BLOQUÉE
commerce('E', 'srv-E', 'Boutique E'); photo('pE', 'E', TENTATIVES_MAX);
operation('E', 'confirmee');

// F. photo déjà envoyée                                       -> NULLE PART
commerce('F', 'srv-F', 'Boutique F'); photo('pF', 'F', 1, 1); operation('F', 'confirmee');

// ---------------------------------------------------------------------------
//  Verdict
// ---------------------------------------------------------------------------
const compte = db.prepare(SQL_COMPTE).get(TENTATIVES_MAX, TENTATIVES_MAX);
const bloquees = db.prepare(SQL_BLOQUEES)
  .all(TENTATIVES_MAX, TENTATIVES_MAX, TENTATIVES_MAX);

// Ce que faisait l'ancienne version : tout ce qui n'est pas parti.
const ancien = db.prepare('SELECT count(*) AS n FROM photo_locale WHERE envoyee = 0').get();

const obtenues = bloquees.map((b) => b.id_local).sort();

console.log(`\n  ancien compteur « en attente » : ${ancien.n}  (comptait l'inenvoyable)`);
console.log(`  nouveau compteur               : ${compte.n}`);
console.log(`  photos bloquées                : ${obtenues.join(', ') || '(aucune)'}`);
for (const b of bloquees) {
  console.log(`      ${b.id_local}  ${String(b.enseigne).padEnd(12)} cause=${b.cause}`);
}
console.log('');

let echecs = 0;
const verifier = (nom, ok) => {
  console.log(`  ${ok ? 'OK   ' : 'ÉCHEC'} ${nom}`);
  if (!ok) echecs += 1;
};

verifier('le compteur ne retient que ce qui peut partir (A et B)', compte.n === 2);
verifier('les trois cas bloqués sont nommés (C, D, E)',
  JSON.stringify(obtenues) === JSON.stringify(['pC', 'pD', 'pE']));
verifier('une fiche pas encore partie n\'est PAS déclarée bloquée',
  !obtenues.includes('pB'));
verifier('une photo déjà envoyée n\'apparaît nulle part',
  compte.n + bloquees.length === 5 && !obtenues.includes('pF'));
verifier('la cause distingue le refus d\'envoi de la fiche bloquée',
  bloquees.find((b) => b.id_local === 'pE')?.cause === 'envoi_refuse'
  && bloquees.find((b) => b.id_local === 'pC')?.cause === 'fiche_bloquee');
verifier('l\'ancien compteur ne pouvait PAS retomber à zéro', ancien.n > compte.n);

console.log('');
process.exit(echecs === 0 ? 0 : 1);
