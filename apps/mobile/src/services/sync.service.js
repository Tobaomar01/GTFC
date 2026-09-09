/**
 * Moteur de synchronisation.
 *
 * Séquence d'une synchronisation complète :
 *   1. reprise des opérations interrompues par une coupure précédente ;
 *   2. envoi des opérations en attente, par lots ;
 *   3. envoi des photos (elles attendent l'identifiant serveur du commerce) ;
 *   5. téléchargement du delta serveur (référentiels + commerces modifiés).
 *
 * L'ordre compte : on ENVOIE avant de RECEVOIR. Recevoir d'abord risquerait
 * d'écraser une fiche modifiée localement par la version du serveur, avant
 * même que la modification n'ait été remontée.
 */
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as Application from 'expo-application';
import { api, ErreurReseau } from '../api/client';
import * as sync from '../bdd/sync.repo';
import * as commerces from '../bdd/commerces.repo';
import * as objets from '../bdd/objets.repo';
import { lireMeta, ecrireMeta, journaliser, purgerJournal } from '../bdd/database';
import { envoyerPhoto, libererPhotosEnvoyees } from './photos';

let synchronisationEnCours = false;

/** Empêche deux synchronisations simultanées : le retour du réseau et un appui
 *  manuel de l'agent peuvent survenir à la même seconde. */
export const estEnCours = () => synchronisationEnCours;

/**
 * Synchronisation complète.
 * @param {(etape: {phase: string, message: string, progression?: number}) => void} surProgression
 */
export async function synchroniser({ surProgression = () => {}, forcer = false } = {}) {
  if (synchronisationEnCours && !forcer) {
    return { ignoree: true, motif: 'Synchronisation déjà en cours' };
  }
  synchronisationEnCours = true;

  const bilan = {
    envoyees: 0, conflits: 0, rejetees: 0,
    photos: 0, photos_echouees: 0,
    recus: 0, mis_a_jour: 0, erreurs: [],
  };

  try {
    // --- 0. Le serveur répond-il ? ---------------------------------------
    surProgression({ phase: 'verification', message: 'Vérification de la connexion…' });
    if (!(await api.joignable())) {
      throw new ErreurReseau('Le serveur ne répond pas. Réessayez quand vous aurez du réseau.');
    }

    // --- 1. Reprise ------------------------------------------------------
    await sync.reprendreOperationsInterrompues();

    // --- 2. Envoi des opérations ------------------------------------------
    surProgression({ phase: 'envoi', message: 'Envoi de vos enregistrements…' });
    const resultatEnvoi = await envoyerOperations(surProgression);
    Object.assign(bilan, resultatEnvoi);

    // --- 3. Photos --------------------------------------------------------
    surProgression({ phase: 'photos', message: 'Envoi des photos…' });
    const resultatPhotos = await envoyerPhotos(surProgression);
    bilan.photos = resultatPhotos.envoyees;
    bilan.photos_echouees = resultatPhotos.echouees;

    // --- 4. Positions -----------------------------------------------------

    // --- 5. Réception -----------------------------------------------------
    surProgression({ phase: 'reception', message: 'Mise à jour des données…' });
    const resultatReception = await telechargerPaquet();
    bilan.recus = resultatReception.inseres;
    bilan.mis_a_jour = resultatReception.majs;

    // --- 6. Entretien -----------------------------------------------------
    await libererPhotosEnvoyees();
    await sync.purgerConfirmees();
    await purgerJournal();

    await ecrireMeta('derniere_sync', new Date().toISOString());
    await journaliser('info', 'Synchronisation terminée', bilan);

    surProgression({ phase: 'termine', message: 'Synchronisation terminée', progression: 1 });
    return bilan;
  } catch (err) {
    await journaliser('erreur', 'Synchronisation interrompue', { message: err.message });
    bilan.erreurs.push(err.message);
    bilan.echec = true;
    bilan.reseau = Boolean(err.duReseau);
    throw Object.assign(err, { bilan });
  } finally {
    synchronisationEnCours = false;
  }
}

// ---------------------------------------------------------------------------
// Envoi des opérations
// ---------------------------------------------------------------------------
/**
 * Résout les dépendances d'une opération avant l'envoi.
 *
 * Cas concret : un agent recense une boutique hors ligne, puis y note un
 * passage dans la foulée. La visite a été empilée avec `commerce_id = null`,
 * parce que le serveur n'avait pas encore attribué d'identifiant à la fiche.
 * Au moment de l'envoi, on va le chercher.
 *
 * @returns {Promise<object|null>} les données prêtes, ou null si la dépendance
 *          n'est pas encore satisfaite — l'opération attend alors un lot
 *          ultérieur, une fois le commerce remonté.
 */
async function resoudreDependances(operation) {
  const donnees = JSON.parse(operation.donnees);

  const dependantes = ['visite', 'affichage'];
  if (!dependantes.includes(operation.entite)) return donnees;

  if (donnees.commerce_id) return donnees;

  // Une enseigne recensée sur une devanture est rattachée à un commerce ; un
  // panneau de régie ne l'est pas, et son redevable a été désigné par
  // l'agent. Différer un panneau autonome en attendant un commerce qui
  // n'existera jamais le bloquerait indéfiniment dans la file.
  if (operation.entite === 'affichage' && !donnees.commerce_local) {
    return donnees;
  }

  const idServeur = await commerces.idServeurDe(donnees.commerce_local);
  if (!idServeur) return null;

  return { ...donnees, commerce_id: idServeur };
}

