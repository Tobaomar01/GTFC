/**
 * Chargement et validation de la configuration.
 *
 * Le fichier .env vit à la RACINE du projet, pas dans apps/api : une seule
 * source de vérité pour Docker, PM2, les scripts de sauvegarde et l'API.
 *
 * La validation est stricte et bloquante : mieux vaut refuser de démarrer
 * avec un message clair que tourner trois semaines avec un JWT_SECRET par
 * défaut avant de s'en apercevoir.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '../../../..');
const CHEMIN_ENV = path.join(RACINE, '.env');

// --- Lecture du .env sans dépendance externe -------------------------------
function chargerFichierEnv(chemin) {
  if (!fs.existsSync(chemin)) return;
  for (const ligne of fs.readFileSync(chemin, 'utf8').split('\n')) {
    const m = ligne.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const valeur = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = valeur;
  }
}
chargerFichierEnv(CHEMIN_ENV);

// --- Aides -----------------------------------------------------------------
const erreurs = [];

function obligatoire(cle, { min = 1, motif = null } = {}) {
  const v = process.env[cle];
  if (!v || v.trim() === '') {
    erreurs.push(`${cle} est absent du .env`);
    return '';
  }
  if (v.includes('A_REMPLIR')) {
    erreurs.push(`${cle} contient encore la valeur d'exemple « A_REMPLIR »`);
    return '';
  }
  if (v.length < min) {
    erreurs.push(`${cle} fait ${v.length} caractères, il en faut au moins ${min}`);
    return '';
  }
  if (motif && !motif.test(v)) {
    erreurs.push(`${cle} n'a pas le format attendu`);
    return '';
  }
  return v;
}

const optionnel = (cle, defaut = null) => process.env[cle] ?? defaut;
const entier = (cle, defaut) => {
  const v = parseInt(process.env[cle] ?? '', 10);
  return Number.isFinite(v) ? v : defaut;
};
const booleen = (cle, defaut = false) => {
  const v = (process.env[cle] ?? '').toLowerCase();
  if (v === '') return defaut;
  return v === 'true' || v === '1' || v === 'on' || v === 'oui';
};

// --- Configuration ---------------------------------------------------------
const config = {
  racine: RACINE,
  env: optionnel('NODE_ENV', 'development'),
  production: optionnel('NODE_ENV', 'development') === 'production',
  timezone: optionnel('TZ', 'Africa/Dakar'),
  domaine: optionnel('APP_DOMAIN', 'localhost'),

  serveur: {
    port: entier('API_PORT', 4000),
    host: optionnel('API_HOST', '127.0.0.1'),
    // Nginx est le seul à parler à l'API : on lui fait confiance pour
    // X-Forwarded-For, sinon toutes les IP journalisées seraient celles
    // du conteneur Nginx.
    proxyDeConfiance: entier('API_TRUST_PROXY', 1),
    corsOrigines: (optionnel('CORS_ORIGINS', '') || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    tailleMaxRequete: optionnel('API_MAX_BODY', '2mb'),
  },

  bdd: {
    host: optionnel('DB_HOST', '127.0.0.1'),
    port: entier('DB_PORT', 5432),
    database: optionnel('DB_NAME', 'gtfc_taxes'),
    // L'API se connecte avec le rôle APPLICATIF, jamais avec le
    // superutilisateur : c'est ce qui rend les politiques RLS effectives.
    user: optionnel('DB_USER', 'gtfc_app'),
    password: '',
    maxConnexions: entier('DB_POOL_MAX', 12),
    delaiInactivite: entier('DB_POOL_IDLE_MS', 30000),
    delaiConnexion: entier('DB_POOL_TIMEOUT_MS', 8000),
  },

  jwt: {
    secret: '',
    dureeAcces: optionnel('JWT_ACCESS_TTL', '15m'),
    dureeRafraichissement: optionnel('JWT_REFRESH_TTL', '30d'),
    emetteur: 'gtfc-api',
  },

  securite: {
    tentativesAvantVerrouillage: entier('AUTH_MAX_TENTATIVES', 5),
    dureeVerrouillageMinutes: entier('AUTH_VERROUILLAGE_MIN', 15),
    // bcryptjs (implémentation JavaScript, sans compilation native sur le
    // Mini PC) : un coût de 10 demande ~250 ms, ce qui reste confortable à la
    // connexion tout en rendant une attaque par force brute impraticable.
    coutBcrypt: entier('BCRYPT_ROUNDS', 10),
  },

  stockage: {
    endpoint: optionnel('MINIO_ENDPOINT', '127.0.0.1'),
    port: entier('MINIO_PORT', 9000),
    ssl: booleen('MINIO_USE_SSL', false),
    accessKey: '',
    secretKey: '',
    region: optionnel('MINIO_REGION', 'us-east-1'),
    buckets: {
      photos: optionnel('MINIO_BUCKET_PHOTOS', 'gtfc-photos'),
      documents: optionnel('MINIO_BUCKET_DOCUMENTS', 'gtfc-documents'),
      qrcodes: optionnel('MINIO_BUCKET_QRCODES', 'gtfc-qrcodes'),
    },
    // Durée de vie d'une URL pré-signée. Assez pour afficher une photo,
    // trop court pour être partagée utilement hors de l'application.
    dureeUrlSigneeSecondes: entier('MINIO_URL_TTL', 900),
    tailleMaxPhotoOctets: entier('PHOTO_MAX_OCTETS', 25 * 1024 * 1024),
  },

  wave: {
    baseUrl: optionnel('WAVE_API_BASE_URL', 'https://api.wave.com'),
    apiKey: optionnel('WAVE_API_KEY', ''),
    webhookSecret: optionnel('WAVE_WEBHOOK_SECRET', ''),
    devise: optionnel('WAVE_CURRENCY', 'XOF'),
    environnement: optionnel('WAVE_ENVIRONMENT', 'sandbox'),
    actif: booleen('WAVE_ACTIF', false),
    // Mode bac à sable interne : aucun appel n'est fait à Wave, les liens de
    // paiement sont fabriqués localement et le webhook est déclenché à la main
    // (scripts/simuler-wave.js). Permet de valider toute la chaîne — avis,
    // encaissement, quittance, carte — avant d'avoir un compte Wave Business.
    simuler: booleen('WAVE_SIMULER', optionnel('WAVE_API_KEY', '') === ''),
    dureeLienHeures: entier('WAVE_LIEN_DUREE_H', 72),
  },

  sms: {
    // Aucun opérateur n'est raccordé à ce jour : les notifications restent en
    // file et sont transmises par les agents (notification.service.js), et
    // les codes à usage unique s'affichent dans le journal du serveur
    // (sms.service.js, mode simulation).
    //
    // Le jour où un opérateur est retenu : SMS_FOURNISSEUR=orange|generique,
    // SMS_BASE_URL, SMS_API_KEY, SMS_ACTIF=true. Aucun code ne change.
    fournisseur: optionnel('SMS_FOURNISSEUR', ''),
    actif: booleen('SMS_ACTIF', false) && Boolean(optionnel('SMS_FOURNISSEUR', '')),
    // Autoriser explicitement la SIMULATION en production. Sans elle, l'API
    // refuse de démarrer : voir le contrôle plus bas, et le commentaire de
    // sms.service.js qui l'annonçait depuis le début.
    simulerEnProduction: booleen('SMS_SIMULER_EN_PROD', false),
    expediteur: optionnel('SMS_EXPEDITEUR', 'MAIRIE'),
    baseUrl: optionnel('SMS_BASE_URL', ''),
    apiKey: optionnel('SMS_API_KEY', ''),
  },

  portail: {
    // Origines autorisées à appeler le portail redevable. Distinctes de
    // celles du dashboard : le portail est ouvert au public, le dashboard non.
    origines: (optionnel('PORTAIL_ORIGINS', '') || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Un portail ouvert sans opérateur SMS est un portail où personne ne peut
    // entrer. Il reste activable pour les essais : le code sort au journal.
    actif: booleen('PORTAIL_ACTIF', true),
  },

  journal: {
    niveau: optionnel('LOG_LEVEL', optionnel('NODE_ENV') === 'production' ? 'info' : 'debug'),
    fichier: optionnel('LOG_FILE', null),
  },
};

// --- Secrets, validés séparément pour un message d'erreur précis -----------
config.bdd.password = obligatoire('DB_PASSWORD', { min: 8 });
config.jwt.secret = obligatoire('JWT_SECRET', { min: 32 });
config.stockage.accessKey = obligatoire('MINIO_ACCESS_KEY', { min: 3 });
config.stockage.secretKey = obligatoire('MINIO_SECRET_KEY', { min: 8 });

if (config.production && config.serveur.corsOrigines.length === 0) {
  erreurs.push('CORS_ORIGINS doit lister les domaines du dashboard en production');
}
if (config.sms.actif && !config.sms.baseUrl) {
  erreurs.push('SMS_BASE_URL est obligatoire dès que SMS_ACTIF=true : '
    + 'sans URL de passerelle, aucun code d\'accès ne peut partir');
}
// Sans passerelle SMS, le code à usage unique est SIMULÉ : il est écrit dans
// le journal, et le portail le renvoie dans sa réponse HTTP pour permettre les
// essais. En production, cela signifie que quiconque connaît le numéro d'un
// commerçant peut demander un code, le lire dans la réponse, et ouvrir son
// dossier fiscal — montants dus, historique, adresse.
//
// SMS_ACTIF vaut faux par défaut. L'oubli est donc le cas le plus probable, et
// son coût est une usurpation d'identité silencieuse. On refuse de démarrer.
if (config.production && !config.sms.actif && !config.sms.simulerEnProduction) {
  erreurs.push('SMS_ACTIF=false en production : le code à usage unique serait '
    + 'renvoyé en clair dans la réponse HTTP, et n\'importe qui pourrait ouvrir '
    + 'le dossier d\'un redevable en connaissant son numéro. Raccordez une '
    + 'passerelle SMS, ou posez SMS_SIMULER_EN_PROD=true en connaissance de cause.');
}
if (config.wave.actif && !config.wave.webhookSecret) {
  erreurs.push('WAVE_WEBHOOK_SECRET est obligatoire dès que WAVE_ACTIF=true : '
    + 'sans lui, n\'importe qui pourrait déclarer un paiement');
}

if (erreurs.length > 0) {
  console.error('\n╔══════════════════════════════════════════════════════════════╗');
  console.error('║  CONFIGURATION INVALIDE — l\'API ne peut pas démarrer         ║');
  console.error('╚══════════════════════════════════════════════════════════════╝\n');
  for (const e of erreurs) console.error(`  ✗ ${e}`);
  console.error(`\n  Fichier concerné : ${CHEMIN_ENV}`);
  console.error('  Modèle           : .env.template');
  console.error('  Générer un secret : openssl rand -base64 48\n');
  process.exit(1);
}

module.exports = config;
