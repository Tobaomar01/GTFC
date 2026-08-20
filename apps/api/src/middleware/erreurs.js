/**
 * Gestion centralisée des erreurs.
 *
 * Deux principes :
 *   - le client reçoit un message utile, jamais une trace technique ;
 *   - le serveur journalise tout, avec l'identifiant de requête, pour qu'un
 *     agent puisse dire « erreur REQ-3f2a » et qu'on retrouve la ligne.
 */
'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const { ErreurApi, erreurs, depuisErreurPostgres } = require('../utils/erreurs');

/** Identifiant court attaché à chaque requête, renvoyé en cas d'erreur. */
function identifiantRequete(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(4).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
}

function routeInconnue(req, _res, next) {
  next(erreurs.introuvable(`Route ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
function gestionnaireErreurs(err, req, res, _next) {
  let erreur = err;

  // Erreurs PostgreSQL traduites en messages métier
  if (!(erreur instanceof ErreurApi) && erreur.code && /^[0-9A-Z]{5}$/.test(erreur.code)) {
    erreur = depuisErreurPostgres(err) || erreur;
  }

  // Erreurs multer (téléversement)
  if (erreur.code === 'LIMIT_FILE_SIZE') {
    erreur = erreurs.tropVolumineux(
      `Photo trop lourde (maximum ${Math.round(config.stockage.tailleMaxPhotoOctets / 1024 / 1024)} Mo)`);
  } else if (erreur.code === 'LIMIT_UNEXPECTED_FILE') {
    erreur = erreurs.requeteInvalide('Champ de fichier inattendu');
  }

  // JSON malformé envoyé par le client
  if (erreur.type === 'entity.parse.failed') {
    erreur = erreurs.requeteInvalide('Corps de requête JSON illisible');
  }

  if (!(erreur instanceof ErreurApi)) {
    // Bug non anticipé : on journalise la pile, on ne la renvoie pas.
    logger.error(
      { err: erreur, reqId: req.id, url: req.originalUrl, methode: req.method,
        utilisateur: req.utilisateur?.id },
      'Erreur non gérée',
    );
    erreur = erreurs.interne();
  } else if (erreur.statut >= 500) {
    logger.error({ err: erreur, reqId: req.id, url: req.originalUrl }, erreur.message);
  } else {
    logger.warn(
      { code: erreur.code, reqId: req.id, url: req.originalUrl,
        utilisateur: req.utilisateur?.id },
      erreur.message,
    );
  }

  const corps = {
    succes: false,
    erreur: {
      code: erreur.code,
      message: erreur.message,
      requete: req.id,
    },
  };
  if (erreur.details) corps.erreur.details = erreur.details;
  if (!config.production && err.stack) corps.erreur.pile = err.stack.split('\n').slice(0, 5);

  return res.status(erreur.statut).json(corps);
}

module.exports = { identifiantRequete, routeInconnue, gestionnaireErreurs };