async function envoyerOperations(surProgression) {
  const bilan = { envoyees: 0, conflits: 0, rejetees: 0 };
  const total = await sync.compterEnAttente();
  if (total === 0) return bilan;

  let traitees = 0;
  // Opérations dont la dépendance n'est pas encore satisfaite. Elles sont
  // exclues du lot courant, sinon la boucle les resélectionnerait sans fin.
  const differees = new Set();
  let passe = 0;

  // Deux passes suffisent : après la première, les commerces créés hors ligne
  // ont reçu leur identifiant serveur, ce qui débloque leurs visites et
  // leurs affichages.
  while (passe < 2) {
    passe += 1;
    let progresse = false;

    for (;;) {
      const brutes = await sync.operationsEnAttente(sync.TAILLE_LOT + differees.size);
      const operations = [];

      for (const op of brutes) {
        if (differees.has(op.id)) continue;
        const donnees = await resoudreDependances(op);
        if (donnees === null) { differees.add(op.id); continue; }
        operations.push({ ...op, donneesResolues: donnees });
        if (operations.length >= sync.TAILLE_LOT) break;
      }

      if (operations.length === 0) break;
      progresse = true;

      const identifiantLot = Crypto.randomUUID();
      const ids = operations.map((o) => o.id);

      const lot = {
        identifiant_client: identifiantLot,
        appareil_id: Device.osInternalBuildId ?? Device.modelName ?? 'inconnu',
        version_app: Application.nativeApplicationVersion ?? '1.0.0',
        hors_ligne_depuis: operations[0].cree_le,
        operations: operations.map((o) => ({
          entite: o.entite,
          operation: o.operation,
          identifiant_local: o.identifiant_local,
          entite_id: o.entite_id ?? undefined,
          version_client: o.version_client ?? undefined,
          horodatage_client: o.horodatage_client,
          donnees: o.donneesResolues,
        })),
      };

      await sync.marquerEnvoyees(ids, identifiantLot);

      let reponse;
      try {
        reponse = await api.envoyerLot(lot);
      } catch (err) {
        if (err.duReseau) {
          // Le réseau a lâché en cours d'envoi : on remet en file sans
          // pénaliser, et on arrête là. Le serveur reconnaîtra le lot s'il
          // l'avait déjà reçu.
          await sync.remettreEnFile(ids);
          throw err;
        }
        // Refus du serveur : le lot entier est en cause (format, droits).
        for (const op of operations) {
          await sync.marquerRejetee(op.id, err.message);
          bilan.rejetees += 1;
        }
        continue;
      }

      await appliquerResultats(operations, reponse, bilan);

      traitees += operations.length;
      surProgression({
        phase: 'envoi',
        message: `Envoi ${Math.min(traitees, total)} / ${total}`,
        progression: total ? Math.min(traitees / total, 1) : 1,
      });
    }

    // Rien n'a pu partir pendant cette passe : insister ne changerait rien.
    if (!progresse) break;

    // Les dépendances de la passe précédente sont maintenant satisfaites :
    // on redonne leur chance aux opérations différées.
    differees.clear();
  }

  // Opérations dont la dépendance n'a jamais pu être résolue : leur commerce
  // n'est pas remonté (rejeté, ou en conflit). On le dit explicitement plutôt
  // que de les laisser en attente indéfiniment.
  for (const id of differees) {
    await sync.marquerRejetee(id,
      'Le commerce concerné n\'a pas pu être envoyé au serveur — corrigez-le d\'abord');
    bilan.rejetees += 1;
  }

  return bilan;
}

