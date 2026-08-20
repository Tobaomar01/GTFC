/**
 * File de synchronisation et photos en attente.
 *
 * Règle qui gouverne tout ce fichier : **rien n'est supprimé avant
 * confirmation du serveur**. Une opération reste en base jusqu'à ce que le
 * serveur ait répondu qu'il l'a appliquée. Un agent qui perd son travail perd
 * une journée de déplacements — c'est le risque qu'on refuse de prendre.
 */
import * as Crypto from 'expo-crypto';
import { lireTout, lirePremier, executer, transaction } from './database';

const maintenant = () => new Date().toISOString();

/** Un lot dépasse rarement 500 opérations : au-delà, la requête expire sur une
 *  connexion 3G instable. Mieux vaut plusieurs lots qui aboutissent qu'un seul
 *  qui échoue. */
export const TAILLE_LOT = 100;

/** Au-delà, on cesse de réessayer automatiquement : l'opération est
 *  probablement invalide et il faut l'avis d'un humain. */
export const TENTATIVES_MAX = 5;

// ---------------------------------------------------------------------------
// Lecture de la file
// ---------------------------------------------------------------------------
export const operationsEnAttente = (limite = TAILLE_LOT) => lireTout(
  `SELECT * FROM operation_sync
    WHERE statut = 'en_attente' AND tentatives < ?
    ORDER BY id LIMIT ?`, [TENTATIVES_MAX, limite],
);

export const compterEnAttente = async () => {
  const l = await lirePremier(
    "SELECT count(*) AS n FROM operation_sync WHERE statut = 'en_attente'");
  return l?.n ?? 0;
};

export const operationsBloquees = () => lireTout(
  `SELECT * FROM operation_sync
    WHERE statut IN ('conflit', 'rejetee') OR tentatives >= ?
    ORDER BY id DESC LIMIT 50`, [TENTATIVES_MAX],
);

// ---------------------------------------------------------------------------
// Suites données par le serveur
// ---------------------------------------------------------------------------

/** Marque les opérations d'un lot comme envoyées, avant d'attendre la réponse.
 *  Si l'application est tuée entre-temps, elles ne repartiront pas en double :
 *  la reprise les remettra explicitement en attente. */
export async function marquerEnvoyees(ids, lotId) {
  if (ids.length === 0) return;
  await executer(
    `UPDATE operation_sync SET statut = 'envoyee', lot_id = ?, tentatives = tentatives + 1
      WHERE id IN (${ids.map(() => '?').join(',')})`,
    [lotId, ...ids],
  );
}

/** Reprise après interruption : une opération restée « envoyee » sans réponse
 *  est remise en file. Le serveur est idempotent, un doublon est sans effet. */
export const reprendreOperationsInterrompues = () => executer(
  `UPDATE operation_sync SET statut = 'en_attente'
    WHERE statut = 'envoyee' AND tentatives < ?`, [TENTATIVES_MAX],
);

export const confirmerOperation = (id, message = null) => executer(
  `UPDATE operation_sync SET statut = 'confirmee', message = ?, traite_le = ? WHERE id = ?`,
  [message, maintenant(), id],
);

export const marquerConflit = (id, detail, message) => executer(
  `UPDATE operation_sync SET statut = 'conflit', conflit_detail = ?, message = ?, traite_le = ?
    WHERE id = ?`,
  [detail ? JSON.stringify(detail) : null, message ?? null, maintenant(), id],
);

export const marquerRejetee = (id, message) => executer(
  `UPDATE operation_sync SET statut = 'rejetee', message = ?, traite_le = ? WHERE id = ?`,
  [message ?? null, maintenant(), id],
);

/** Erreur réseau : on remet en file sans consommer de tentative
 *  supplémentaire — le problème vient de la connexion, pas de la donnée. */
export const remettreEnFile = (ids) => (ids.length === 0 ? Promise.resolve() : executer(
  `UPDATE operation_sync SET statut = 'en_attente', tentatives = MAX(tentatives - 1, 0)
    WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
));

/** Réessayer une opération bloquée, à la demande de l'agent. */
export const reessayerOperation = (id) => executer(
  `UPDATE operation_sync SET statut = 'en_attente', tentatives = 0, message = NULL WHERE id = ?`,
  [id],
);

/** Abandonner une opération définitivement rejetée. L'écran qui appelle
 *  affiche d'abord son contenu : l'agent doit savoir ce qu'il jette. */
export const abandonnerOperation = (id) => executer('DELETE FROM operation_sync WHERE id = ?', [id]);

/** Nettoyage : les opérations confirmées de plus de 7 jours n'ont plus
 *  d'utilité, l'historique complet est côté serveur. */
export const purgerConfirmees = () => executer(
  `DELETE FROM operation_sync
    WHERE statut = 'confirmee' AND traite_le < datetime('now', '-7 days')`,
);

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
export async function enregistrerPhoto({ commerceLocal, commerceId, type, chemin,
  tailleOctets, longitude, latitude, precisionGps, commentaire }) {
  const idLocal = Crypto.randomUUID();
  await executer(`
    INSERT INTO photo_locale (id_local, commerce_local, commerce_id, type, chemin_fichier,
                              taille_octets, longitude, latitude, precision_gps_m,
                              prise_le, commentaire)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [idLocal, commerceLocal, commerceId ?? null, type, chemin, tailleOctets ?? null,
    longitude ?? null, latitude ?? null, precisionGps ?? null,
    maintenant(), commentaire ?? null]);
  return idLocal;
}

