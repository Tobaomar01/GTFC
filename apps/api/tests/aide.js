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

/**
 * Garde-fou : les tests et l'application doivent viser la MÊME base.
 *
 * Elles s'y connectent différemment, et c'est voulu — les tests lisent avec
 * un compte privilégié pour voir au-delà des politiques d'isolation, tandis
 * que l'application se connecte comme en production, avec `gtfc_app`. Mais
 * l'API ne lit PAS `DATABASE_URL` : elle compose sa connexion à partir de
 * `DB_HOST`, `DB_NAME` et consorts. Poser `DATABASE_URL` seul dirige donc les
 * tests vers une base et l'application vers une autre.
 *
 * La panne qui s'ensuit ne ressemble pas à ce qu'elle est : les identifiants
 * lus d'un côté n'existent pas de l'autre, et l'on croit à une violation de
 * clé étrangère. Mieux vaut refuser de démarrer.
 */
const baseDe = (url) => {
  // `globalThis.URL` explicitement : la constante `URL` déclarée plus haut
  // masque le constructeur dans ce module, et `new URL(...)` échouerait en
  // silence — la garde ci-dessous se déclencherait alors à tort.
  try { return new globalThis.URL(url).pathname.replace(/^\//, ''); }
  catch { return url; }
};
const baseTests = baseDe(URL);
const baseApp = process.env.DB_NAME ?? null;
if (baseApp && baseApp !== baseTests) {
  throw new Error(
    `Les tests visent « ${baseTests} » et l'application « ${baseApp} ».\n`
    + 'L\'API ne lit pas DATABASE_URL : posez DB_NAME (et DB_USER, DB_PASSWORD) '
    + 'pour elle, DATABASE_URL_TEST pour les tests, sur la même base.');
}

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
