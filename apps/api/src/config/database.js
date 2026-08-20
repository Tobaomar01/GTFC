/**
 * Accès à PostgreSQL.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  POINT LE PLUS IMPORTANT DE CE FICHIER
 * ─────────────────────────────────────────────────────────────────────────
 *  L'API se connecte avec le rôle `gtfc_app`, soumis aux politiques RLS
 *  posées en phase 2. Sans contexte, ce rôle ne voit AUCUNE ligne.
 *
 *  Le contexte est posé par `SET LOCAL`, donc valable pour la seule
 *  transaction en cours. Une connexion rendue au pool ne conserve jamais
 *  l'identité de la requête précédente — c'est ce qui rend l'isolation
 *  multi-communes sûre malgré la mutualisation des connexions.
 *
 *  Conséquence pratique : toute lecture ou écriture métier passe par
 *  `avecContexte()` ou `requete()`. Un appel direct à `pool.query()` sur
 *  une table métier renverra 0 ligne, et c'est voulu.
 * ─────────────────────────────────────────────────────────────────────────
 */
'use strict';

const { Pool, types } = require('pg');
const config = require('./env');
const logger = require('./logger');

// --- Conversions de types --------------------------------------------------
// Par défaut, node-postgres renvoie les NUMERIC en chaîne pour ne pas perdre
// de précision. Ici tous les montants sont des entiers XOF (jamais de
// centimes) et les surfaces tiennent largement dans un double : on convertit,
// ce qui évite des `parseFloat` disséminés dans tout le code.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));

const pool = new Pool({
  host: config.bdd.host,
  port: config.bdd.port,
  database: config.bdd.database,
  user: config.bdd.user,
  password: config.bdd.password,
  max: config.bdd.maxConnexions,
  idleTimeoutMillis: config.bdd.delaiInactivite,
  connectionTimeoutMillis: config.bdd.delaiConnexion,
  application_name: 'gtfc-api',
});

pool.on('error', (err) => {
  // Erreur sur une connexion inactive du pool : ne doit jamais tuer le process
  logger.error({ err }, 'Erreur sur une connexion PostgreSQL inactive');
});

// ---------------------------------------------------------------------------
// Contexte de requête
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Contexte
 * @property {string=} utilisateurId  alimente le journal d'audit
 * @property {string=} communeId      restreint la visibilité (RLS)
 * @property {boolean=} superAdmin    lève la restriction de commune
 * @property {string=} ip             tracée dans le journal d'audit
 */

/** Contexte vide : utile pour les tâches planifiées agissant sur une commune. */
const CONTEXTE_SYSTEME = Object.freeze({ superAdmin: true });

async function poserContexte(client, ctx = {}) {
  // set_config(..., true) = SET LOCAL : annulé à la fin de la transaction.
  // Les valeurs passent en paramètres, jamais par concaténation : un
  // identifiant forgé ne peut donc pas s'échapper en SQL.
  await client.query(
    `SELECT set_config('gtfc.utilisateur_id', $1, true),
            set_config('gtfc.commune_id',     $2, true),
            set_config('gtfc.super_admin',    $3, true),
            set_config('gtfc.ip',             $4, true)`,
    [
      ctx.utilisateurId ?? '',
      ctx.communeId ?? '',
      ctx.superAdmin ? 'on' : '',
      ctx.ip ?? '',
    ],
  );
}

/**
 * Exécute `fn` dans une transaction dotée du contexte de sécurité.
 * Valide en sortie, annule à la moindre exception.
 *
 * @param {Contexte} ctx
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */
async function avecContexte(ctx, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await poserContexte(client, ctx);
    const resultat = await fn(client);
    await client.query('COMMIT');
    return resultat;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (errRollback) {
      logger.error({ err: errRollback }, 'Échec du ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Raccourci pour une requête unique sous contexte.
 * Coût : une transaction courte de plus par requête. Sur une base locale
 * c'est négligeable, et cela garantit qu'aucune lecture n'échappe au RLS.
 */
async function requete(ctx, sql, params = []) {
  return avecContexte(ctx, (client) => client.query(sql, params));
}

/**
 * Requête SANS contexte de sécurité.
 *
 * Réservée aux appels de fonctions SQL déclarées SECURITY DEFINER
 * (authentification, résolution d'un sous-domaine, scan public d'un QR).
 * Ces fonctions sont volontairement peu nombreuses et ne renvoient que le
 * strict nécessaire — voir la migration 0017.
 *
 * Ne l'utilisez JAMAIS sur une table métier : le RLS renverrait 0 ligne,
 * et si un jour ce n'était plus le cas, ce serait une fuite entre communes.
 */
async function requeteSysteme(sql, params = []) {
  return pool.query(sql, params);
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------
async function verifierConnexion() {
  const { rows } = await pool.query(
    "SELECT current_user, current_database(), version() AS v, now() AS maintenant",
  );
  const info = rows[0];

  if (info.current_user !== config.bdd.user) {
    logger.warn(
      { attendu: config.bdd.user, obtenu: info.current_user },
      'Connexion établie avec un rôle inattendu',
    );
  }
  // Se connecter en superutilisateur désactiverait silencieusement toutes les
  // politiques RLS : mieux vaut refuser de démarrer.
  const { rows: r2 } = await pool.query('SELECT usesuper FROM pg_user WHERE usename = current_user');
  if (r2[0]?.usesuper) {
    throw new Error(
      `L'API est connectée en superutilisateur (${info.current_user}). `
      + 'Les politiques d\'isolation multi-communes seraient contournées. '
      + 'Utilisez le rôle gtfc_app (DB_USER dans le .env).',
    );
  }

  return {
    utilisateur: info.current_user,
    base: info.current_database,
    version: String(info.v).split(' ').slice(0, 2).join(' '),
  };
}

async function fermer() {
  await pool.end();
}

module.exports = {
  pool,
  avecContexte,
  requete,
  requeteSysteme,
  verifierConnexion,
  fermer,
  CONTEXTE_SYSTEME,
};
