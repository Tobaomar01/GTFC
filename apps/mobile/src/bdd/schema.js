/**
 * Schéma SQLite local — le cœur du mode hors-ligne.
 *
 * Principe : TOUT passe d'abord par cette base. Un enregistrement fait sur le
 * terrain est valide et consultable même si le téléphone ne voit pas le réseau
 * pendant trois jours. Le serveur n'est qu'une destination de synchronisation.
 *
 * Deux natures de tables :
 *
 *   - MIROIR      (referentiels, commerces distants) : copie locale de ce que
 *                 le serveur a envoyé. Remplaçable à tout moment, jamais
 *                 source de vérité.
 *
 *   - FILE        (operation_sync, photo_locale) : ce que l'agent a produit et
 *                 qui n'est pas encore parti. C'est la seule donnée qui
 *                 n'existe QUE sur le téléphone — elle ne doit jamais être
 *                 effacée avant confirmation du serveur.
 *
 * Les identifiants locaux sont des UUID générés par le téléphone. Ils servent
 * de clé d'idempotence côté serveur : un lot renvoyé après une coupure réseau
 * est reconnu et non réappliqué.
 */

export const VERSION_SCHEMA = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Référentiels (miroir du serveur)
-- Une seule table clé/valeur JSON plutôt qu'une table par référentiel : ces
-- données sont lues en bloc au démarrage et remplacées en bloc à chaque
-- synchronisation. Les normaliser n'apporterait rien et multiplierait les
-- migrations à chaque évolution du serveur.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referentiel (
  cle           TEXT PRIMARY KEY,
  contenu       TEXT NOT NULL,
  recu_le       TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Commerces
-- Contient à la fois les fiches venues du serveur et celles créées ici.
-- 'origine_locale = 1' marque celles qui n'ont pas encore d'identifiant serveur.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce (
  id_local            TEXT PRIMARY KEY,
  id_serveur          TEXT UNIQUE,
  version_serveur     INTEGER,

  code                TEXT,
  enseigne            TEXT NOT NULL,
  activite_precise    TEXT,
  categorie_id        TEXT NOT NULL,
  zone_id             TEXT,
  quartier_id         TEXT,

  gerant_nom          TEXT,
  gerant_prenom       TEXT,
  gerant_telephone    TEXT,
  telephone_paiement  TEXT,
  ninea               TEXT,
  numero_patente      TEXT,

  adresse_libelle     TEXT,
  point_repere        TEXT,
  rue_id              TEXT,
  numero_rue          TEXT,
  longitude           REAL,
  latitude            REAL,
  precision_gps_m     REAL,

  surface_locale_m2   REAL,
  todp_surface_m2     REAL,
  enseigne_surface_m2 REAL,
  enseigne_lumineuse  INTEGER NOT NULL DEFAULT 0,

  marche_id           TEXT,
  type_emplacement_id TEXT,
  numero_emplacement  TEXT,
  nb_jours_marche     INTEGER,

  statut              TEXT NOT NULL DEFAULT 'actif',
  statut_fiscal       TEXT DEFAULT 'inconnu',
  solde_du            INTEGER DEFAULT 0,
  qr_jeton            TEXT,
  notes               TEXT,

  -- Valeurs par défaut délibérément « pessimistes » : une ligne insérée sans
  -- que l'appelant précise ces colonnes est supposée locale ET non
  -- synchronisée. Le pire défaut serait une fiche créée sur le terrain qui ne
  -- remonte jamais parce qu'un chemin de code a oublié de la marquer.
  -- fusionnerDepuisServeur() remet explicitement les deux à 0.
  origine_locale      INTEGER NOT NULL DEFAULT 1,
  modifie_localement  INTEGER NOT NULL DEFAULT 1,
  cree_le             TEXT NOT NULL,
  modifie_le          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commerce_serveur   ON commerce (id_serveur);
CREATE INDEX IF NOT EXISTS idx_commerce_quartier  ON commerce (quartier_id);
CREATE INDEX IF NOT EXISTS idx_commerce_recherche ON commerce (enseigne, code);
CREATE INDEX IF NOT EXISTS idx_commerce_qr        ON commerce (qr_jeton);
CREATE INDEX IF NOT EXISTS idx_commerce_a_envoyer ON commerce (modifie_localement)
  WHERE modifie_localement = 1;

-- ---------------------------------------------------------------------------
-- Taxes rattachées à un commerce (saisie de l'agent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commerce_taxe (
  id_local          TEXT PRIMARY KEY,
  commerce_local    TEXT NOT NULL REFERENCES commerce(id_local) ON DELETE CASCADE,
  type_taxe_code    TEXT NOT NULL,
  parametre_valeur  REAL,
  active            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (commerce_local, type_taxe_code)
);

-- ---------------------------------------------------------------------------
-- Visites (passages de l'agent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visite (
  id_local        TEXT PRIMARY KEY,
  commerce_local  TEXT REFERENCES commerce(id_local) ON DELETE CASCADE,
  commerce_id     TEXT,
  resultat        TEXT NOT NULL,
  commentaire     TEXT,
  longitude       REAL,
  latitude        REAL,
  precision_gps_m REAL,
  debute_le       TEXT NOT NULL,
  termine_le      TEXT,
  envoyee         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_visite_jour ON visite (debute_le);

-- ---------------------------------------------------------------------------
-- Encaissements en espèces réalisés hors ligne
-- La référence est générée par le téléphone : c'est elle qui garantit qu'un
-- lot rejoué ne crée pas un second paiement pour le même encaissement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paiement (
  id_local        TEXT PRIMARY KEY,
  commerce_local  TEXT REFERENCES commerce(id_local) ON DELETE CASCADE,
  commerce_id     TEXT,
  avis_id         TEXT,
  reference       TEXT NOT NULL UNIQUE,
  montant         INTEGER NOT NULL,
  moyen           TEXT NOT NULL DEFAULT 'wave',
  telephone_payeur TEXT,
  commentaire     TEXT,
  longitude       REAL,
  latitude        REAL,
  paye_le         TEXT NOT NULL,
  envoye          INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Photos en attente d'envoi
--
-- Le fichier reste dans le stockage de l'application ; seule sa référence est
-- ici. Une photo n'est SUPPRIMÉE du téléphone qu'après confirmation du serveur :
-- une photo de devanture perdue oblige l'agent à refaire le déplacement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photo_locale (
  id_local        TEXT PRIMARY KEY,
  commerce_local  TEXT NOT NULL REFERENCES commerce(id_local) ON DELETE CASCADE,
  commerce_id     TEXT,
  type            TEXT NOT NULL,
  chemin_fichier  TEXT NOT NULL,
  taille_octets   INTEGER,
  longitude       REAL,
  latitude        REAL,
  precision_gps_m REAL,
  prise_le        TEXT NOT NULL,
  commentaire     TEXT,
  envoyee         INTEGER NOT NULL DEFAULT 0,
  tentatives      INTEGER NOT NULL DEFAULT 0,
  derniere_erreur TEXT
);

CREATE INDEX IF NOT EXISTS idx_photo_a_envoyer ON photo_locale (envoyee, tentatives);

-- ---------------------------------------------------------------------------
-- File de synchronisation
--
-- Chaque écriture produit une opération. C'est la file qui fait foi : tant
-- qu'une opération n'est pas marquée « confirmee », le travail n'est pas
-- considéré comme remonté.
--
-- statut : en_attente | envoyee | confirmee | conflit | rejetee
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operation_sync (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identifiant_local TEXT NOT NULL,
  entite            TEXT NOT NULL,
  operation         TEXT NOT NULL,
  entite_id         TEXT,
  version_client    INTEGER,
  donnees           TEXT NOT NULL,
  horodatage_client TEXT NOT NULL,

  statut            TEXT NOT NULL DEFAULT 'en_attente',
  lot_id            TEXT,
  message           TEXT,
  conflit_detail    TEXT,
  tentatives        INTEGER NOT NULL DEFAULT 0,
  cree_le           TEXT NOT NULL,
  traite_le         TEXT
);

CREATE INDEX IF NOT EXISTS idx_op_en_attente ON operation_sync (statut, id);
CREATE INDEX IF NOT EXISTS idx_op_local      ON operation_sync (identifiant_local);

-- Le suivi de position des agents a été retiré (FR-051a, FR-051b).
DROP TABLE IF EXISTS position_agent;

-- ---------------------------------------------------------------------------
-- Journal local — diagnostic sur le terrain
--
-- Quand un agent appelle en disant « ça ne marche pas », c'est ici qu'on
-- regarde. Volontairement borné (voir purgerJournal) pour ne pas grossir
-- indéfiniment sur un téléphone d'entrée de gamme.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS journal_local (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  niveau      TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      TEXT,
  horodatage  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_local (id DESC);

-- ---------------------------------------------------------------------------
-- Métadonnées (version du schéma, dernière synchronisation, compteurs)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Dispositifs d'affichage
--
-- Le recensement se fait par balayage rue par rue, et non commerce par
-- commerce : un panneau de regie n'a aucune devanture derriere lui. D'ou une
-- table a part, avec sa propre rue et ses propres coordonnees, plutot que
-- deux colonnes de plus sur la fiche commerce.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispositif_affichage (
  id_local            TEXT PRIMARY KEY,
  id_serveur          TEXT UNIQUE,
  code                TEXT,

  type_affichage_id   TEXT NOT NULL,
  commerce_local      TEXT REFERENCES commerce(id_local) ON DELETE SET NULL,
  commerce_serveur    TEXT,
  redevable_id        TEXT,

  rue_id              TEXT,
  quartier_id         TEXT,
  zone_id             TEXT,
  adresse_libelle     TEXT,
  longitude           REAL,
  latitude            REAL,
  precision_gps_m     REAL,

  surface_m2          REAL NOT NULL,
  largeur_m           REAL,
  hauteur_m           REAL,
  nb_faces            INTEGER NOT NULL DEFAULT 1,
  lumineux            INTEGER NOT NULL DEFAULT 0,
  texte_affiche       TEXT,
  date_apposition     TEXT,
  numero_autorisation TEXT,
  notes               TEXT,

  origine_locale      INTEGER NOT NULL DEFAULT 1,
  modifie_localement  INTEGER NOT NULL DEFAULT 1,
  cree_le             TEXT NOT NULL,
  modifie_le          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_affichage_commerce  ON dispositif_affichage (commerce_local);
CREATE INDEX IF NOT EXISTS idx_affichage_rue       ON dispositif_affichage (rue_id);
CREATE INDEX IF NOT EXISTS idx_affichage_a_envoyer ON dispositif_affichage (modifie_localement)
  WHERE modifie_localement = 1;

-- ---------------------------------------------------------------------------
-- Chantiers
--
-- Recenses, jamais factures pendant le pilote. Tous les champs de calcul sont
-- pourtant collectes : quand la commune delibera un tarif, les chantiers de
-- cette annee seront refermes et un repassage terrain sera impossible.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chantier (
  id_local            TEXT PRIMARY KEY,
  id_serveur          TEXT UNIQUE,
  code                TEXT,

  redevable_id        TEXT,
  libelle             TEXT,
  types_json          TEXT NOT NULL DEFAULT '[]',

  rue_id              TEXT,
  quartier_id         TEXT,
  zone_id             TEXT,
  adresse_libelle     TEXT,
  longitude           REAL,
  latitude            REAL,

  surface_m2          REAL NOT NULL,
  duree_prevue_jours  INTEGER,
  date_fin_prevue     TEXT,
  numero_autorisation TEXT,
  autorisation_vue    INTEGER NOT NULL DEFAULT 0,
  statut              TEXT NOT NULL DEFAULT 'en_cours',
  notes               TEXT,

  origine_locale      INTEGER NOT NULL DEFAULT 1,
  modifie_localement  INTEGER NOT NULL DEFAULT 1,
  cree_le             TEXT NOT NULL,
  modifie_le          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chantier_a_envoyer ON chantier (modifie_localement)
  WHERE modifie_localement = 1;

CREATE TABLE IF NOT EXISTS meta (
  cle     TEXT PRIMARY KEY,
  valeur  TEXT
);
`;

/**
 * Migrations futures.
 *
 * Chaque entrée est jouée une seule fois, dans l'ordre, et enregistrée dans
 * `meta.version_schema`. Une mise à jour de l'application ne doit JAMAIS
 * effacer la base : un agent peut avoir trois jours de travail non synchronisé
 * au moment où l'APK est mis à jour.
 */
export const MIGRATIONS = [
  {
    // Modele « redevable » : la rue devient une entite, et deux nouvelles
    // familles d'objets taxables apparaissent.
    //
    // Les CREATE TABLE sont deja dans SCHEMA_SQL, joue avec IF NOT EXISTS a
    // chaque ouverture : ils s'appliquent donc aussi bien a une base neuve
    // qu'a une base existante. Seuls les ALTER TABLE ont besoin d'etre ici,
    // SQLite n'ayant pas d'ADD COLUMN IF NOT EXISTS.
    version: 2,
    sql: 'ALTER TABLE commerce ADD COLUMN rue_id TEXT;'
       + 'ALTER TABLE commerce ADD COLUMN numero_rue TEXT;',
  },
];
