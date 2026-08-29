/**
 * Accès aux commerces en base locale.
 *
 * Toute écriture produit DEUX effets, dans la même transaction :
 *   1. la donnée locale, immédiatement consultable par l'agent ;
 *   2. une opération dans la file de synchronisation.
 *
 * Les séparer permettrait à un commerce d'exister sur le téléphone sans jamais
 * remonter au serveur — le pire défaut possible pour une application terrain.
 */
import * as Crypto from 'expo-crypto';
import { lireTout, lirePremier, executer, transaction } from './database';

const maintenant = () => new Date().toISOString();
const nouvelId = () => Crypto.randomUUID();

/** Normalisation pour la recherche : insensible aux accents et à la casse. */
const normaliser = (t) => String(t ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')   // signes diacritiques combinants
  .toLowerCase();

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
export async function listerCommerces({ recherche = '', quartierId = null,
  statutFiscal = null, limite = 100 } = {}) {
  const conditions = [];
  const params = [];

  if (quartierId) { conditions.push('c.quartier_id = ?'); params.push(quartierId); }
  if (statutFiscal) { conditions.push('c.statut_fiscal = ?'); params.push(statutFiscal); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limite);

  const lignes = await lireTout(
    `SELECT c.*, (SELECT count(*) FROM photo_locale p
                   WHERE p.commerce_local = c.id_local AND p.envoyee = 0) AS photos_en_attente
       FROM commerce c ${where}
      ORDER BY c.modifie_le DESC LIMIT ?`, params);

  // Le filtrage texte se fait en JavaScript : SQLite ne sait pas retirer les
  // accents, et un agent qui tape « ndiaye » doit trouver « Ndiayé ».
  if (!recherche) return lignes;
  const q = normaliser(recherche);
  return lignes.filter((c) => normaliser(c.enseigne).includes(q)
    || normaliser(c.code).includes(q)
    || normaliser(c.gerant_nom).includes(q));
}

export const lireCommerce = (idLocal) =>
  lirePremier('SELECT * FROM commerce WHERE id_local = ?', [idLocal]);

export const lireCommerceParServeur = (idServeur) =>
  lirePremier('SELECT * FROM commerce WHERE id_serveur = ?', [idServeur]);

export const lireCommerceParQr = (jeton) =>
  lirePremier('SELECT * FROM commerce WHERE qr_jeton = ?', [jeton]);

/**
 * Identifiant SERVEUR d'un commerce créé localement — null tant qu'il n'a pas
 * été synchronisé. Sert à résoudre les dépendances au moment de l'envoi :
 * un encaissement fait hors ligne sur un commerce lui-même créé hors ligne ne
 * peut partir qu'une fois la fiche remontée.
 */
export async function idServeurDe(idLocal) {
  if (!idLocal) return null;
  const l = await lirePremier('SELECT id_serveur FROM commerce WHERE id_local = ?', [idLocal]);
  return l?.id_serveur ?? null;
}

export const lireTaxesCommerce = (idLocal) =>
  lireTout('SELECT * FROM commerce_taxe WHERE commerce_local = ? AND active = 1', [idLocal]);

/**
 * Commerces proches, pour éviter les doublons de recensement.
 *
 * Le calcul se fait ici plutôt qu'en SQL : SQLite n'a pas PostGIS, et sur
 * quelques milliers de lignes une boucle JavaScript est instantanée. On filtre
 * d'abord grossièrement par un rectangle, ce qui évite un calcul de distance
 * sur tout le fichier.
 */
export async function commercesProches(longitude, latitude, rayonMetres = 100) {
  const degresLat = rayonMetres / 111_320;
  const degresLon = rayonMetres / (111_320 * Math.cos((latitude * Math.PI) / 180));

  const candidats = await lireTout(
    `SELECT id_local, id_serveur, code, enseigne, longitude, latitude, statut_fiscal
       FROM commerce
      WHERE longitude BETWEEN ? AND ? AND latitude BETWEEN ? AND ?`,
    [longitude - degresLon, longitude + degresLon,
      latitude - degresLat, latitude + degresLat],
  );

  return candidats
    .map((c) => ({ ...c, distance_m: distanceMetres(latitude, longitude, c.latitude, c.longitude) }))
    .filter((c) => c.distance_m <= rayonMetres)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/** Distance haversine, en mètres. */
export function distanceMetres(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null)) return Infinity;
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/**
 * Crée un commerce localement et empile son envoi.
 * Retourne l'identifiant local : l'agent peut immédiatement y attacher des
 * photos, avant même que le serveur n'ait attribué son identifiant définitif.
 */
export async function creerCommerce(donnees, taxes = []) {
  const idLocal = nouvelId();
  const ts = maintenant();

  await transaction(async (db) => {
    await db.runAsync(`
      INSERT INTO commerce (
        id_local, enseigne, activite_precise, categorie_id, zone_id, quartier_id,
        gerant_nom, gerant_prenom, gerant_telephone, telephone_paiement,
        ninea, numero_patente, adresse_libelle, point_repere,
        longitude, latitude, precision_gps_m,
        surface_locale_m2, todp_surface_m2, enseigne_surface_m2, enseigne_lumineuse,
        marche_id, type_emplacement_id, numero_emplacement, nb_jours_marche,
        statut, notes, origine_locale, modifie_localement, cree_le, modifie_le
      ) VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?,1,1,?,?)`,
    [
      idLocal, donnees.enseigne, donnees.activite_precise ?? null, donnees.categorie_id,
      donnees.zone_id ?? null, donnees.quartier_id ?? null,
      donnees.gerant_nom ?? null, donnees.gerant_prenom ?? null,
      donnees.gerant_telephone ?? null,
      donnees.telephone_paiement ?? donnees.gerant_telephone ?? null,
      donnees.ninea ?? null, donnees.numero_patente ?? null,
      donnees.adresse_libelle ?? null, donnees.point_repere ?? null,
      donnees.longitude ?? null, donnees.latitude ?? null, donnees.precision_gps_m ?? null,
      donnees.surface_locale_m2 ?? null, donnees.todp_surface_m2 ?? null,
      donnees.enseigne_surface_m2 ?? null, donnees.enseigne_lumineuse ? 1 : 0,
      donnees.marche_id ?? null, donnees.type_emplacement_id ?? null,
      donnees.numero_emplacement ?? null, donnees.nb_jours_marche ?? null,
      donnees.statut ?? 'actif', donnees.notes ?? null, ts, ts,
    ]);

    for (const t of taxes) {
      await db.runAsync(
        `INSERT INTO commerce_taxe (id_local, commerce_local, type_taxe_code, parametre_valeur)
         VALUES (?, ?, ?, ?)`,
        [nouvelId(), idLocal, t.code, t.valeur ?? null],
      );
    }

    await db.runAsync(`
      INSERT INTO operation_sync (identifiant_local, entite, operation, donnees,
                                  horodatage_client, cree_le)
      VALUES (?, 'commerce', 'creation', ?, ?, ?)`,
    [idLocal, JSON.stringify({
      ...donnees,
      enseigne_lumineuse: Boolean(donnees.enseigne_lumineuse),
      taxes: taxes.map((t) => t.code),
    }), ts, ts]);
  });

  return idLocal;
}

/**
 * Modification.
 * `version_client` accompagne l'opération : le serveur refuse si la fiche a
 * changé entre-temps, plutôt que d'écraser le travail d'un collègue.
 */
export async function modifierCommerce(idLocal, modifications) {
  const commerce = await lireCommerce(idLocal);
  if (!commerce) throw new Error('Commerce introuvable en base locale');

  const ts = maintenant();
  const champs = Object.keys(modifications).filter((c) => c !== 'id_local');
  if (champs.length === 0) return commerce;

  await transaction(async (db) => {
    const sets = champs.map((c) => `${c} = ?`).join(', ');
    const valeurs = champs.map((c) => {
      const v = modifications[c];
      return typeof v === 'boolean' ? (v ? 1 : 0) : v ?? null;
    });

    await db.runAsync(
      `UPDATE commerce SET ${sets}, modifie_localement = 1, modifie_le = ? WHERE id_local = ?`,
      [...valeurs, ts, idLocal],
    );

    await db.runAsync(`
      INSERT INTO operation_sync (identifiant_local, entite, operation, entite_id,
                                  version_client, donnees, horodatage_client, cree_le)
      VALUES (?, 'commerce', 'modification', ?, ?, ?, ?, ?)`,
    [idLocal, commerce.id_serveur, commerce.version_serveur,
      JSON.stringify(modifications), ts, ts]);
  });

  return lireCommerce(idLocal);
}

export async function definirTaxe(idLocal, codeTaxe, valeur) {
  await executer(`
    INSERT INTO commerce_taxe (id_local, commerce_local, type_taxe_code, parametre_valeur, active)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(commerce_local, type_taxe_code)
    DO UPDATE SET parametre_valeur = excluded.parametre_valeur, active = 1`,
  [nouvelId(), idLocal, codeTaxe, valeur ?? null]);
}

export const retirerTaxe = (idLocal, codeTaxe) => executer(
  'UPDATE commerce_taxe SET active = 0 WHERE commerce_local = ? AND type_taxe_code = ?',
  [idLocal, codeTaxe],
);

// ---------------------------------------------------------------------------
// Réception depuis le serveur
// ---------------------------------------------------------------------------

/**
 * Enregistre les commerces reçus du serveur.
 *
 * Point délicat : une fiche modifiée localement et pas encore synchronisée ne
 * doit PAS être écrasée par la version du serveur. On la laisse telle quelle ;
 * le conflit sera arbitré à l'envoi.
 */
export async function fusionnerDepuisServeur(commerces) {
  let inseres = 0; let majs = 0; let ignores = 0;

  await transaction(async (db) => {
    for (const c of commerces) {
      const local = await db.getFirstAsync(
        'SELECT id_local, modifie_localement FROM commerce WHERE id_serveur = ?', [c.id],
      );

      if (local?.modifie_localement === 1) { ignores += 1; continue; }

      if (local) {
        await db.runAsync(`
          UPDATE commerce SET
            version_serveur = ?, code = ?, enseigne = ?, categorie_id = ?,
            zone_id = ?, quartier_id = ?, gerant_nom = ?, gerant_prenom = ?,
            gerant_telephone = ?, telephone_paiement = ?, point_repere = ?,
            longitude = ?, latitude = ?, surface_locale_m2 = ?,
            todp_surface_m2 = ?, enseigne_surface_m2 = ?,
            statut = ?, statut_fiscal = ?, solde_du = ?, qr_jeton = ?,
            origine_locale = 0, modifie_localement = 0, modifie_le = ?
          WHERE id_local = ?`,
        [c.version, c.code, c.enseigne, c.categorie_id, c.zone_id, c.quartier_id,
          c.gerant_nom, c.gerant_prenom, c.gerant_telephone, c.telephone_paiement,
          c.point_repere, c.longitude, c.latitude, c.surface_locale_m2,
          c.todp_surface_m2, c.enseigne_surface_m2, c.statut, c.statut_fiscal,
          c.solde_du, c.qr_jeton, c.modifie_le, local.id_local]);
        majs += 1;
      } else {
        await db.runAsync(`
          INSERT INTO commerce (
            id_local, id_serveur, version_serveur, code, enseigne, categorie_id,
            zone_id, quartier_id, gerant_nom, gerant_prenom, gerant_telephone,
            telephone_paiement, point_repere, longitude, latitude,
            surface_locale_m2, todp_surface_m2, enseigne_surface_m2,
            statut, statut_fiscal, solde_du, qr_jeton,
            origine_locale, modifie_localement, cree_le, modifie_le
          ) VALUES (?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, 0,0,?,?)`,
        [nouvelId(), c.id, c.version, c.code, c.enseigne, c.categorie_id,
          c.zone_id, c.quartier_id, c.gerant_nom, c.gerant_prenom, c.gerant_telephone,
          c.telephone_paiement, c.point_repere, c.longitude, c.latitude,
          c.surface_locale_m2, c.todp_surface_m2, c.enseigne_surface_m2,
          c.statut, c.statut_fiscal, c.solde_du, c.qr_jeton,
          c.modifie_le ?? maintenant(), c.modifie_le ?? maintenant()]);
        inseres += 1;
      }
    }
  });

  return { inseres, majs, ignores };
}

/** Rattache l'identifiant serveur après une création synchronisée. */
export async function confirmerCreation(idLocal, { id, code, version, qr_jeton: qrJeton }) {
  await executer(`
    UPDATE commerce
       SET id_serveur = ?, code = COALESCE(?, code), version_serveur = ?,
           qr_jeton = COALESCE(?, qr_jeton), origine_locale = 0, modifie_localement = 0
     WHERE id_local = ?`,
  [id, code ?? null, version ?? null, qrJeton ?? null, idLocal]);

  // Les éléments rattachés attendaient cet identifiant pour pouvoir partir
  await executer('UPDATE photo_locale SET commerce_id = ? WHERE commerce_local = ?', [id, idLocal]);
  await executer('UPDATE visite SET commerce_id = ? WHERE commerce_local = ?', [id, idLocal]);
  await executer('UPDATE paiement SET commerce_id = ? WHERE commerce_local = ?', [id, idLocal]);
}

export const confirmerModification = (idLocal, version) => executer(
  'UPDATE commerce SET version_serveur = ?, modifie_localement = 0 WHERE id_local = ?',
  [version, idLocal],
);

// ---------------------------------------------------------------------------
// Visites, paiements
// ---------------------------------------------------------------------------
export async function enregistrerVisite(donnees) {
  const idLocal = nouvelId();
  const ts = maintenant();

  await transaction(async (db) => {
    await db.runAsync(`
      INSERT INTO visite (id_local, commerce_local, commerce_id, resultat, commentaire,
                          longitude, latitude, precision_gps_m, debute_le, termine_le)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [idLocal, donnees.commerce_local ?? null, donnees.commerce_id ?? null,
      donnees.resultat, donnees.commentaire ?? null,
      donnees.longitude ?? null, donnees.latitude ?? null, donnees.precision_gps_m ?? null,
      donnees.debute_le ?? ts, donnees.termine_le ?? ts]);

    await db.runAsync(`
      INSERT INTO operation_sync (identifiant_local, entite, operation, entite_id,
                                  donnees, horodatage_client, cree_le)
      VALUES (?, 'visite', 'creation', ?, ?, ?, ?)`,
    [idLocal, donnees.commerce_id ?? null, JSON.stringify({
      commerce_id: donnees.commerce_id ?? null,
      commerce_local: donnees.commerce_local ?? null,
      resultat: donnees.resultat,
      commentaire: donnees.commentaire ?? null,
      longitude: donnees.longitude ?? null,
      latitude: donnees.latitude ?? null,
      precision_gps_m: donnees.precision_gps_m ?? null,
      debute_le: donnees.debute_le ?? ts,
      termine_le: donnees.termine_le ?? ts,
    }), ts, ts]);
  });

  return idLocal;
}

/**
 * Encaissement en espèces hors ligne.
 * La référence est construite ici et jamais régénérée : c'est elle qui empêche
 * un double encaissement si le lot est renvoyé après une coupure réseau.
 */
export async function enregistrerPaiement(donnees) {
  const idLocal = nouvelId();
  const ts = maintenant();
  const reference = donnees.reference
    ?? `TER-${idLocal.slice(0, 8).toUpperCase()}`;

  await transaction(async (db) => {
    await db.runAsync(`
      INSERT INTO paiement (id_local, commerce_local, commerce_id, avis_id, reference,
                            montant, moyen, telephone_payeur, commentaire,
                            longitude, latitude, paye_le)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [idLocal, donnees.commerce_local ?? null, donnees.commerce_id ?? null,
      donnees.avis_id ?? null, reference, Math.round(donnees.montant),
      donnees.moyen ?? 'wave', donnees.telephone_payeur ?? null,
      donnees.commentaire ?? null, donnees.longitude ?? null,
      donnees.latitude ?? null, donnees.paye_le ?? ts]);

    await db.runAsync(`
      INSERT INTO operation_sync (identifiant_local, entite, operation, donnees,
                                  horodatage_client, cree_le)
      VALUES (?, 'paiement', 'creation', ?, ?, ?)`,
    [idLocal, JSON.stringify({
      commerce_id: donnees.commerce_id ?? null,
      commerce_local: donnees.commerce_local ?? null,
      avis_id: donnees.avis_id ?? null,
      reference,
      montant: Math.round(donnees.montant),
      moyen: donnees.moyen ?? 'wave',
      telephone_payeur: donnees.telephone_payeur ?? null,
      commentaire: donnees.commentaire ?? null,
      longitude: donnees.longitude ?? null,
      latitude: donnees.latitude ?? null,
      paye_le: donnees.paye_le ?? ts,
    }), ts, ts]);
  });

  return { idLocal, reference };
}

// ---------------------------------------------------------------------------
// Statistiques du jour — écran d'accueil
// ---------------------------------------------------------------------------
export async function statistiquesDuJour() {
  const debutJour = new Date();
  debutJour.setHours(0, 0, 0, 0);
  const depuis = debutJour.toISOString();

  const [visites, nouveaux, paiements, montant] = await Promise.all([
    lirePremier('SELECT count(*) AS n FROM visite WHERE debute_le >= ?', [depuis]),
    lirePremier('SELECT count(*) AS n FROM commerce WHERE cree_le >= ? AND origine_locale = 1', [depuis]),
    lirePremier('SELECT count(*) AS n FROM paiement WHERE paye_le >= ?', [depuis]),
    lirePremier('SELECT COALESCE(sum(montant), 0) AS total FROM paiement WHERE paye_le >= ?', [depuis]),
  ]);

  return {
    visites: visites?.n ?? 0,
    enregistrements: nouveaux?.n ?? 0,
    paiements: paiements?.n ?? 0,
    montant_encaisse: montant?.total ?? 0,
  };
}
