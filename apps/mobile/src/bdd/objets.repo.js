/**
 * Dépôt local des objets taxables autres que le commerce :
 * dispositifs d'affichage et chantiers.
 *
 * Même règle que pour les commerces : l'enregistrement est valide dès qu'il
 * est écrit ici, réseau ou pas. L'opération correspondante part dans la file
 * `operation_sync` et n'en sort qu'une fois le serveur ayant confirmé.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  LA DÉPENDANCE QUI PIÈGE
 *
 *  Une enseigne recensée sur un commerce lui-même créé hors ligne n'a pas
 *  encore d'identifiant serveur : elle ne porte qu'un identifiant local. Si
 *  on l'envoyait telle quelle, le serveur recevrait `commerce_id: null` et
 *  rattacherait le panneau à personne.
 *
 *  D'où `commerce_local` conservé à côté de `commerce_serveur`, et la
 *  résolution faite au moment de l'envoi — une fois le commerce parti et son
 *  identifiant connu. C'est la même mécanique que pour les visites
 *  hors ligne.
 * ─────────────────────────────────────────────────────────────────────────
 */

import * as Crypto from 'expo-crypto';
import { lireTout, lirePremier, executer, transaction } from './database';

const maintenant = () => new Date().toISOString();
const nouvelId = () => Crypto.randomUUID();

// ---------------------------------------------------------------------------
// Dispositifs d'affichage
// ---------------------------------------------------------------------------

export async function creerAffichage(donnees) {
  const idLocal = nouvelId();
  const ts = maintenant();

  await transaction(async (db) => {
    await db.runAsync(`
      INSERT INTO dispositif_affichage (
        id_local, type_affichage_id, commerce_local, commerce_serveur, redevable_id,
        rue_id, quartier_id, zone_id, adresse_libelle,
        longitude, latitude, precision_gps_m,
        surface_m2, largeur_m, hauteur_m, nb_faces, lumineux,
        texte_affiche, date_apposition, numero_autorisation, notes,
        origine_locale, modifie_localement, cree_le, modifie_le
      ) VALUES (?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?, 1,1,?,?)`,
    [
      idLocal, donnees.type_affichage_id,
      donnees.commerce_local ?? null, donnees.commerce_serveur ?? null,
      donnees.redevable_id ?? null,
      donnees.rue_id ?? null, donnees.quartier_id ?? null, donnees.zone_id ?? null,
      donnees.adresse_libelle ?? null,
      donnees.longitude ?? null, donnees.latitude ?? null, donnees.precision_gps_m ?? null,
      donnees.surface_m2, donnees.largeur_m ?? null, donnees.hauteur_m ?? null,
      donnees.nb_faces ?? 1, donnees.lumineux ? 1 : 0,
      donnees.texte_affiche ?? null, donnees.date_apposition ?? null,
      donnees.numero_autorisation ?? null, donnees.notes ?? null,
      ts, ts,
    ]);

    await db.runAsync(`
      INSERT INTO operation_sync (identifiant_local, entite, operation, donnees,
                                  horodatage_client, cree_le)
      VALUES (?, 'affichage', 'creation', ?, ?, ?)`,
    [idLocal, JSON.stringify({
      ...donnees,
      lumineux: Boolean(donnees.lumineux),
      // L'identifiant serveur du commerce sera injecté au moment de l'envoi,
      // par resoudreDependances() : ici il peut encore être inconnu.
      commerce_id: donnees.commerce_serveur ?? null,
    }), ts, ts]);
  });

  return idLocal;
}

export async function listerAffichages({ commerceLocal = null, rueId = null, limite = 100 } = {}) {
  const conditions = [];
  const params = [];
  if (commerceLocal) { conditions.push('d.commerce_local = ?'); params.push(commerceLocal); }
  if (rueId) { conditions.push('d.rue_id = ?'); params.push(rueId); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limite);

  return lireTout(`
    SELECT d.*, c.enseigne AS commerce_enseigne, c.code AS commerce_code
      FROM dispositif_affichage d
      LEFT JOIN commerce c ON c.id_local = d.commerce_local
     ${where}
     ORDER BY d.cree_le DESC
     LIMIT ?`, params);
}

