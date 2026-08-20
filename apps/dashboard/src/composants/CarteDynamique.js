'use client';

/**
 * Enveloppe de chargement dynamique de la carte.
 *
 * Leaflet accède à `window` dès son import : sans `ssr: false`, le rendu côté
 * serveur de Next.js échoue avec « window is not defined ». C'est le piège
 * classique de Leaflet dans l'App Router.
 */
import dynamic from 'next/dynamic';

const CarteDynamique = dynamic(() => import('./Carte'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center rounded-carte border border-bordure bg-surface-alt text-sm text-encre-2"
      style={{ height: 560 }}
    >
      Chargement de la carte…
    </div>
  ),
});

export default CarteDynamique;