/** Rapproche la réponse du serveur, opération par opération. */
async function appliquerResultats(operations, reponse, bilan) {
  const parIdentifiant = new Map(
    (reponse?.resultats ?? []).map((r) => [r.identifiant_local, r]),
  );

  for (const op of operations) {
    const resultat = parIdentifiant.get(op.identifiant_local);

    if (!resultat) {
      // Le serveur n'a rien dit de cette opération : on la remet en file
      // plutôt que de supposer qu'elle est passée.
      await sync.remettreEnFile([op.id]);
      continue;
    }

    if (resultat.statut === 'traite') {
      await sync.confirmerOperation(op.id, resultat.message);
      bilan.envoyees += 1;

      // Rattachement de l'identifiant serveur : c'est lui qui débloque
      // l'envoi des photos et des visites du même commerce.
      if (op.entite === 'commerce' && op.operation === 'creation' && resultat.entite_id) {
        await commerces.confirmerCreation(op.identifiant_local, {
          id: resultat.entite_id,
          code: resultat.code,
          version: resultat.version,
          qr_jeton: resultat.qr_jeton,
        });
      } else if (op.entite === 'commerce' && op.operation === 'modification') {
        await commerces.confirmerModification(op.identifiant_local, resultat.version);
      } else if (op.entite === 'visite') {
        await sync.confirmerVisite(op.identifiant_local);
      } else if (op.entite === 'affichage') {
        await objets.confirmerAffichage(op.identifiant_local, {
          id: resultat.entite_id, code: resultat.code,
        });
      } else if (op.entite === 'chantier') {
        await objets.confirmerChantier(op.identifiant_local, {
          id: resultat.entite_id, code: resultat.code,
        });
      }
    } else if (resultat.statut === 'conflit') {
      // Le serveur a la main : un superviseur tranchera depuis le dashboard.
      // On ne réessaie pas, et surtout on n'écrase rien.
      await sync.marquerConflit(op.id, resultat.conflit, resultat.message);
      bilan.conflits += 1;
    } else {
      await sync.marquerRejetee(op.id, resultat.message);
      bilan.rejetees += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
async function envoyerPhotos(surProgression) {
  let envoyees = 0;
  let echouees = 0;
  const total = await sync.compterPhotosEnAttente();
  if (total === 0) return { envoyees, echouees };

  for (;;) {
    const photos = await sync.photosEnAttente(5);
    if (photos.length === 0) break;

    for (const photo of photos) {
      try {
        await envoyerPhoto(photo, api);
        envoyees += 1;
        surProgression({
          phase: 'photos',
          message: `Photos ${envoyees} / ${total}`,
          progression: total ? envoyees / total : 1,
        });
      } catch (err) {
        if (err.duReseau) throw err;   // inutile d'insister, le réseau est parti
        await sync.echecPhoto(photo.id_local, err.message);
        echouees += 1;
      }
    }
  }

  return { envoyees, echouees };
}

// ---------------------------------------------------------------------------
// Réception
// ---------------------------------------------------------------------------
async function telechargerPaquet() {
  // Delta : on ne redemande que ce qui a changé depuis la dernière fois.
  // Sur 5 443 commerces, c'est la différence entre quelques kilo-octets et
  // plusieurs mégaoctets à chaque synchronisation.
  const depuis = await lireMeta('derniere_reception');
  const paquet = await api.paquetHorsLigne(depuis);

  if (paquet.referentiels) {
    await sync.enregistrerReferentiels(paquet.referentiels);
  }

  // La feuille du jour se range dans le magasin cle/valeur existant. Pas de
  // table locale, donc pas de migration du schema SQLite sur les telephones
  // deja installes.
  if (paquet.feuille_de_route !== undefined) {
    await sync.enregistrerReferentiels({
      feuille_de_route: paquet.feuille_de_route ?? null,
    });
  }

  const resultat = paquet.commerces?.length
    ? await commerces.fusionnerDepuisServeur(paquet.commerces)
    : { inseres: 0, majs: 0, ignores: 0 };

  await ecrireMeta('derniere_reception', paquet.genere_le ?? new Date().toISOString());

  if (paquet.tronque) {
    await journaliser('avertissement',
      'Paquet tronqué : relancez une synchronisation pour recevoir la suite');
  }

  return resultat;
}

/** Premier chargement après connexion : référentiels + commerces, sans delta. */
export async function chargementInitial(surProgression = () => {}) {
  surProgression({ phase: 'reception', message: 'Téléchargement des données de la commune…' });
  const paquet = await api.paquetHorsLigne(null);

  await sync.enregistrerReferentiels({
    ...(paquet.referentiels ?? {}),
    feuille_de_route: paquet.feuille_de_route ?? null,
  });
  const resultat = paquet.commerces?.length
    ? await commerces.fusionnerDepuisServeur(paquet.commerces)
    : { inseres: 0, majs: 0 };

  await ecrireMeta('derniere_reception', paquet.genere_le ?? new Date().toISOString());
  await ecrireMeta('derniere_sync', new Date().toISOString());
  await journaliser('info', 'Chargement initial terminé', resultat);

  return { ...resultat, referentiels: Object.keys(paquet.referentiels ?? {}).length };
}

// ---------------------------------------------------------------------------
// État affiché en permanence dans l'application
// ---------------------------------------------------------------------------
export async function etatSynchronisation() {
  const [enAttente, photos, bloquees, photosBloquees, derniere] = await Promise.all([
    sync.compterEnAttente(),
    sync.compterPhotosEnAttente(),
    sync.operationsBloquees(),
    sync.photosBloquees(),
    lireMeta('derniere_sync'),
  ]);

  return {
    en_attente: enAttente,
    photos_en_attente: photos,
    // Une photo qui ne partira plus n'est PAS « en attente » : la compter là
    // empêchait le bandeau de retomber à zéro et rendait la déconnexion
    // impossible. Elle est à examiner, ce qui n'est pas la même demande.
    photos_bloquees: photosBloquees.length,
    conflits: bloquees.filter((o) => o.statut === 'conflit').length,
    rejetees: bloquees.filter((o) => o.statut === 'rejetee').length,
    derniere_sync: derniere,
    a_synchroniser: enAttente > 0 || photos > 0,
    en_cours: synchronisationEnCours,
  };
}
