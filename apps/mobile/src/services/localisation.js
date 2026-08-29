/**
 * Géolocalisation.
 *
 * Point crucial du projet : un commerce mal positionné fausse durablement les
 * statistiques de la mairie et peut le rattacher au mauvais quartier — donc au
 * mauvais barème TODP. On préfère faire patienter l'agent quelques secondes
 * plutôt qu'enregistrer une position approximative.
 *
 * Rappel d'ordre : PostGIS et cette application travaillent en
 * (longitude, latitude). Expo renvoie `{ latitude, longitude }` — l'inversion
 * est l'erreur la plus courante et la plus difficile à repérer après coup.
 * Le Sénégal a une longitude NÉGATIVE (~-17) et une latitude POSITIVE (~14).
 */
import * as Location from 'expo-location';
import { distanceMetres } from '../bdd/commerces.repo';
import { lireReferentiel } from '../bdd/sync.repo';

/**
 * Seuil d'arrêt de la recherche de signal, non seuil de qualité finale.
 *
 * Trente mètres ne suffisent pas à désigner UNE devanture parmi dix : c'est
 * pourquoi l'agent ajuste ensuite le point sur la carte (voir
 * composants/carte-position.js). Le GPS sert à centrer la vue, l'œil de
 * l'agent fait le reste.
 *
 * Durcir ce seuil serait contre-productif : sous les tôles d'un marché, un
 * téléphone ne l'atteindrait jamais et le recensement s'arrêterait.
 */
export const PRECISION_ACCEPTABLE_M = 30;
export const PRECISION_MEDIOCRE_M = 60;

/** Bornes du Sénégal — garde-fou contre l'inversion des coordonnées. */
const BORNES_SENEGAL = { lonMin: -18, lonMax: -11, latMin: 12, latMax: 17 };

export function coordonneesPlausibles(longitude, latitude) {
  return longitude >= BORNES_SENEGAL.lonMin && longitude <= BORNES_SENEGAL.lonMax
    && latitude >= BORNES_SENEGAL.latMin && latitude <= BORNES_SENEGAL.latMax;
}

export async function demanderAutorisation() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return status === 'granted';
}

export async function autorisationAccordee() {
  const { status } = await Location.getForegroundPermissionsAsync();
  return status === 'granted';
}

export async function serviceActif() {
  return Location.hasServicesEnabledAsync();
}

/**
 * Relève une position en cherchant la meilleure précision possible.
 *
 * Le premier point renvoyé par Android est souvent issu du réseau mobile et
 * précis à 500 m. On prend donc plusieurs mesures et on garde la meilleure,
 * en s'arrêtant dès qu'elle est satisfaisante.
 */
export async function releverPosition({
  precisionVisee = PRECISION_ACCEPTABLE_M,
  delaiMaxMs = 15000,
  surProgression = null,
} = {}) {
  if (!(await autorisationAccordee())) {
    const accordee = await demanderAutorisation();
    if (!accordee) {
      const err = new Error(
        'Autorisation de localisation refusée. Activez-la dans les réglages du téléphone.');
      err.code = 'AUTORISATION_REFUSEE';
      throw err;
    }
  }

  if (!(await serviceActif())) {
    const err = new Error('Le GPS du téléphone est désactivé. Activez-le puis réessayez.');
    err.code = 'GPS_DESACTIVE';
    throw err;
  }

  const debut = Date.now();
  let meilleure = null;

  while (Date.now() - debut < delaiMaxMs) {
    let position;
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: false,
      });
    } catch {
      break;   // on sortira avec la meilleure mesure déjà obtenue, s'il y en a
    }

    const mesure = {
      longitude: position.coords.longitude,
      latitude: position.coords.latitude,
      precision_gps_m: position.coords.accuracy ?? null,
      altitude: position.coords.altitude ?? null,
      releve_le: new Date(position.timestamp).toISOString(),
    };

    if (!meilleure || (mesure.precision_gps_m ?? 9999) < (meilleure.precision_gps_m ?? 9999)) {
      meilleure = mesure;
    }

    if (surProgression) {
      surProgression({
        precision: meilleure.precision_gps_m,
        ecoule_ms: Date.now() - debut,
        suffisante: (meilleure.precision_gps_m ?? 9999) <= precisionVisee,
      });
    }

    if ((meilleure.precision_gps_m ?? 9999) <= precisionVisee) break;

    await new Promise((r) => { setTimeout(r, 1200); });
  }

  if (!meilleure) {
    const err = new Error(
      'Impossible d\'obtenir une position. Sortez à l\'air libre et réessayez.');
    err.code = 'POSITION_INDISPONIBLE';
    throw err;
  }

  if (!coordonneesPlausibles(meilleure.longitude, meilleure.latitude)) {
    const err = new Error(
      `Position aberrante relevée (${meilleure.longitude.toFixed(4)}, `
      + `${meilleure.latitude.toFixed(4)}). Elle est hors du Sénégal — n'enregistrez pas.`);
    err.code = 'POSITION_ABERRANTE';
    throw err;
  }

  return meilleure;
}

