/**
 * Démarrage du serveur.
 *
 * Trois exigences propres à ce déploiement :
 *   - Dakar connaît des coupures de courant : PM2 relance le processus au
 *     retour du secteur, il doit donc démarrer seul, sans intervention ;
 *   - `wait_ready: true` dans ecosystem.config.js : PM2 attend notre signal
 *     avant de basculer le trafic. Sans process.send('ready'), le rechargement
 *     sans coupure ne fonctionne pas ;
 *   - un arrêt propre laisse aux synchronisations en cours le temps de
 *     finir : couper un agent en pleine remontée de données lui ferait
 *     perdre sa journée.
 */
'use strict';

const config = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');
const db = require('./config/database');
const stockage = require('./services/stockage.service');

let serveur = null;
let arretEnCours = false;

async function demarrer() {
  logger.info(
    { env: config.env, node: process.version, tz: config.timezone },
    'Démarrage de l\'API GTFC',
  );

  // --- Vérifications avant d'ouvrir le port -------------------------------
  // Mieux vaut refuser de démarrer que d'accepter des requêtes qui échoueront
  // toutes : un agent sur le terrain doit avoir un message clair.
  try {
    const infoBdd = await db.verifierConnexion();
    logger.info(infoBdd, 'PostgreSQL connecté');
  } catch (err) {
    logger.fatal({ err: err.message }, 'Connexion à PostgreSQL impossible');
    process.exit(1);
  }

  try {
    const buckets = await stockage.verifierConnexion();
    logger.info({ buckets }, 'MinIO connecté');
  } catch (err) {
    // Dégradé, pas bloquant : sans MinIO les photos ne partent pas, mais le
    // recensement et les paiements restent possibles. L'app met les photos en
    // attente et les enverra à la prochaine synchronisation.
    logger.error({ err: err.message },
      'MinIO indisponible — l\'API démarre en mode dégradé (photos indisponibles)');
  }

  // --- Ouverture du port ---------------------------------------------------
  serveur = app.listen(config.serveur.port, config.serveur.host, () => {
    logger.info(
      { adresse: `http://${config.serveur.host}:${config.serveur.port}` },
      'API à l\'écoute',
    );
    // Signal attendu par PM2 (wait_ready)
    if (process.send) process.send('ready');
  });

  // Un agent en 3G lente ne doit pas voir sa requête coupée par le serveur.
  serveur.keepAliveTimeout = 65000;
  serveur.headersTimeout = 70000;
  serveur.requestTimeout = 300000;

  serveur.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        { port: config.serveur.port },
        'Port déjà utilisé — un autre processus API tourne-t-il ? (pm2 list)',
      );
    } else {
      logger.fatal({ err }, 'Erreur du serveur HTTP');
    }
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Arrêt propre
// ---------------------------------------------------------------------------
async function arreter(signal) {
  if (arretEnCours) return;
  arretEnCours = true;
  logger.info({ signal }, 'Arrêt demandé — fermeture en douceur');

  // Filet de sécurité : si une requête ne se termine jamais, on ne reste pas
  // bloqué indéfiniment. 8 s = kill_timeout de PM2 moins une marge.
  const minuterie = setTimeout(() => {
    logger.warn('Arrêt forcé après expiration du délai');
    process.exit(1);
  }, 7500);
  minuterie.unref();

  try {
    if (serveur) {
      await new Promise((resolve) => serveur.close(resolve));
      logger.info('Serveur HTTP fermé, plus aucune nouvelle requête acceptée');
    }
    await db.fermer();
    logger.info('Connexions PostgreSQL fermées');
    clearTimeout(minuterie);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Erreur pendant l\'arrêt');
    process.exit(1);
  }
}

process.on('SIGTERM', () => arreter('SIGTERM'));
process.on('SIGINT', () => arreter('SIGINT'));

process.on('unhandledRejection', (raison) => {
  logger.error({ raison }, 'Promesse rejetée sans gestionnaire');
});

process.on('uncaughtException', (err) => {
  // État du processus incertain : on journalise puis on laisse PM2 relancer.
  logger.fatal({ err }, 'Exception non capturée — redémarrage');
  arreter('uncaughtException');
});

demarrer().catch((err) => {
  logger.fatal({ err }, 'Échec du démarrage');
  process.exit(1);
});
