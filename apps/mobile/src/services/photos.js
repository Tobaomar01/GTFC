/**
 * Photos : capture, compression, conservation locale, envoi.
 *
 * Contrainte dominante : la bande passante. Une photo brute d'un Android récent
 * pèse 4 à 8 Mo. Envoyer 2 photos par commerce sur 5 443 commerces en 3G
 * représenterait des dizaines de gigaoctets et des semaines de synchronisation.
 *
 * On réduit donc à 1600 px de large en JPEG qualité 0,7 : environ 300 Ko, ce
 * qui reste largement suffisant pour identifier une devanture, lire une
 * enseigne ou constater un débordement sur trottoir.
 *
 * La compression a lieu AU MOMENT DE LA PRISE, pas à l'envoi : le fichier
 * lourd n'occupe jamais durablement le stockage du téléphone.
 */
// Le SDK 54 a réécrit expo-file-system autour de File et Directory, et a
// déplacé l'API historique — getInfoAsync, moveAsync, documentDirectory et
// consorts — sous « /legacy ». Ce module en emploie six fonctions, toutes
// présentes là. On garde donc l'API historique pour l'instant : le passage à
// la nouvelle mérite d'être fait pour elle-même, pas glissé dans une montée
// de SDK où l'on ne saurait plus attribuer une régression.
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as sync from '../bdd/sync.repo';
import { journaliser } from '../bdd/database';

const DOSSIER_PHOTOS = `${FileSystem.documentDirectory}photos/`;

export const LARGEUR_MAX = 1600;
export const QUALITE_JPEG = 0.7;

/** Types de photos, alignés sur l'énumération `app.type_photo` du serveur. */
export const TYPES_PHOTO = {
  devanture: { libelle: 'Devanture', obligatoire: true,
    aide: 'Cadrez la façade entière, enseigne comprise' },
  trottoir_todp: { libelle: 'Occupation du trottoir', obligatoire: false,
    aide: 'Montrez le débordement sur le domaine public, avec la rue visible' },
  enseigne: { libelle: 'Enseigne', obligatoire: false,
    aide: 'Cadrez le panneau ou l\'enseigne à taxer' },
  document: { libelle: 'Document', obligatoire: false,
    aide: 'Patente existante, pièce d\'identité du gérant' },
  // Un dispositif d'affichage se photographie DANS SON CONTEXTE : un cliché
  // serré sur le panneau ne permet à personne, six mois plus tard, de dire
  // s'il faisait 2 ou 6 m² — donc de défendre le montant facturé.
  facade: { libelle: 'Façade entière', obligatoire: false,
    aide: 'Reculez pour cadrer toute la devanture, pas seulement le support' },
  chantier: { libelle: 'Occupation constatée', obligatoire: false,
    aide: 'Cadrez l\'emprise au sol : c\'est elle qui sera mesurée' },
  autre: { libelle: 'Autre', obligatoire: false, aide: '' },
};

async function assurerDossier() {
  const info = await FileSystem.getInfoAsync(DOSSIER_PHOTOS);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DOSSIER_PHOTOS, { intermediates: true });
  }
}

/**
 * Compresse une photo puis la range dans le stockage de l'application.
 *
 * `uriSource` provient de la caméra ou de la galerie. Le fichier d'origine
 * n'est pas conservé : à 6 Mo pièce, il saturerait un téléphone d'entrée de
 * gamme en une centaine de commerces.
 */