export function qualitePosition(precisionM) {
  if (precisionM == null) return { niveau: 'inconnue', libelle: 'Précision inconnue', couleur: '#888' };
  if (precisionM <= PRECISION_ACCEPTABLE_M) {
    return { niveau: 'bonne', libelle: `Précision ${Math.round(precisionM)} m`, couleur: '#1D7A45' };
  }
  if (precisionM <= PRECISION_MEDIOCRE_M) {
    return { niveau: 'moyenne', libelle: `Précision ${Math.round(precisionM)} m — approchez-vous`, couleur: '#C77700' };
  }
  return {
    niveau: 'mauvaise',
    libelle: `Précision ${Math.round(precisionM)} m — trop imprécis`,
    couleur: '#B3261E',
  };
}

/**
 * Détermine le quartier hors ligne.
 *
 * Le serveur fait mieux : il dispose des POLYGONES et sait dire si le point est
 * réellement dans le quartier (PostGIS). Le téléphone, lui, ne reçoit que le
 * centre de chaque quartier — envoyer les polygones alourdirait le paquet
 * hors-ligne sans grand bénéfice.
 *
 * On se contente donc de PROPOSER le quartier le plus proche, en le présentant
 * comme une suggestion. Le rattachement définitif est fait par le serveur à la
 * synchronisation. Ne jamais présenter cette estimation comme une certitude :
 * un mauvais rattachement change le barème appliqué.
 */
export async function suggererQuartier(longitude, latitude) {
  const quartiers = await lireReferentiel('quartiers', []);
  if (quartiers.length === 0) return null;

  const avecDistance = quartiers
    .filter((q) => q.longitude != null && q.latitude != null)
    .map((q) => ({ ...q, distance_m: distanceMetres(latitude, longitude, q.latitude, q.longitude) }))
    .sort((a, b) => a.distance_m - b.distance_m);

  if (avecDistance.length === 0) return null;

  const premier = avecDistance[0];
  const second = avecDistance[1];

  return {
    quartier: premier,
    alternatives: avecDistance.slice(1, 4),
    // Si deux quartiers sont à distance comparable, la suggestion n'est pas
    // fiable : l'interface doit inviter l'agent à choisir lui-même.
    fiable: !second || (second.distance_m - premier.distance_m) > 150,
    distance_m: premier.distance_m,
  };
}

/** Liste des quartiers triée par proximité — pour la liste déroulante. */
export async function quartiersParProximite(longitude, latitude) {
  const quartiers = await lireReferentiel('quartiers', []);
  if (longitude == null || latitude == null) return quartiers;
  return quartiers
    .map((q) => ({
      ...q,
      distance_m: q.longitude != null
        ? distanceMetres(latitude, longitude, q.latitude, q.longitude)
        : Infinity,
    }))
    .sort((a, b) => a.distance_m - b.distance_m);
}
