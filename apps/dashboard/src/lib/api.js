'use client';

/**
 * Client HTTP de l'interface.
 *
 * Tout passe par `/api/proxy/...` — même origine, cookie httpOnly. Aucun jeton
 * n'existe côté navigateur, donc rien à stocker, rien à rafraîchir ici.
 */

export class ErreurApi extends Error {
  constructor(statut, code, message, details = null) {
    super(message);
    this.statut = statut;
    this.code = code;
    this.details = details;
  }
}

async function requete(methode, chemin, corps) {
  const reponse = await fetch(`/api/proxy${chemin}`, {
    method: methode,
    headers: corps ? { 'Content-Type': 'application/json' } : {},
    body: corps ? JSON.stringify(corps) : undefined,
  });

  const resultat = await reponse.json().catch(() => null);

  if (!reponse.ok) {
    // Session finie : on repart sur la connexion plutôt que d'afficher une
    // erreur que l'utilisateur ne peut pas résoudre.
    if (reponse.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/connexion?expiree=1';
    }
    const e = resultat?.erreur ?? {};
    throw new ErreurApi(reponse.status, e.code ?? 'ERREUR',
      e.message ?? `Erreur ${reponse.status}`, e.details);
  }

  return resultat?.donnees ?? resultat;
}

const parametres = (obj = {}) => {
  const p = new URLSearchParams();
  for (const [cle, valeur] of Object.entries(obj)) {
    if (valeur !== undefined && valeur !== null && valeur !== '') p.set(cle, String(valeur));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/**
 * Une route sans barre oblique initiale collerait au préfixe :
 * `/api/proxy` + `redevables` donne `/api/proxyredevables`, qui n'existe
 * pas. L'erreur est invisible à la compilation — c'est une chaîne — et ne se
 * voit qu'en ouvrant la page. On la rattrape ici une fois pour toutes.
 */
const normaliser = (chemin) => (chemin.startsWith('/') ? chemin : `/${chemin}`);

export const api = {
  get: (chemin, params) => requete('GET', normaliser(chemin) + parametres(params)),
  post: (chemin, corps) => requete('POST', normaliser(chemin), corps),
  patch: (chemin, corps) => requete('PATCH', normaliser(chemin), corps),
  delete: (chemin, corps) => requete('DELETE', normaliser(chemin), corps),

  /** Réponse complète, pour lire la pagination. */
  async liste(chemin, params) {
    const reponse = await fetch(`/api/proxy${normaliser(chemin)}${parametres(params)}`);
    const resultat = await reponse.json().catch(() => null);
    if (!reponse.ok) {
      if (reponse.status === 401 && typeof window !== 'undefined') {
        window.location.href = '/connexion?expiree=1';
      }
      throw new ErreurApi(reponse.status, resultat?.erreur?.code,
        resultat?.erreur?.message ?? 'Erreur');
    }
    return { lignes: resultat?.donnees ?? [], pagination: resultat?.pagination ?? null };
  },

  /**
   * Téléchargement d'un fichier produit par l'API.
   * Le nom vient de l'en-tête Content-Disposition : c'est l'API qui décide,
   * l'interface n'invente pas de nom de fichier.
   */
  async telecharger(chemin, params) {
    const reponse = await fetch(`/api/proxy${chemin}${parametres(params)}`);
    if (!reponse.ok) {
      const resultat = await reponse.json().catch(() => null);
      throw new ErreurApi(reponse.status, resultat?.erreur?.code,
        resultat?.erreur?.message ?? 'Export impossible');
    }

    const disposition = reponse.headers.get('content-disposition') ?? '';
    const nom = (disposition.match(/filename="([^"]+)"/) || [])[1] ?? 'export';
    const tronque = reponse.headers.get('x-tronque') === 'true';

    const blob = await reponse.blob();
    const url = URL.createObjectURL(blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = nom;
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    URL.revokeObjectURL(url);

    return { nom, tronque, nbLignes: Number(reponse.headers.get('x-nb-lignes')) || null };
  },

  /** Ouvre un PDF dans un nouvel onglet plutôt que de le télécharger. */
  ouvrirPdf(chemin, params) {
    window.open(`/api/proxy${chemin}${parametres(params)}`, '_blank', 'noopener');
  },
};

export async function deconnexion() {
  await fetch('/api/session', { method: 'DELETE' });
  window.location.href = '/connexion';
}

/** Profil courant, lu dans le cookie non-httpOnly posé à la connexion. */
export function profilCourant() {
  if (typeof document === 'undefined') return null;
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('gtfc_profil='));
  if (!cookie) return null;
  try { return JSON.parse(decodeURIComponent(cookie.slice('gtfc_profil='.length))); } catch { return null; }
}