export async function preparerPhoto(uriSource, { commerceLocal, commerceId, type,
  longitude, latitude, precisionGps, commentaire } = {}) {
  await assurerDossier();

  const resultat = await ImageManipulator.manipulateAsync(
    uriSource,
    [{ resize: { width: LARGEUR_MAX } }],
    { compress: QUALITE_JPEG, format: ImageManipulator.SaveFormat.JPEG },
  );

  const nom = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const destination = `${DOSSIER_PHOTOS}${nom}`;
  await FileSystem.moveAsync({ from: resultat.uri, to: destination });

  const info = await FileSystem.getInfoAsync(destination, { size: true });

  const idLocal = await sync.enregistrerPhoto({
    commerceLocal,
    commerceId,
    type,
    chemin: destination,
    tailleOctets: info.size ?? null,
    longitude,
    latitude,
    precisionGps,
    commentaire,
  });

  await journaliser('info', 'Photo enregistrée localement', {
    type, taille_ko: Math.round((info.size ?? 0) / 1024),
  });

  return {
    id_local: idLocal,
    chemin: destination,
    taille_octets: info.size ?? null,
    largeur: resultat.width,
    hauteur: resultat.height,
  };
}

/**
 * Envoie une photo au serveur.
 *
 * FormData avec un objet `{ uri, name, type }` : c'est la forme que React
 * Native sait transformer en multipart. Passer un Blob comme sur le web ne
 * fonctionne pas de façon fiable ici.
 */
export async function envoyerPhoto(photo, api) {
  const info = await FileSystem.getInfoAsync(photo.chemin_fichier);
  if (!info.exists) {
    // Fichier disparu (nettoyage Android, mémoire pleine) : inutile de
    // réessayer indéfiniment, on classe et on signale.
    await sync.echecPhoto(photo.id_local, 'Fichier introuvable sur le téléphone');
    throw new Error('Fichier photo introuvable');
  }

  const formulaire = new FormData();
  formulaire.append('photo', {
    uri: photo.chemin_fichier,
    name: photo.chemin_fichier.split('/').pop(),
    type: 'image/jpeg',
  });
  formulaire.append('type', photo.type);
  if (photo.longitude != null) formulaire.append('longitude', String(photo.longitude));
  if (photo.latitude != null) formulaire.append('latitude', String(photo.latitude));
  if (photo.precision_gps_m != null) {
    formulaire.append('precision_gps_m', String(photo.precision_gps_m));
  }
  if (photo.prise_le) formulaire.append('prise_le', photo.prise_le);
  if (photo.commentaire) formulaire.append('commentaire', photo.commentaire);

  const reponse = await api.envoyerPhoto(photo.commerce_serveur ?? photo.commerce_id, formulaire);
  await sync.confirmerPhoto(photo.id_local);
  return reponse;
}

/**
 * Libère l'espace occupé par les photos déjà remontées.
 * Appelé après chaque synchronisation réussie : sans cela, un agent finit par
 * saturer son téléphone au bout de quelques centaines de commerces.
 */
export async function libererPhotosEnvoyees() {
  const photos = await sync.photosSupprimables();
  let liberes = 0;
  let octets = 0;

  for (const p of photos) {
    try {
      const info = await FileSystem.getInfoAsync(p.chemin_fichier, { size: true });
      if (info.exists) {
        octets += info.size ?? 0;
        await FileSystem.deleteAsync(p.chemin_fichier, { idempotent: true });
      }
      await sync.oublierPhoto(p.id_local);
      liberes += 1;
    } catch {
      // Un échec de suppression n'est pas grave : on réessaiera.
    }
  }

  if (liberes > 0) {
    await journaliser('info', 'Photos envoyées effacées du téléphone',
      { nombre: liberes, mega_octets: Math.round(octets / 1024 / 1024) });
  }
  return { liberes, octets };
}

/** Espace occupé par les photos, affiché dans l'écran « Paramètres ». */
export async function espaceOccupe() {
  await assurerDossier();
  const fichiers = await FileSystem.readDirectoryAsync(DOSSIER_PHOTOS);
  let total = 0;
  for (const f of fichiers) {
    const info = await FileSystem.getInfoAsync(`${DOSSIER_PHOTOS}${f}`, { size: true });
    total += info.size ?? 0;
  }
  return { fichiers: fichiers.length, octets: total, mega_octets: total / 1024 / 1024 };
}

export const cheminDossier = DOSSIER_PHOTOS;