/**
 * Photos prêtes à partir.
 *
 * Une photo n'est envoyable que si son commerce possède déjà un identifiant
 * SERVEUR : l'endpoint est `/commerces/:id/photos`. Une photo prise sur un
 * commerce créé hors ligne attend donc que la fiche soit remontée — d'où la
 * jointure plutôt qu'un simple `WHERE envoyee = 0`.
 */
export const photosEnAttente = (limite = 10) => lireTout(`
  SELECT p.*, c.id_serveur AS commerce_serveur
    FROM photo_locale p
    JOIN commerce c ON c.id_local = p.commerce_local
   WHERE p.envoyee = 0 AND p.tentatives < ? AND c.id_serveur IS NOT NULL
   ORDER BY p.prise_le LIMIT ?`, [TENTATIVES_MAX, limite]);

export const compterPhotosEnAttente = async () => {
  const l = await lirePremier('SELECT count(*) AS n FROM photo_locale WHERE envoyee = 0');
  return l?.n ?? 0;
};

export const photosDuCommerce = (commerceLocal) => lireTout(
  'SELECT * FROM photo_locale WHERE commerce_local = ? ORDER BY prise_le DESC', [commerceLocal],
);

export const confirmerPhoto = (idLocal) => executer(
  'UPDATE photo_locale SET envoyee = 1, derniere_erreur = NULL WHERE id_local = ?', [idLocal],
);

export const echecPhoto = (idLocal, message) => executer(
  'UPDATE photo_locale SET tentatives = tentatives + 1, derniere_erreur = ? WHERE id_local = ?',
  [String(message).slice(0, 300), idLocal],
);

/** Photos confirmées dont le fichier peut être effacé du téléphone.
 *  Délai de 24 h : marge de sécurité si une reprise s'avérait nécessaire. */
export const photosSupprimables = () => lireTout(
  "SELECT id_local, chemin_fichier FROM photo_locale WHERE envoyee = 1 LIMIT 100",
);

export const oublierPhoto = (idLocal) => executer(
  'DELETE FROM photo_locale WHERE id_local = ?', [idLocal],
);

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------
export const enregistrerPosition = ({ longitude, latitude, precision, vitesse, batterie }) => executer(
  `INSERT INTO position_agent (longitude, latitude, precision_gps_m, vitesse_kmh,
                               batterie_pct, releve_le)
   VALUES (?,?,?,?,?,?)`,
  [longitude, latitude, precision ?? null, vitesse ?? null, batterie ?? null, maintenant()],
);

export const positionsEnAttente = (limite = 200) => lireTout(
  'SELECT * FROM position_agent WHERE envoyee = 0 ORDER BY id LIMIT ?', [limite],
);

export async function confirmerPositions(ids) {
  if (ids.length === 0) return;
  // Purge directe : contrairement au reste, une position perdue est sans
  // conséquence — c'est du confort de supervision, pas une donnée fiscale.
  await executer(
    `DELETE FROM position_agent WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}

// ---------------------------------------------------------------------------
// Visites et paiements confirmés
// ---------------------------------------------------------------------------
export const confirmerVisite = (idLocal) => executer(
  'UPDATE visite SET envoyee = 1 WHERE id_local = ?', [idLocal],
);

export const confirmerPaiement = (idLocal) => executer(
  'UPDATE paiement SET envoye = 1 WHERE id_local = ?', [idLocal],
);

// ---------------------------------------------------------------------------
// Référentiels
// ---------------------------------------------------------------------------
export async function enregistrerReferentiels(referentiels) {
  await transaction(async (db) => {
    for (const [cle, contenu] of Object.entries(referentiels)) {
      await db.runAsync(
        `INSERT INTO referentiel (cle, contenu, recu_le) VALUES (?, ?, ?)
         ON CONFLICT(cle) DO UPDATE SET contenu = excluded.contenu, recu_le = excluded.recu_le`,
        [cle, JSON.stringify(contenu), maintenant()],
      );
    }
  });
}

export async function lireReferentiel(cle, defaut = []) {
  const l = await lirePremier('SELECT contenu FROM referentiel WHERE cle = ?', [cle]);
  if (!l) return defaut;
  try { return JSON.parse(l.contenu); } catch { return defaut; }
}

export async function referentielsComplets() {
  const cles = ['categories', 'zones', 'quartiers', 'marches',
    'types_emplacement', 'types_taxes', 'parametres'];
  const resultat = {};
  for (const c of cles) {
    resultat[c] = await lireReferentiel(c, c === 'parametres' ? null : []);
  }
  return resultat;
}

/** L'application est inutilisable sans référentiels : sans catégories, aucun
 *  formulaire de recensement n'est saisissable. */
export async function referentielsPresents() {
  const l = await lirePremier("SELECT count(*) AS n FROM referentiel WHERE cle = 'categories'");
  return (l?.n ?? 0) > 0;
}
