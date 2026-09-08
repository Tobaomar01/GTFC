/**
 * Configuration Next.js.
 *
 * Le dashboard tourne derrière Nginx, sur l'hôte, via PM2 (voir
 * ecosystem.config.js). Il ne parle JAMAIS directement à l'API depuis le
 * navigateur : tout passe par ses propres routes /api/proxy, qui portent le
 * jeton dans un cookie httpOnly. Voir src/app/api/proxy pour le pourquoi.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Les outils de developpement de Next occupent la moitie d'un ecran de
  // telephone : sur un essai en conditions reelles, le panneau « Static Route »
  // recouvrait le dossier du redevable pendant son chargement. Ils n'existent
  // qu'en developpement — les eteindre ne change rien a la production, et rend
  // les essais sur mobile lisibles.
  devIndicators: false,

  // Depuis qu'un package-lock.json existe A LA RACINE du depot — pose pour
  // rendre « npm run defauts » reproductible — Next voit deux fichiers de
  // verrouillage et DEVINE la racine du projet. Il s'en plaint a chaque
  // demarrage, et une racine mal devinee change ce qu'il embarque. On la lui
  // dit, plutot que de le laisser choisir.
  turbopack: { root: __dirname },

  // « next dev » de Next 16 n'autorise que « localhost » comme origine : servi
  // sur 127.0.0.1 — l'adresse employée partout ailleurs dans le projet — il
  // renvoie 403 sur ses propres morceaux de JavaScript. La page s'affiche,
  // mais morte : le formulaire de connexion repart alors en GET natif, et les
  // tests de navigateur attendent une redirection qui ne viendra pas.
  // Option de développement seule : « next start » ne la lit pas.
  // L'adresse du poste sur le reseau local s'ajoute par DEV_ORIGINES_AUTORISEES
  // (separees par des virgules). Sans elle, un telephone qui ouvre le portail
  // recoit 403 sur les morceaux de JavaScript : la page s'affiche, mais MORTE —
  // exactement le defaut corrige ce matin sur la page de connexion. L'adresse
  // n'est pas codee en dur : elle change avec le reseau.
  allowedDevOrigins: [
    '127.0.0.1',
    ...(process.env.DEV_ORIGINES_AUTORISEES ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  ],

  // L'application est servie sur le serveur de la commune : on n'expose pas la
  // version de Next dans les en-têtes.
  poweredByHeader: false,

  // Pas de mode 'standalone' : il impose de recopier à la main .next/static
  // et public dans .next/standalone, et 'next start' refuse alors de démarrer.
  // Sur un serveur de mairie, moins d'étapes manuelles vaut mieux qu'un
  // bundle plus compact.

  // Les tuiles OpenStreetMap sont le SEUL appel sortant du dashboard.
  images: { unoptimized: true },

  async headers() {
    return [{
      source: '/:chemin*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        // Tout est servi localement, tuiles cartographiques comprises.
        // Aucune origine externe n'est autorisée : la politique le dit, et
        // le navigateur le fait respecter même si un développeur réintroduit
        // par mégarde une URL distante.
        {
          key: 'Content-Security-Policy',
          value: [
            "default-src 'self'",
            "img-src 'self' data: blob:",
            "style-src 'self' 'unsafe-inline'",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        },
      ],
    }];
  },
};

module.exports = nextConfig;
