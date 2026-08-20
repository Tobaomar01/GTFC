/**
 * Application Express.
 *
 * L'ordre des middlewares compte :
 *   1. identifiant de requête, pour que TOUT ce qui suit soit corrélable ;
 *   2. webhooks AVANT express.json(), car ils ont besoin du corps brut ;
 *   3. parseurs JSON pour le reste ;
 *   4. routes ;
 *   5. gestionnaire d'erreurs, toujours en dernier.
 */
'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');

const config = require('./config/env');
const logger = require('./config/logger');
const { identifiantRequete, routeInconnue, gestionnaireErreurs } = require('./middleware/erreurs');
const { limiteApi } = require('./middleware/limites');
const { asyncHandler } = require('./utils/reponse');
const db = require('./config/database');
const stockage = require('./services/stockage.service');

const app = express();

// ---------------------------------------------------------------------------
// Confiance au proxy
// Nginx est le seul à parler à l'API. Sans ce réglage, req.ip serait toujours
// l'adresse du conteneur Nginx et le journal d'audit perdrait toute utilité.
// ---------------------------------------------------------------------------
app.set('trust proxy', config.serveur.proxyDeConfiance);
app.disable('x-powered-by');
app.set('etag', false);

app.use(identifiantRequete);

// ---------------------------------------------------------------------------
// Sécurité HTTP
// ---------------------------------------------------------------------------
app.use(helmet({
  // L'API ne sert pas de HTML : la CSP est inutile ici, elle est posée par
  // Nginx sur le dashboard.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(cors({
  origin(origine, callback) {
    // Requêtes sans origine : app Android, curl, appels serveur à serveur.
    if (!origine) return callback(null, true);
    if (config.serveur.corsOrigines.length === 0) return callback(null, true);
    if (config.serveur.corsOrigines.includes(origine)) return callback(null, true);

    // Tous les sous-domaines de la plateforme sont des dashboards de communes
    if (config.domaine !== 'localhost' && origine.endsWith(`.${config.domaine}`)) {
      return callback(null, true);
    }
    logger.warn({ origine }, 'Origine CORS refusée');
    return callback(null, false);
  },
  credentials: true,
  maxAge: 86400,
}));

// ---------------------------------------------------------------------------
// Journalisation des requêtes
// ---------------------------------------------------------------------------
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.id,
  autoLogging: {
    // Les sondes de santé passeraient 2 880 lignes par jour dans les journaux
    ignore: (req) => req.url === '/healthz' || req.url === '/pret',
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
}));

// ---------------------------------------------------------------------------
// Sondes de santé — avant tout le reste, sans authentification
// ---------------------------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({
  statut: 'ok',
  service: 'gtfc-api',
  horodatage: new Date().toISOString(),
}));

/**
 * Sonde approfondie : vérifie réellement la base et le stockage.
 * Utilisée par scripts/healthcheck.sh et par la supervision.
 */
app.get('/pret', asyncHandler(async (_req, res) => {
  const resultats = { base: null, stockage: null };
  let ok = true;

  try {
    resultats.base = await db.verifierConnexion();
  } catch (err) {
    resultats.base = { erreur: err.message };
    ok = false;
  }

  try {
    resultats.stockage = await stockage.verifierConnexion();
  } catch (err) {
    resultats.stockage = { erreur: err.message };
    ok = false;
  }

  return res.status(ok ? 200 : 503).json({ statut: ok ? 'pret' : 'degrade', ...resultats });
}));

// ---------------------------------------------------------------------------
// Webhooks — AVANT express.json(), le corps brut est indispensable au HMAC
// ---------------------------------------------------------------------------
app.use('/webhooks', require('./routes/webhooks.routes'));

