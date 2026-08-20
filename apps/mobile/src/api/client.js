/**
 * Client HTTP de l'API GTFC.
 *
 * Trois particularités liées au terrain :
 *
 *   1. DÉLAIS GÉNÉREUX — en 3G dans un marché couvert, une requête met parfois
 *      20 secondes. Couper à 5 s ferait échouer des synchronisations qui
 *      auraient abouti.
 *
 *   2. RAFRAÎCHISSEMENT AUTOMATIQUE — le jeton d'accès dure 15 minutes. Un
 *      agent ne doit jamais voir « session expirée » en pleine saisie : sur un
 *      401, on rafraîchit et on rejoue une fois, en silence.
 *
 *   3. ERREURS DISTINGUÉES — une panne réseau n'est pas un refus du serveur.
 *      La première se réessaie plus tard, la seconde jamais. Les confondre
 *      ferait boucler la synchronisation sur une donnée invalide.
 */
import Constants from 'expo-constants';

const URL_API = process.env.EXPO_PUBLIC_API_URL
  || Constants.expoConfig?.extra?.apiUrl
  || 'https://api.exemple.sn';

const DELAI_NORMAL = 20000;
const DELAI_SYNC = 120000;      // un lot de 100 opérations prend du temps
const DELAI_PHOTO = 180000;     // 2 Mo en 3G

/** Erreur venue du serveur : la requête est arrivée, elle a été refusée. */
export class ErreurApi extends Error {
  constructor(statut, code, message, details = null) {
    super(message);
    this.name = 'ErreurApi';
    this.statut = statut;
    this.code = code;
    this.details = details;
    this.duServeur = true;
  }
}

/** Erreur de transport : le serveur n'a rien reçu, ou rien répondu. */
export class ErreurReseau extends Error {
  constructor(message = 'Pas de connexion au serveur') {
    super(message);
    this.name = 'ErreurReseau';
    this.duReseau = true;
  }
}

// ---------------------------------------------------------------------------
// Gestion des jetons
// ---------------------------------------------------------------------------
let jetonAcces = null;
let jetonRafraichissement = null;
let surExpiration = null;         // rappel vers le contexte d'authentification
let rafraichissementEnCours = null;

export function definirJetons({ acces, rafraichissement }) {
  jetonAcces = acces ?? null;
  jetonRafraichissement = rafraichissement ?? null;
}

export function definirRappelExpiration(fn) { surExpiration = fn; }

export const jetonsCourants = () => ({ acces: jetonAcces, rafraichissement: jetonRafraichissement });

/**
 * Rafraîchit le jeton d'accès.
 * Mutualisé : si cinq requêtes échouent en même temps, une seule opération de
 * rafraîchissement part. Sans cela, quatre d'entre elles utiliseraient un
 * jeton de rafraîchissement déjà consommé — que le serveur interprète comme
 * un vol et qui couperait toutes les sessions de l'agent.
 */
