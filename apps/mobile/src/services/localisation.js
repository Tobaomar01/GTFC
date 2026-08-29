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

/** Distance approximative entre deux points, en mètres. */
function distanceM(a, b) {
  const R = 6371000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat = ((a.latitude + b.latitude) / 2) * (Math.PI / 180);
  const x = dLon * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/**
 * Agrège des mesures en une position.
 *
 * Écarte les aberrantes, pondère par la précision annoncée, et retourne
 * comme précision la DISPERSION réellement observée.
 */
export function agreger(mesures) {
  if (mesures.length === 0) return null;
  if (mesures.length === 1) {
    const m = mesures[0];
    return {
      longitude: m.longitude, latitude: m.latitude,
      precision_gps_m: m.precision, nb_mesures: 1,
      origine: 'satellite', releve_le: m.releve_le,
    };
  }

  // Médiane comme point de référence : contrairement à la moyenne, une
  // mesure à 500 m ne la déplace pas.
  const med = (xs) => {
    const t = [...xs].sort((a, b) => a - b);
    const i = Math.floor(t.length / 2);
    return t.length % 2 ? t[i] : (t[i - 1] + t[i]) / 2;
  };
  const centre = {
    longitude: med(mesures.map((m) => m.longitude)),
    latitude: med(mesures.map((m) => m.latitude)),
  };

  // Une mesure à plus de 100 m de la médiane vient du réseau mobile, pas du
  // GPS. On l'écarte plutôt que de la laisser polluer la moyenne.
  const retenues = mesures.filter((m) => distanceM(centre, m) <= 100);
  const utiles = retenues.length >= 2 ? retenues : mesures;

  let sommePoids = 0; let sx = 0; let sy = 0;
  for (const m of utiles) {
    const poids = 1 / Math.max(1, m.precision) ** 2;
    sommePoids += poids;
    sx += m.longitude * poids;
    sy += m.latitude * poids;
  }
  const moyenne = { longitude: sx / sommePoids, latitude: sy / sommePoids };

  // Dispersion : écart quadratique moyen des mesures au point retenu. C'est
  // une mesure honnête de ce qu'on sait, là où la précision annoncée par le
  // capteur est souvent optimiste.
  const ecarts = utiles.map((m) => distanceM(moyenne, m));
  const dispersion = Math.sqrt(
    ecarts.reduce((s, e) => s + e * e, 0) / ecarts.length);

  // On ne prétend jamais faire mieux que la meilleure mesure annoncée : la
  // moyenne réduit l'erreur aléatoire, pas le biais commun à toutes.
  const plancher = Math.min(...utiles.map((m) => m.precision)) / Math.sqrt(utiles.length);

  return {
    longitude: moyenne.longitude,
    latitude: moyenne.latitude,
    precision_gps_m: Math.max(dispersion, plancher, 3),
    nb_mesures: utiles.length,
    nb_ecartees: mesures.length - utiles.length,
    origine: 'satellite',
    releve_le: utiles[utiles.length - 1].releve_le,
  };
}

/**
 * Relève une position en MOYENNANT plusieurs mesures.
 *
 * L'ancienne version gardait la meilleure mesure. C'était insuffisant :
 * l'erreur GPS est en grande partie aléatoire d'une mesure à l'autre, si
 * bien qu'une seule mesure — fût-ce la mieux notée — reste dispersée autour
 * de la vraie position.
 *
 * Moyenner N mesures divise l'erreur aléatoire par la racine de N : vingt
 * mesures la réduisent d'un facteur quatre. Sur un relevé annoncé à 30 m,
 * cela ramène l'écart réel vers 7 à 8 m — assez pour désigner le bon
 * bâtiment, à défaut de la bonne devanture.
 *
 * Trois précautions rendent la moyenne fiable :
 *
 *   · les mesures aberrantes sont écartées. Le premier point renvoyé par
 *     Android vient souvent du réseau mobile et se trompe de 500 m : le
 *     moyenner ruinerait tout ;
 *   · chaque mesure pèse selon sa précision annoncée, une mesure à 5 m
 *     comptant plus qu'une à 40 m ;
 *   · la précision retenue est celle de la DISPERSION observée, non celle
 *     que le capteur annonce. Annoncer 5 m parce qu'on a moyenné, alors que
 *     les mesures s'étalent sur 30 m, serait mentir à l'agent.
 */
export async function releverPosition({
  precisionVisee = PRECISION_ACCEPTABLE_M,
  delaiMaxMs = 20000,
  mesuresVisees = 12,
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
  const mesures = [];

  while (Date.now() - debut < delaiMaxMs && mesures.length < mesuresVisees) {
    let position;
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
        mayShowUserSettingsDialog: false,
      });
    } catch {
      break;   // on sortira avec ce qui a déjà été collecté
    }

    mesures.push({
      longitude: position.coords.longitude,
      latitude: position.coords.latitude,
      precision: position.coords.accuracy ?? 9999,
      releve_le: new Date(position.timestamp).toISOString(),
    });

    const provisoire = agreger(mesures);
    if (surProgression) {
      surProgression({
        precision: provisoire?.precision_gps_m ?? null,
        mesures: mesures.length,
        ecoule_ms: Date.now() - debut,
        suffisante: (provisoire?.precision_gps_m ?? 9999) <= precisionVisee,
      });
    }

    // On ne s'arrête pas au premier point acceptable : c'est justement en
    // continuant que la moyenne devient meilleure qu'une mesure isolée.
    if (mesures.length >= 6 && (provisoire?.precision_gps_m ?? 9999) <= precisionVisee / 2) break;

    await new Promise((r) => { setTimeout(r, 900); });
  }

  const meilleure = agreger(mesures);

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
