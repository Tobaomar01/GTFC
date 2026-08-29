'use strict';
/**
 * Socle des tests d'intégration.
 *
 * Ces tests parlent à une VRAIE base PostgreSQL. C'est délibéré : quatre
 * défauts de facturation ont échappé à la relecture et à l'analyseur
 * syntaxique, et n'ont été trouvés qu'en exécutant. Un test qui simule la
 * base ne les aurait pas vus davantage.
 *
 * Prérequis : une base à jour des migrations et des seeds.
 *   createdb gtfc_test && DATABASE_URL=postgres://localhost/gtfc_test \
 *     ./db/migrate.sh && npm test
 */
const { Pool } = require('pg');

const URL = process.env.DATABASE_URL_TEST
  ?? process.env.DATABASE_URL
  ?? 'postgres://localhost/gtfc_recette';

const pool = new Pool({ connectionString: URL, max: 4 });

async function q(texte, valeurs = []) {
  const r = await pool.query(texte, valeurs);
  return r.rows;
}

async function un(texte, valeurs = []) {
  const rows = await q(texte, valeurs);
  return rows[0];
}

/** Vrai si la requête lève une erreur — pour éprouver une contrainte. */
async function refuse(texte, valeurs = []) {
  try { await pool.query(texte, valeurs); return false; }
  catch { return true; }
}

async function fermer() { await pool.end(); }

module.exports = { pool, q, un, refuse, fermer, URL };