export async function affichagesDuCommerce(commerceLocal) {
  return listerAffichages({ commerceLocal });
}

export async function confirmerAffichage(idLocal, { id, code }) {
  await executer(`
    UPDATE dispositif_affichage
       SET id_serveur = ?, code = ?, origine_locale = 0, modifie_localement = 0
     WHERE id_local = ?`, [id, code ?? null, idLocal]);
}

// ---------------------------------------------------------------------------
// Chantiers
// ---------------------------------------------------------------------------

export async function creerChantier(donnees) {
  const idLocal = nouvelId();
  const ts = maintenant();
  const types = donnees.types ?? [];

  await transaction(async (db) => {
    await db.runAsync(`
      INSERT INTO chantier (
        id_local, redevable_id, libelle, types_json,
        rue_id, quartier_id, zone_id, adresse_libelle, longitude, latitude,
        surface_m2, duree_prevue_jours, date_fin_prevue,
        numero_autorisation, autorisation_vue, statut, notes,
        origine_locale, modifie_localement, cree_le, modifie_le
      ) VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?, 1,1,?,?)`,
    [
      idLocal, donnees.redevable_id ?? null, donnees.libelle ?? null,
      JSON.stringify(types),
      donnees.rue_id ?? null, donnees.quartier_id ?? null, donnees.zone_id ?? null,
      donnees.adresse_libelle ?? null, donnees.longitude ?? null, donnees.latitude ?? null,
      donnees.surface_m2, donnees.duree_prevue_jours ?? null, donnees.date_fin_prevue ?? null,
      donnees.numero_autorisation ?? null, donnees.autorisation_vue ? 1 : 0,
      donnees.statut ?? 'en_cours', donnees.notes ?? null, ts, ts,
    ]);

    await db.runAsync(`
      INSERT INTO operation_sync (identifiant_local, entite, operation, donnees,
                                  horodatage_client, cree_le)
      VALUES (?, 'chantier', 'creation', ?, ?, ?)`,
    [idLocal, JSON.stringify({
      ...donnees,
      types,
      autorisation_vue: Boolean(donnees.autorisation_vue),
    }), ts, ts]);
  });

  return idLocal;
}

export async function listerChantiers({ limite = 100 } = {}) {
  return lireTout(`
    SELECT * FROM chantier ORDER BY cree_le DESC LIMIT ?`, [limite]);
}

export async function confirmerChantier(idLocal, { id, code }) {
  await executer(`
    UPDATE chantier
       SET id_serveur = ?, code = ?, origine_locale = 0, modifie_localement = 0
     WHERE id_local = ?`, [id, code ?? null, idLocal]);
}

// ---------------------------------------------------------------------------
// Rues
// ---------------------------------------------------------------------------

/**
 * Recherche d'une rue dans le référentiel embarqué.
 *
 * La comparaison porte AUSSI sur les graphies alternatives : l'agent tape le
 * nom qu'il a en tête ou qu'il lit sur la plaque, pas nécessairement celui
 * retenu par la mairie. Une recherche qui ne trouve pas « GT63 » alors que la
 * rue existe sous « Rue GT 63 » pousse à saisir en texte libre, c'est-à-dire
 * exactement ce que le référentiel sert à éviter.
 */
export function chercherRue(rues, terme) {
  const normal = (t) => String(t ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

  const q = normal(terme);
  if (!q) return rues.slice(0, 30);

  return rues
    .filter((r) => normal(r.nom).includes(q)
      || normal(r.code).includes(q)
      || (r.variantes ?? []).some((v) => normal(v).includes(q)))
    .slice(0, 30);
}

/** Compteur d'objets non encore partis, pour le bandeau d'état. */
export async function objetsEnAttente() {
  const a = await lirePremier(
    'SELECT count(*) AS n FROM dispositif_affichage WHERE modifie_localement = 1');
  const c = await lirePremier(
    'SELECT count(*) AS n FROM chantier WHERE modifie_localement = 1');
  return { affichages: a?.n ?? 0, chantiers: c?.n ?? 0 };
}