// ---------------------------------------------------------------------------
// Parseurs
// ---------------------------------------------------------------------------
app.use(express.json({ limit: config.serveur.tailleMaxRequete }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// ---------------------------------------------------------------------------
// Routes publiques (sans JWT)
// ---------------------------------------------------------------------------
app.use('/public', require('./routes/public.routes'));

// Portail du redevable — public lui aussi, mais protégé par sa propre session
// (code à usage unique + cookie httpOnly). Monté ici, avant limiteApi, parce
// qu'un commerçant qui consulte son dossier n'a pas de JWT d'agent.
app.use('/portail', require('./routes/portail.routes'));

// Raccourci pour les QR codes. L'URL imprimée sur le sticker pointe vers le
// dashboard (gtfc.domaine.sn/c/<jeton>), qui la traite lui-même en phase 6 ;
// cette redirection couvre le cas où quelqu'un tape l'URL courte sur l'API.
app.get('/c/:jeton', (req, res) => res.redirect(302, `/public/c/${req.params.jeton}`));

// ---------------------------------------------------------------------------
// Routes authentifiées
// ---------------------------------------------------------------------------
app.use('/auth', require('./routes/auth.routes'));

app.use(limiteApi);
app.use('/commerces', require('./routes/commerces.routes'));
app.use('/', require('./routes/territoire.routes'));   // /communes, /zones, /quartiers, /categories
app.use('/taxes', require('./routes/taxes.routes'));
app.use('/', require('./routes/avis.routes'));         // /periodes, /avis, /paiements
app.use('/agents', require('./routes/agents.routes'));
app.use('/sync', require('./routes/sync.routes'));
app.use('/', require('./routes/stats.routes'));        // /stats, /audit
app.use('/', require('./routes/documents.routes')); // /quittances, /impression, /campagnes, /notifications
app.use('/redevables', require('./routes/redevables.routes'));
app.use('/rues', require('./routes/rues.routes'));
app.use('/', require('./routes/objets.routes'));        // /affichages, /chantiers
app.use('/', require('./routes/contestations.routes')); // /contestations, /motifs-contestation

// ---------------------------------------------------------------------------
// Racine : inventaire des routes, utile au développeur
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => res.json({
  service: 'API — plateforme de collecte des taxes locales',
  version: require('../package.json').version,
  environnement: config.env,
  documentation: 'docs/PHASE-3-api.md',
  routes: {
    authentification: ['POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout',
      'GET /auth/moi', 'POST /auth/mot-de-passe'],
    commerces: ['GET /commerces', 'POST /commerces', 'GET /commerces/carte',
      'GET /commerces/proches', 'GET /commerces/:id', 'PATCH /commerces/:id',
      'POST /commerces/:id/photos', 'GET /commerces/:id/sticker'],
    territoire: ['GET /communes', 'GET /zones', 'GET /quartiers', 'GET /categories',
      'GET /marches'],
    redevables: ['GET /redevables', 'POST /redevables', 'GET /redevables/:id',
      'PATCH /redevables/:id', 'POST /redevables/:id/telephone/code',
      'POST /redevables/:id/telephone/verifier', 'POST /redevables/:id/telephone',
      'POST /redevables/:id/fusionner'],
    objets_taxables: ['GET /affichages', 'POST /affichages',
      'POST /affichages/:id/deposer', 'GET /affichages/:id/montant',
      'GET /chantiers', 'POST /chantiers', 'POST /chantiers/:id/constat'],
    rues: ['GET /rues', 'POST /rues', 'PATCH /rues/:id', 'GET /rues/couverture',
      'GET /rues/proche', 'POST /rues/import', 'POST /rues/recalculer-rattachements',
      'POST /rues/:id/couverture'],
    contestations: ['GET /motifs-contestation', 'GET /contestations',
      'GET /contestations/:id', 'POST /contestations',
      'POST /contestations/:id/instruire', 'POST /contestations/:id/resoudre'],
    taxes: ['GET /taxes/types', 'GET /taxes/baremes', 'POST /taxes/baremes',
      'GET /taxes/simuler/:commerceId', 'GET /taxes/exonerations'],
    fiscalite: ['GET /periodes', 'POST /periodes/:id/generer', 'GET /avis',
      'GET /avis/:id', 'GET /paiements', 'POST /paiements'],
    agents: ['GET /agents', 'POST /agents', 'GET /agents/:id/activite'],
    synchronisation: ['GET /sync/paquet', 'POST /sync/batch', 'GET /sync/conflits'],
    statistiques: ['GET /stats/tableau-bord', 'GET /stats/zones', 'GET /stats/recouvrement',
      'GET /stats/coherence'],
    audit: ['GET /audit', 'GET /audit/entite/:entite/:id', 'GET /audit/connexions'],
    documents: ['GET /quittances', 'GET /quittances/:id/pdf', 'GET /impression/stickers',
      'GET /impression/stickers/planche', 'POST /campagnes/:id/lancer',
      'POST /campagnes/relancer', 'GET /notifications/a-transmettre'],
    public: ['GET /public/commune/:slug', 'GET /c/:jeton', 'GET /public/quittance/:jeton'],
    portail_redevable: ['POST /portail/code', 'POST /portail/session',
      'POST /portail/deconnexion', 'GET /portail/dossier', 'GET /portail/avis/:id',
      'GET /portail/quittances', 'GET /portail/motifs-contestation',
      'POST /portail/contestations'],
    webhooks: ['POST /webhooks/wave'],
  },
}));

// ---------------------------------------------------------------------------
// 404 puis gestionnaire d'erreurs — toujours en dernier
// ---------------------------------------------------------------------------
app.use(routeInconnue);
app.use(gestionnaireErreurs);

module.exports = app;
