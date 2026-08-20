-- ===========================================================================
--  0009 — Activité terrain et synchronisation hors-ligne
--
--  L'app Android fonctionne sans réseau : l'agent enregistre dans une base
--  SQLite locale, puis un lot est envoyé dès que la connexion revient.
--  Ces tables assurent que rien n'est perdu, que rien n'est appliqué deux
--  fois, et que les conflits sont visibles au lieu d'être écrasés en silence.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Visites : chaque passage d'un agent devant un commerce
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.visite (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE RESTRICT,
    commerce_id       uuid        REFERENCES app.commerce(id)          ON DELETE RESTRICT,
    agent_id          uuid        NOT NULL REFERENCES app.utilisateur(id) ON DELETE RESTRICT,

    resultat          app.resultat_visite NOT NULL,
    commentaire       text,

    -- Où et quand, d'après le téléphone de l'agent
    geom              geometry(Point, 4326),
    precision_gps_m   numeric(6,2),
    quartier_id       uuid        REFERENCES app.quartier(id),
    debute_le         timestamptz NOT NULL,
    termine_le        timestamptz,
    duree_secondes    integer     GENERATED ALWAYS AS (
                          CASE WHEN termine_le IS NOT NULL
                               THEN EXTRACT(EPOCH FROM (termine_le - debute_le))::integer
                          END) STORED,

    -- Écart entre la position de l'agent et celle enregistrée du commerce.
    -- Un écart important sur une visite « contrôle effectué » est un signal
    -- à examiner : l'agent n'était peut-être pas devant la boutique.
    distance_commerce_m numeric(8,2),

    -- Origine de la donnée
    hors_ligne        boolean     NOT NULL DEFAULT false,
    sync_lot_id       uuid,
    identifiant_local text,           -- identifiant SQLite côté téléphone

    cree_le           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT visite_dates CHECK (termine_le IS NULL OR termine_le >= debute_le)
);

