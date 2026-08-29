#!/usr/bin/env node
/**
 * Vérification du schéma SQLite local.
 *
 *   npm run test:schema
 *
 * Pourquoi cet outil : le schéma de `src/bdd/schema.js` ne s'exécute
 * normalement que sur un téléphone Android. Une faute de syntaxe SQL ou une
 * requête invalide ne se découvrirait qu'au moment où un agent ouvre
 * l'application sur le terrain — le pire endroit pour découvrir un bug.
 *
 * On rejoue donc ici, sur un moteur SQLite réel (sql.js, compilé en
 * WebAssembly), le schéma ET les requêtes des dépôts, avec un jeu de données
 * représentatif.
 */
'use strict';

const path = require('path');
const fs = require('fs');

let ok = 0;
let ko = 0;
const resultats = [];

function verifier(nom, condition, detail = '') {
  if (condition) { ok += 1; resultats.push(`  OK    ${nom}`); } else {
    ko += 1;
    resultats.push(`  ECHEC ${nom}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Extrait SCHEMA_SQL sans importer le module (il est en syntaxe ESM). */
function lireSchema() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'bdd', 'schema.js'), 'utf8');
  const debut = source.indexOf('export const SCHEMA_SQL = `');
  if (debut === -1) throw new Error('SCHEMA_SQL introuvable dans schema.js');
  const apres = debut + 'export const SCHEMA_SQL = `'.length;
  const fin = source.indexOf('`;', apres);
  return source.slice(apres, fin);
}

async function principal() {
  let initSqlJs;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    initSqlJs = require('sql.js');
  } catch {
    console.error('\n  sql.js manquant. Installez-le :  npm install --save-dev sql.js\n');
    process.exit(2);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database();

  // -------------------------------------------------------------------------
  console.log('\nSchéma');
  // -------------------------------------------------------------------------
  const schema = lireSchema();
  try {
    db.run(schema);
    verifier('Le schéma s\'exécute sans erreur SQL', true);
  } catch (err) {
    verifier('Le schéma s\'exécute sans erreur SQL', false, err.message);
    console.log(resultats.join('\n'));
    process.exit(1);
  }

  const tables = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )[0].values.flat();

  const attendues = ['commerce', 'commerce_taxe', 'journal_local', 'meta', 'operation_sync',
    'paiement', 'photo_locale', 'referentiel', 'visite'];
  for (const t of attendues) {
    verifier(`Table ${t}`, tables.includes(t), `tables trouvées : ${tables.join(', ')}`);
  }

  const index = db.exec(
    "SELECT count(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")[0].values[0][0];
  verifier('Index créés', index >= 8, `${index} index`);

  // -------------------------------------------------------------------------
  console.log('Insertions');
  // -------------------------------------------------------------------------
  const maintenant = new Date().toISOString();

  try {
    db.run(`
      INSERT INTO commerce (id_local, enseigne, categorie_id, quartier_id,
                            longitude, latitude, todp_surface_m2, cree_le, modifie_le)
      VALUES ('local-1', 'Boutique Ndiayé', 'cat-1', 'q-1', -17.4470, 14.6870, 6.4, ?, ?)`,
    [maintenant, maintenant]);
    verifier('Insertion d\'un commerce', true);
  } catch (err) {
    verifier('Insertion d\'un commerce', false, err.message);
  }

  // Les valeurs par défaut doivent marquer la fiche comme locale et à envoyer
  const defauts = db.exec(
    'SELECT origine_locale, modifie_localement, statut, enseigne_lumineuse FROM commerce')[0].values[0];
  verifier('Valeurs par défaut correctes (locale, à envoyer, actif)',
    defauts[0] === 1 && defauts[1] === 1 && defauts[2] === 'actif' && defauts[3] === 0,
    JSON.stringify(defauts));

  db.run(`INSERT INTO commerce_taxe (id_local, commerce_local, type_taxe_code, parametre_valeur)
          VALUES ('t-1', 'local-1', 'todp', 6.4), ('t-2', 'local-1', 'patente', NULL)`);
  verifier('Taxes rattachées',
    db.exec("SELECT count(*) FROM commerce_taxe WHERE commerce_local='local-1'")[0]
      .values[0][0] === 2);

  // Contrainte d'unicité : une taxe ne peut pas être dupliquée sur un commerce
  let doublonRefuse = false;
  try {
    db.run(`INSERT INTO commerce_taxe (id_local, commerce_local, type_taxe_code)
            VALUES ('t-3', 'local-1', 'todp')`);
  } catch { doublonRefuse = true; }
  verifier('Doublon de taxe refusé par la contrainte', doublonRefuse);

  db.run(`
    INSERT INTO operation_sync (identifiant_local, entite, operation, donnees,
                                horodatage_client, cree_le)
    VALUES ('local-1', 'commerce', 'creation', '{"enseigne":"Boutique Ndiayé"}', ?, ?)`,
  [maintenant, maintenant]);
  verifier('Opération empilée dans la file',
    db.exec("SELECT statut FROM operation_sync")[0].values[0][0] === 'en_attente');

  db.run(`
    INSERT INTO photo_locale (id_local, commerce_local, type, chemin_fichier, prise_le)
    VALUES ('p-1', 'local-1', 'devanture', '/data/photos/x.jpg', ?)`, [maintenant]);

  db.run(`
    INSERT INTO paiement (id_local, commerce_local, reference, montant, paye_le)
    VALUES ('pay-1', 'local-1', 'TER-ABCD1234', 15000, ?)`, [maintenant]);

  let referenceDupliquee = false;
  try {
    db.run(`INSERT INTO paiement (id_local, commerce_local, reference, montant, paye_le)
            VALUES ('pay-2', 'local-1', 'TER-ABCD1234', 15000, ?)`, [maintenant]);
  } catch { referenceDupliquee = true; }
  verifier('Référence de paiement unique — pas de double encaissement', referenceDupliquee);

  // -------------------------------------------------------------------------
  console.log('Requêtes des dépôts');
  // -------------------------------------------------------------------------

  // listerCommerces
  try {
    const r = db.exec(`
      SELECT c.*, (SELECT count(*) FROM photo_locale p
                    WHERE p.commerce_local = c.id_local AND p.envoyee = 0) AS photos_en_attente
        FROM commerce c ORDER BY c.modifie_le DESC LIMIT 100`);
    const colonnes = r[0].columns;
    const idx = colonnes.indexOf('photos_en_attente');
    verifier('listerCommerces : compte les photos en attente', r[0].values[0][idx] === 1);
  } catch (err) {
    verifier('listerCommerces', false, err.message);
  }

  // commercesProches — filtrage par rectangle
  try {
    const rayon = 100;
    const lat = 14.6870;
    const lon = -17.4470;
    const dLat = rayon / 111320;
    const dLon = rayon / (111320 * Math.cos((lat * Math.PI) / 180));
    const r = db.exec(`
      SELECT id_local FROM commerce
       WHERE longitude BETWEEN ${lon - dLon} AND ${lon + dLon}
         AND latitude  BETWEEN ${lat - dLat} AND ${lat + dLat}`);
    verifier('commercesProches : le rectangle capte le commerce voisin',
      r.length > 0 && r[0].values.length === 1);
  } catch (err) {
    verifier('commercesProches', false, err.message);
  }

  // photosEnAttente — la jointure exige un identifiant serveur
  try {
    let r = db.exec(`
      SELECT p.id_local FROM photo_locale p
        JOIN commerce c ON c.id_local = p.commerce_local
       WHERE p.envoyee = 0 AND p.tentatives < 5 AND c.id_serveur IS NOT NULL`);
    verifier('photosEnAttente : aucune photo tant que le commerce n\'est pas remonté',
      r.length === 0);

    db.run("UPDATE commerce SET id_serveur = 'srv-1' WHERE id_local = 'local-1'");
    r = db.exec(`
      SELECT p.id_local FROM photo_locale p
        JOIN commerce c ON c.id_local = p.commerce_local
       WHERE p.envoyee = 0 AND p.tentatives < 5 AND c.id_serveur IS NOT NULL`);
    verifier('photosEnAttente : la photo part une fois le commerce remonté',
      r.length === 1 && r[0].values.length === 1);
  } catch (err) {
    verifier('photosEnAttente', false, err.message);
  }

  // statistiquesDuJour
  try {
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    const r = db.exec(
      'SELECT COALESCE(sum(montant), 0) FROM paiement WHERE paye_le >= ?', [debut.toISOString()]);
    verifier('statistiquesDuJour : somme des encaissements', r[0].values[0][0] === 15000);
  } catch (err) {
    verifier('statistiquesDuJour', false, err.message);
  }

  // ON CONFLICT sur meta et referentiel
  try {
    db.run(`INSERT INTO meta (cle, valeur) VALUES ('derniere_sync', 'a')
            ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`);
    db.run(`INSERT INTO meta (cle, valeur) VALUES ('derniere_sync', 'b')
            ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur`);
    verifier('ecrireMeta : ON CONFLICT met bien à jour',
      db.exec("SELECT valeur FROM meta WHERE cle='derniere_sync'")[0].values[0][0] === 'b');

    db.run(`INSERT INTO referentiel (cle, contenu, recu_le) VALUES ('categories', '[]', ?)
            ON CONFLICT(cle) DO UPDATE SET contenu = excluded.contenu`, [maintenant]);
    verifier('enregistrerReferentiels : ON CONFLICT accepté', true);
  } catch (err) {
    verifier('ON CONFLICT', false, err.message);
  }

  // definirTaxe : ON CONFLICT sur une contrainte composite
  try {
    db.run(`
      INSERT INTO commerce_taxe (id_local, commerce_local, type_taxe_code, parametre_valeur, active)
      VALUES ('t-4', 'local-1', 'todp', 9.9, 1)
      ON CONFLICT(commerce_local, type_taxe_code)
      DO UPDATE SET parametre_valeur = excluded.parametre_valeur, active = 1`);
    const v = db.exec(
      "SELECT parametre_valeur FROM commerce_taxe WHERE commerce_local='local-1' AND type_taxe_code='todp'")[0]
      .values[0][0];
    verifier('definirTaxe : mise à jour de la mesure existante', v === 9.9, `valeur = ${v}`);
  } catch (err) {
    verifier('definirTaxe', false, err.message);
  }

  // Suppression en cascade
  try {
    db.run('PRAGMA foreign_keys = ON');
    db.run("DELETE FROM commerce WHERE id_local = 'local-1'");
    const restes = db.exec("SELECT count(*) FROM commerce_taxe")[0].values[0][0]
      + db.exec("SELECT count(*) FROM photo_locale")[0].values[0][0];
    verifier('Suppression en cascade des éléments rattachés', restes === 0, `${restes} restants`);
  } catch (err) {
    verifier('Cascade', false, err.message);
  }

  // Purge du journal
  try {
    for (let i = 0; i < 600; i += 1) {
      db.run('INSERT INTO journal_local (niveau, message, horodatage) VALUES (?,?,?)',
        ['info', `message ${i}`, maintenant]);
    }
    db.run(`DELETE FROM journal_local
             WHERE id < (SELECT COALESCE(MAX(id), 0) - 500 FROM journal_local)`);
    const restants = db.exec('SELECT count(*) FROM journal_local')[0].values[0][0];
    verifier('purgerJournal : borne à ~500 lignes', restants <= 501, `${restants} lignes`);
  } catch (err) {
    verifier('purgerJournal', false, err.message);
  }

  db.close();

  console.log(`\n${resultats.join('\n')}`);
  console.log(`\n  ${ok} succès, ${ko} échec(s)\n`);
  process.exit(ko === 0 ? 0 : 1);
}

principal().catch((err) => {
  console.error('\nERREUR :', err.message, '\n');
  process.exit(1);
});
