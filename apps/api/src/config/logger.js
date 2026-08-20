/**
 * Journalisation applicative (pino).
 *
 * Attention à ne pas confondre avec le journal d'AUDIT : celui-ci vit dans
 * PostgreSQL (schéma `audit`) et fait foi. Les logs ci-dessous sont
 * techniques — ils servent au diagnostic, pas à la preuve.
 *
 * Les champs sensibles sont masqués : un mot de passe ou un jeton ne doit
 * jamais se retrouver en clair dans /var/log/gtfc/.
 */
'use strict';

const pino = require('pino');
const config = require('./env');

const champsMasques = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.mot_de_passe',
  'req.body.motDePasse',
  'req.body.ancien_mot_de_passe',
  'req.body.nouveau_mot_de_passe',
  'req.body.code_pin',
  'res.headers["set-cookie"]',
  'mot_de_passe',
  'mot_de_passe_hash',
  'jeton',
  'jeton_hash',
  'refresh_token',
  'password',
  'apiKey',
  'secret',
];

const logger = pino({
  level: config.journal.niveau,
  redact: { paths: champsMasques, censor: '[masqué]' },
  base: { service: 'gtfc-api', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  ...(config.production
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

module.exports = logger;