async function rafraichir() {
  if (rafraichissementEnCours) return rafraichissementEnCours;
  if (!jetonRafraichissement) throw new ErreurApi(401, 'NON_AUTHENTIFIE', 'Session absente');

  rafraichissementEnCours = (async () => {
    try {
      const reponse = await fetch(`${URL_API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jeton_rafraichissement: jetonRafraichissement }),
        signal: AbortSignal.timeout(DELAI_NORMAL),
      });

      const corps = await reponse.json().catch(() => null);
      if (!reponse.ok) {
        // Le rafraîchissement a été refusé : la session est bel et bien finie.
        jetonAcces = null;
        jetonRafraichissement = null;
        if (surExpiration) surExpiration(corps?.erreur?.message);
        throw new ErreurApi(401, 'SESSION_EXPIREE',
          corps?.erreur?.message ?? 'Session expirée, reconnectez-vous');
      }

      jetonAcces = corps.donnees.jeton_acces;
      jetonRafraichissement = corps.donnees.jeton_rafraichissement;
      return corps.donnees;
    } finally {
      rafraichissementEnCours = null;
    }
  })();

  return rafraichissementEnCours;
}

// ---------------------------------------------------------------------------
// Requête
// ---------------------------------------------------------------------------
async function requete(methode, chemin, {
  corps, formulaire, delai = DELAI_NORMAL, avecJeton = true, rejouer = true,
} = {}) {
  const entetes = {};
  if (avecJeton && jetonAcces) entetes.Authorization = `Bearer ${jetonAcces}`;
  if (corps) entetes['Content-Type'] = 'application/json';
  // Pour un envoi multipart, on laisse fetch poser lui-même le Content-Type :
  // il doit contenir la « boundary », qu'on ne peut pas deviner.

  let reponse;
  try {
    reponse = await fetch(`${URL_API}${chemin}`, {
      method: methode,
      headers: entetes,
      body: formulaire ?? (corps ? JSON.stringify(corps) : undefined),
      signal: AbortSignal.timeout(delai),
    });
  } catch (err) {
    // TimeoutError, TypeError (DNS, coupure) : rien n'est arrivé au serveur.
    throw new ErreurReseau(
      err.name === 'TimeoutError'
        ? 'Le serveur met trop de temps à répondre'
        : 'Pas de connexion au serveur',
    );
  }

  if (reponse.status === 401 && rejouer && avecJeton && jetonRafraichissement) {
    await rafraichir();
    return requete(methode, chemin, { corps, formulaire, delai, avecJeton, rejouer: false });
  }

  const type = reponse.headers.get('content-type') || '';
  const corpsReponse = type.includes('application/json')
    ? await reponse.json().catch(() => null)
    : await reponse.text().catch(() => null);

  if (!reponse.ok) {
    const e = corpsReponse?.erreur ?? {};
    throw new ErreurApi(
      reponse.status,
      e.code ?? 'ERREUR',
      e.message ?? `Erreur ${reponse.status}`,
      e.details ?? null,
    );
  }

  // 207 : succès partiel de synchronisation, la charge utile est exploitable
  return corpsReponse?.donnees ?? corpsReponse;
}

const get = (chemin, opts) => requete('GET', chemin, opts);
const post = (chemin, corps, opts) => requete('POST', chemin, { corps, ...opts });
const patch = (chemin, corps, opts) => requete('PATCH', chemin, { corps, ...opts });

// ---------------------------------------------------------------------------
// Endpoints utilisés par l'application
// ---------------------------------------------------------------------------
export const api = {
  urlBase: URL_API,

  /** Vérifie que le serveur répond, sans authentification ni jeton. */
  async joignable() {
    try {
      await requete('GET', '/healthz', { avecJeton: false, delai: 6000 });
      return true;
    } catch {
      return false;
    }
  },

  // --- Authentification ---------------------------------------------------
  connexion: (donnees) => post('/auth/login', donnees, { avecJeton: false, rejouer: false }),
  deconnexion: (jeton) => post('/auth/logout', { jeton_rafraichissement: jeton },
    { rejouer: false }).catch(() => null),
  profil: () => get('/auth/moi'),
  changerMotDePasse: (ancien, nouveau) => post('/auth/mot-de-passe', {
    ancien_mot_de_passe: ancien, nouveau_mot_de_passe: nouveau,
  }),

  // --- Synchronisation ----------------------------------------------------
  paquetHorsLigne: (depuis, zoneId) => {
    const p = new URLSearchParams();
    if (depuis) p.set('depuis', depuis);
    if (zoneId) p.set('zone_id', zoneId);
    const q = p.toString();
    return get(`/sync/paquet${q ? `?${q}` : ''}`, { delai: DELAI_SYNC });
  },
  envoyerLot: (lot) => post('/sync/batch', lot, { delai: DELAI_SYNC }),

  // --- Commerces ----------------------------------------------------------
  creerCommerce: (donnees) => post('/commerces', donnees),
  modifierCommerce: (id, donnees) => patch(`/commerces/${id}`, donnees),
  detailCommerce: (id) => get(`/commerces/${id}`),
  commercesProches: (longitude, latitude, rayon = 100) => get(
    `/commerces/proches?longitude=${longitude}&latitude=${latitude}&rayon_m=${rayon}`),
  enregistrerVisite: (id, donnees) => post(`/commerces/${id}/visite`, donnees),

  /** Envoi d'une photo. FormData : c'est ce qu'attend multer côté serveur. */
  envoyerPhoto: (commerceId, formulaire) => requete(
    'POST', `/commerces/${commerceId}/photos`, { formulaire, delai: DELAI_PHOTO }),

  // --- Taxes et paiements -------------------------------------------------
  simulerTaxes: (commerceId) => get(`/taxes/simuler/${commerceId}`),
  creerPaiement: (donnees) => post('/paiements', donnees),
  avisDuCommerce: (commerceId) => get(`/avis?commerce_id=${commerceId}&limite=12`),
  lienPaiementWave: (avisId, telephone) => post(`/avis/${avisId}/lien-paiement`,
    telephone ? { telephone } : {}),

  // --- QR -----------------------------------------------------------------
  scanPublic: (jetonQr) => requete('GET', `/public/c/${jetonQr}`, { avecJeton: false }),
};

export { requete, get, post, patch, URL_API };
