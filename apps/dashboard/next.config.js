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
