// ===========================================================================
//  PM2 — services applicatifs de la plateforme GTFC
//
//  L'infrastructure (PostgreSQL, MinIO, Nginx, Certbot) tourne dans Docker.
//  L'API et le dashboard tournent directement sur l'hôte, gérés par PM2 :
//  redémarrage automatique après une coupure de courant, rechargement sans
//  interruption lors des mises à jour, journaux centralisés.
//
//  Les trois services sont livrés. Le dashboard exige un `npm run build`
//  préalable dans apps/dashboard : PM2 lance `next start`, qui refuse de
//  démarrer sans build de production.
//
//  Commandes :
//      pm2 start ecosystem.config.js     # démarrer
//      pm2 reload ecosystem.config.js    # recharger sans coupure
//      pm2 status / pm2 logs / pm2 monit
//      pm2 save                          # figer l'état pour le redémarrage auto
// ===========================================================================

const path = require('path');
const fs = require('fs');

// Chargement du .env sans dépendre d'un paquet npm : ce fichier doit rester
// utilisable avant même le premier `npm install`.
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

/** Nombre d'instances de l'API : une par cœur, plafonné à 4.
 *  Au-delà, ce sont PostgreSQL et le disque qui limitent, pas le CPU. */
const API_INSTANCES = Math.min(require('os').cpus().length, 4);

module.exports = {
  apps: [
    // -----------------------------------------------------------------------
    // API Node.js / Express — phase 3
    // -----------------------------------------------------------------------
    {
      name: 'gtfc-api',
      cwd: path.join(__dirname, 'apps/api'),
      script: 'src/server.js',

      // Mode cluster : plusieurs processus derrière le même port, PM2 répartit
      // les connexions. Indispensable les jours de synchronisation massive.
      exec_mode: 'cluster',
      instances: API_INSTANCES,

      env: {
        NODE_ENV: 'production',
        PORT: process.env.API_PORT || 4000,
        HOST: process.env.API_HOST || '127.0.0.1',
        TZ: process.env.TZ || 'Africa/Dakar',
      },

      // Redémarrages
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 4000,
      exp_backoff_restart_delay: 200,

      // Un processus qui dépasse 700 Mo a fui : PM2 le remplace proprement.
      max_memory_restart: '700M',

      // Arrêt en douceur : on laisse 8 s pour terminer les requêtes en cours
      // (une synchronisation d'agent ne doit pas être coupée en plein vol).
      kill_timeout: 8000,
      listen_timeout: 10000,
      wait_ready: true,

      // Journaux
      output: '/var/log/gtfc/api-out.log',
      error: '/var/log/gtfc/api-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      watch: false,
    },

    // -----------------------------------------------------------------------
    // Dashboard web Next.js — phase 6
    // -----------------------------------------------------------------------
    {
      name: 'gtfc-dashboard',
      cwd: path.join(__dirname, 'apps/dashboard'),
      script: 'node_modules/next/dist/bin/next',
      args: 'start',

      // Next.js en mode fork : le serveur Next gère lui-même la concurrence.
      exec_mode: 'fork',
      instances: 1,

      env: {
        NODE_ENV: 'production',
        PORT: process.env.DASHBOARD_PORT || 3000,
        HOSTNAME: process.env.DASHBOARD_HOST || '127.0.0.1',
        TZ: process.env.TZ || 'Africa/Dakar',
        // Le dashboard appelle l'API depuis le SERVEUR (routes /api/proxy),
        // jamais depuis le navigateur : 127.0.0.1 suffit.
        API_URL: `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 4000}`,
        APP_DOMAIN: process.env.APP_DOMAIN,
        COOKIES_SECURE: 'true',
        // Aucun appel sortant : la plateforme est auto-hébergée.
        NEXT_TELEMETRY_DISABLED: '1',
      },

      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 4000,
      max_memory_restart: '1G',
      kill_timeout: 5000,

      output: '/var/log/gtfc/dashboard-out.log',
      error: '/var/log/gtfc/dashboard-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      watch: false,
    },

    // -----------------------------------------------------------------------
    // Tâches planifiées applicatives — phase 5
    // Génération mensuelle des demandes de paiement Wave, relances, quittances.
    // Une seule instance : un envoi de facture ne doit jamais être dupliqué.
    // -----------------------------------------------------------------------
    {
      name: 'gtfc-scheduler',
      cwd: path.join(__dirname, 'apps/api'),
      script: 'src/scheduler.js',

      exec_mode: 'fork',
      instances: 1,

      env: {
        NODE_ENV: 'production',
        TZ: process.env.TZ || 'Africa/Dakar',
      },

      autorestart: true,
      max_restarts: 10,
      min_uptime: '60s',
      restart_delay: 10000,
      max_memory_restart: '400M',

      output: '/var/log/gtfc/scheduler-out.log',
      error: '/var/log/gtfc/scheduler-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      watch: false,
    },
  ],
};