CREATE INDEX IF NOT EXISTS idx_visite_commerce ON app.visite (commerce_id, debute_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_agent    ON app.visite (agent_id, debute_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_commune  ON app.visite (commune_id, debute_le DESC);
CREATE INDEX IF NOT EXISTS idx_visite_geom     ON app.visite USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_visite_ecart    ON app.visite (commune_id, distance_commerce_m DESC)
    WHERE distance_commerce_m > 100;

COMMENT ON COLUMN app.visite.distance_commerce_m IS
'Écart entre la position relevée et celle du commerce. Au-delà de 100 m, la visite est signalée pour vérification.';

-- ---------------------------------------------------------------------------
-- Traçabilité des positions des agents
--
-- Volumétrie importante (un point toutes les 2 minutes en tournée) : la table
-- est partitionnée par mois pour que la purge annuelle soit instantanée
-- (DROP de partition) plutôt qu'un DELETE massif.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.position_agent (
    id                bigserial   NOT NULL,
    commune_id        uuid        NOT NULL,
    agent_id          uuid        NOT NULL,
    geom              geometry(Point, 4326) NOT NULL,
    precision_gps_m   numeric(6,2),
    vitesse_kmh       numeric(6,2),
    batterie_pct      smallint,
    releve_le         timestamptz NOT NULL,
    hors_ligne        boolean     NOT NULL DEFAULT false,
    PRIMARY KEY (id, releve_le)
) PARTITION BY RANGE (releve_le);

CREATE INDEX IF NOT EXISTS idx_position_agent_date ON app.position_agent (agent_id, releve_le DESC);
CREATE INDEX IF NOT EXISTS idx_position_geom       ON app.position_agent USING GIST (geom);

-- Crée les partitions manquantes autour de la date du jour.
-- Appelée par le planificateur (phase 5) le 25 de chaque mois.
CREATE OR REPLACE FUNCTION app.creer_partitions_position(nb_mois_avant integer DEFAULT 1,
                                                          nb_mois_apres integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    i integer;
    debut date;
    fin date;
    nom text;
    creees integer := 0;
BEGIN
    FOR i IN -nb_mois_avant..nb_mois_apres LOOP
        debut := date_trunc('month', current_date + (i || ' months')::interval)::date;
        fin   := (debut + interval '1 month')::date;
        nom   := format('position_agent_%s', to_char(debut, 'YYYY_MM'));

        IF NOT EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relname = nom
        ) THEN
            EXECUTE format(
                'CREATE TABLE app.%I PARTITION OF app.position_agent
                 FOR VALUES FROM (%L) TO (%L);', nom, debut, fin);
            creees := creees + 1;
        END IF;
    END LOOP;
    RETURN creees;
END;
$$;

COMMENT ON FUNCTION app.creer_partitions_position IS
'Crée à l''avance les partitions mensuelles. Sans partition disponible, tout enregistrement de position échoue.';

-- Partitions initiales
SELECT app.creer_partitions_position(2, 6);

-- ---------------------------------------------------------------------------
-- Lots de synchronisation
--
-- Un lot = un envoi depuis un téléphone. L'identifiant est généré par l'app :
-- si le réseau coupe pendant l'envoi et que l'app réessaie, le même lot est
-- reconnu et n'est pas appliqué deux fois.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.sync_lot (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)     ON DELETE CASCADE,
    agent_id          uuid        NOT NULL REFERENCES app.utilisateur(id) ON DELETE RESTRICT,

    identifiant_client text       NOT NULL,        -- UUID généré par l'app Android
    appareil_id       text,
    version_app       text,

    nb_operations     integer     NOT NULL DEFAULT 0,
    nb_appliquees     integer     NOT NULL DEFAULT 0,
    nb_conflits       integer     NOT NULL DEFAULT 0,
    nb_rejetees       integer     NOT NULL DEFAULT 0,

    statut            app.statut_sync NOT NULL DEFAULT 'en_attente',
    -- Fenêtre pendant laquelle le téléphone était hors ligne
    hors_ligne_depuis timestamptz,
    recu_le           timestamptz NOT NULL DEFAULT now(),
    traite_le         timestamptz,
    duree_ms          integer,
    message_erreur    text,

    CONSTRAINT sync_lot_client_unique UNIQUE (agent_id, identifiant_client)
);

CREATE INDEX IF NOT EXISTS idx_sync_lot_agent  ON app.sync_lot (agent_id, recu_le DESC);
CREATE INDEX IF NOT EXISTS idx_sync_lot_statut ON app.sync_lot (statut, recu_le) WHERE statut = 'en_attente';

COMMENT ON CONSTRAINT sync_lot_client_unique ON app.sync_lot IS
'Idempotence : un lot renvoyé après une coupure réseau n''est pas appliqué deux fois.';

-- ---------------------------------------------------------------------------
-- Opérations contenues dans un lot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.sync_operation (
    id                bigserial   PRIMARY KEY,
    lot_id            uuid        NOT NULL REFERENCES app.sync_lot(id) ON DELETE CASCADE,
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE CASCADE,

    ordre             integer     NOT NULL,
    entite            text        NOT NULL,        -- commerce | visite | paiement | photo
    operation         text        NOT NULL,        -- creation | modification
    identifiant_local text        NOT NULL,        -- clé SQLite côté téléphone
    entite_id         uuid,                        -- clé serveur, une fois appliquée

    donnees           jsonb       NOT NULL,
    version_client    integer,                     -- version du commerce vue par l'app
    version_serveur   integer,                     -- version réelle au moment du traitement

    statut            app.statut_sync NOT NULL DEFAULT 'en_attente',
    message           text,
    -- Détail du conflit : quels champs divergent, valeur client vs serveur
    conflit_detail    jsonb,
    resolu_par        uuid        REFERENCES app.utilisateur(id),
    resolu_le         timestamptz,
    resolution        text,                        -- client | serveur | fusion

    horodatage_client timestamptz NOT NULL,
    traite_le         timestamptz,

    CONSTRAINT sync_op_entite    CHECK (entite IN ('commerce','visite','paiement','photo','commerce_taxe','position')),
    CONSTRAINT sync_op_operation CHECK (operation IN ('creation','modification','archivage')),
    CONSTRAINT sync_op_unique    UNIQUE (lot_id, ordre)
);

CREATE INDEX IF NOT EXISTS idx_sync_op_lot      ON app.sync_operation (lot_id, ordre);
CREATE INDEX IF NOT EXISTS idx_sync_op_conflits ON app.sync_operation (commune_id, statut)
    WHERE statut = 'conflit';
CREATE INDEX IF NOT EXISTS idx_sync_op_locale   ON app.sync_operation (identifiant_local);

COMMENT ON COLUMN app.sync_operation.conflit_detail IS
'Champs divergents entre le téléphone et le serveur. Un superviseur tranche depuis le dashboard ; rien n''est écrasé automatiquement.';

-- ---------------------------------------------------------------------------
-- Imports du registre existant de la mairie (Excel, ancien logiciel)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.import_registre (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)     ON DELETE CASCADE,
    lance_par         uuid        NOT NULL REFERENCES app.utilisateur(id) ON DELETE RESTRICT,

    nom_fichier       text        NOT NULL,
    bucket            text,
    chemin            text,
    sha256            text,

    nb_lignes         integer     NOT NULL DEFAULT 0,
    nb_importees      integer     NOT NULL DEFAULT 0,
    nb_doublons       integer     NOT NULL DEFAULT 0,
    nb_erreurs        integer     NOT NULL DEFAULT 0,
    rapport           jsonb,

    statut            text        NOT NULL DEFAULT 'en_cours',
    lance_le          timestamptz NOT NULL DEFAULT now(),
    termine_le        timestamptz,

    CONSTRAINT import_statut CHECK (statut IN ('en_cours','termine','echec','annule'))
);

CREATE INDEX IF NOT EXISTS idx_import_commune ON app.import_registre (commune_id, lance_le DESC);

-- Lien différé : la visite référence le lot qui l'a apportée
ALTER TABLE app.visite DROP CONSTRAINT IF EXISTS visite_sync_lot_fk;
ALTER TABLE app.visite ADD CONSTRAINT visite_sync_lot_fk
    FOREIGN KEY (sync_lot_id) REFERENCES app.sync_lot(id) ON DELETE SET NULL;
