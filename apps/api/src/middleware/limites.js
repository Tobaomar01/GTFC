/**
 * Limitation de débit applicative.
 *
 * Nginx en pose déjà une par IP (phase 1). Celle-ci est complémentaire et
 * porte sur le COMPTE : sur le terrain, plusieurs agents partagent souvent
 * la même sortie 4G, donc la même IP. Limiter uniquement par IP pénaliserait
 * une équipe entière parce qu'un seul téléphone boucle.
 */
'use strict';

const rateLimit = require('express-rate-limit');
const { erreurs } = require('../utils/erreurs');

const gestionnaireDepassement = (message) => (req, _res, next) => {
  next(erreurs.tropDeRequetes(message));
};

/** Clé : le compte si connu, sinon l'IP. */
const cleParCompte = (req) => req.utilisateur?.id || req.ip;

const limiteConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // On compte par numéro de téléphone : essayer 10 mots de passe sur
  // 10 comptes différents reste possible côté IP, mais Nginx s'en charge.
  keyGenerator: (req) => `${req.ip}:${req.body?.telephone || 'inconnu'}`,
  handler: gestionnaireDepassement(
    'Trop de tentatives de connexion. Réessayez dans 15 minutes.'),
  skipSuccessfulRequests: true,
});

const limiteApi = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: cleParCompte,
  handler: gestionnaireDepassement('Trop de requêtes, ralentissez.'),
});

const limiteEcriture = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: cleParCompte,
  handler: gestionnaireDepassement('Trop d\'enregistrements en une minute.'),
});

/**
 * Synchronisation : plafond généreux et fenêtre longue.
 * Un agent rentrant d'une journée hors ligne envoie légitimement plusieurs
 * dizaines de lots d'affilée — le bloquer ferait perdre le travail de terrain.
 */
const limiteSync = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: cleParCompte,
  handler: gestionnaireDepassement(
    'Trop de synchronisations. Patientez quelques minutes, aucune donnée n\'est perdue.'),
});

/** Le webhook Wave n'est jamais limité : un paiement doit toujours arriver. */
const limitePublic = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: gestionnaireDepassement('Trop de requêtes.'),
});

module.exports = { limiteConnexion, limiteApi, limiteEcriture, limiteSync, limitePublic };
