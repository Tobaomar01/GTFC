-- ===========================================================================
--  0003 — Communes et découpage territorial
--
--  app.commune est la racine du modèle multi-locataires : presque toutes les
--  autres tables portent une colonne commune_id, et les politiques RLS
--  (migration 0014) s'appuient dessus pour garantir qu'une mairie ne voit
--  jamais les données d'une autre.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Commune (locataire)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.commune (
    id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code                text        NOT NULL,          -- GTFC
    slug                text        NOT NULL,          -- gtfc  → gtfc.domaine.sn
    nom                 text        NOT NULL,          -- Gueule Tapée-Fass-Colobane
    nom_court           text,
    departement         text,
    region              text,
    superficie_km2      numeric(8,3),
    population          integer,

    -- Limites administratives. Sert à rejeter un point GPS relevé hors commune.
    geom                geometry(MultiPolygon, 4326),
    centre              geometry(Point, 4326),         -- centrage initial de la carte

    telephone           text,
    email               text,
    adresse_mairie      text,
    nom_maire           text,
    logo_url            text,
    couleur_principale  text        DEFAULT '#0B5D2B',

    actif               boolean     NOT NULL DEFAULT true,
    date_activation     date,
    est_pilote          boolean     NOT NULL DEFAULT false,

    a_remplacer         boolean     NOT NULL DEFAULT false,
    cree_le             timestamptz NOT NULL DEFAULT now(),
    modifie_le          timestamptz NOT NULL DEFAULT now(),
    archive_le          timestamptz,

    CONSTRAINT commune_code_unique  UNIQUE (code),
    CONSTRAINT commune_slug_unique  UNIQUE (slug),
    CONSTRAINT commune_slug_format  CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
    CONSTRAINT commune_code_format  CHECK (code ~ '^[A-Z0-9]{2,10}$')
);

COMMENT ON TABLE  app.commune IS 'Locataire de la plateforme. Une ligne = une commune.';
COMMENT ON COLUMN app.commune.slug IS 'Sous-domaine d''accès : <slug>.domaine.sn';
COMMENT ON COLUMN app.commune.geom IS 'Limites administratives, pour valider les points GPS relevés.';
COMMENT ON COLUMN app.commune.a_remplacer IS 'true = données factices issues du seed, à remplacer par les données officielles.';

-- ---------------------------------------------------------------------------
-- Paramètres fiscaux et techniques, une ligne par commune
-- Séparé de app.commune : ces valeurs changent (délibérations du conseil
-- municipal) alors que l'identité de la commune, non.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.commune_parametre (
    commune_id                  uuid PRIMARY KEY REFERENCES app.commune(id) ON DELETE CASCADE,

    -- Fiscalité
    devise                      text          NOT NULL DEFAULT 'XOF',
    jour_exigibilite            smallint      NOT NULL DEFAULT 10,
    delai_grace_jours           smallint      NOT NULL DEFAULT 5,
    taux_penalite_pct           numeric(5,2)  NOT NULL DEFAULT 10.00,
    penalite_plafond_pct        numeric(5,2)  NOT NULL DEFAULT 50.00,
    remise_paiement_annuel_pct  numeric(5,2)  NOT NULL DEFAULT 0,

    -- TODP : règles de mesure du débordement sur trottoir
    todp_surface_minimale_m2    numeric(6,2)  NOT NULL DEFAULT 1.00,
    todp_surface_maximale_m2    numeric(6,2),
    todp_arrondi                text          NOT NULL DEFAULT 'superieur',

    -- Codes et identifiants
    prefixe_code_commerce       text          NOT NULL DEFAULT 'GTFC',
    format_code_commerce        text          NOT NULL DEFAULT '{prefixe}-{zone}-{sequence:5}',

    -- Terrain
    rayon_tolerance_gps_m       integer       NOT NULL DEFAULT 50,
    photo_devanture_obligatoire boolean       NOT NULL DEFAULT true,
    photo_todp_obligatoire      boolean       NOT NULL DEFAULT true,
    objectif_visites_jour_agent integer       DEFAULT 25,

    -- Wave (renseigné en phase 5)
    wave_marchand_id            text,
    wave_actif                  boolean       NOT NULL DEFAULT false,
    encaissement_especes_autorise boolean     NOT NULL DEFAULT true,

    a_remplacer                 boolean       NOT NULL DEFAULT false,
    cree_le                     timestamptz   NOT NULL DEFAULT now(),
    modifie_le                  timestamptz   NOT NULL DEFAULT now(),

    CONSTRAINT param_jour_exigibilite CHECK (jour_exigibilite BETWEEN 1 AND 28),
    CONSTRAINT param_penalite         CHECK (taux_penalite_pct BETWEEN 0 AND 100),
    CONSTRAINT param_arrondi          CHECK (todp_arrondi IN ('superieur','inferieur','proche','dixieme')),
    CONSTRAINT param_todp_bornes      CHECK (todp_surface_maximale_m2 IS NULL
                                             OR todp_surface_maximale_m2 >= todp_surface_minimale_m2)
);

COMMENT ON COLUMN app.commune_parametre.jour_exigibilite IS
'Jour du mois où l''avis d''imposition devient exigible. Plafonné à 28 pour rester valide en février.';
COMMENT ON COLUMN app.commune_parametre.todp_arrondi IS
'Règle d''arrondi de la surface mesurée : superieur (3,4 m² -> 4), inferieur, proche, ou dixieme (3,4 m² conservé).';

-- ---------------------------------------------------------------------------
-- Zones (3 pour GTFC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.zone (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id    uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    code          text        NOT NULL,            -- Z1, Z2, Z3
    nom           text        NOT NULL,
    description   text,
    geom          geometry(MultiPolygon, 4326),
    couleur       text        DEFAULT '#0B5D2B',   -- teinte sur la carte du dashboard
    ordre         smallint    NOT NULL DEFAULT 0,

    a_remplacer   boolean     NOT NULL DEFAULT false,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    modifie_le    timestamptz NOT NULL DEFAULT now(),
    archive_le    timestamptz,

    CONSTRAINT zone_code_unique_par_commune UNIQUE (commune_id, code),
    CONSTRAINT zone_code_format CHECK (code ~ '^[A-Z0-9]{1,6}$')
);

-- ---------------------------------------------------------------------------
-- Quartiers (15 pour GTFC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.quartier (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id    uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    zone_id       uuid        NOT NULL REFERENCES app.zone(id)    ON DELETE RESTRICT,
    code          text        NOT NULL,
    nom           text        NOT NULL,
    nom_normalise text        GENERATED ALWAYS AS (app.normaliser(nom)) STORED,

    -- Polygone du quartier : c'est lui qui permet à app.detecter_quartier()
    -- de déduire le quartier depuis les coordonnées GPS de l'agent.
    -- NULL tant que la mairie n'a pas fourni le fond de carte : l'agent
    -- choisit alors le quartier dans une liste déroulante.
    geom          geometry(MultiPolygon, 4326),
    centre        geometry(Point, 4326),

    population    integer,
    nb_commerces_estime integer,

    a_remplacer   boolean     NOT NULL DEFAULT false,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    modifie_le    timestamptz NOT NULL DEFAULT now(),
    archive_le    timestamptz,

    CONSTRAINT quartier_code_unique_par_commune UNIQUE (commune_id, code)
);

COMMENT ON COLUMN app.quartier.geom IS
'Polygone officiel. NULL = non fourni : la détection automatique du quartier par GPS est alors inactive et l''agent saisit le quartier manuellement.';

-- ---------------------------------------------------------------------------
-- Marchés (droit de place)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.marche (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id    uuid        NOT NULL REFERENCES app.commune(id)  ON DELETE CASCADE,
    quartier_id   uuid        REFERENCES app.quartier(id)          ON DELETE SET NULL,
    code          text        NOT NULL,
    nom           text        NOT NULL,
    geom          geometry(Point, 4326),
    emprise       geometry(MultiPolygon, 4326),
    nb_places     integer,
    jours_marche  text[],     -- {'lundi','jeudi'} ; vide = tous les jours

    a_remplacer   boolean     NOT NULL DEFAULT false,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    modifie_le    timestamptz NOT NULL DEFAULT now(),
    archive_le    timestamptz,

    CONSTRAINT marche_code_unique_par_commune UNIQUE (commune_id, code)
);

-- ---------------------------------------------------------------------------
-- Index géospatiaux et de recherche
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_commune_geom      ON app.commune  USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_zone_geom         ON app.zone     USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_zone_commune      ON app.zone     (commune_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_quartier_geom     ON app.quartier USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_quartier_commune  ON app.quartier (commune_id, zone_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_quartier_nom      ON app.quartier USING GIN (nom_normalise gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_marche_commune    ON app.marche   (commune_id) WHERE archive_le IS NULL;

-- ---------------------------------------------------------------------------
-- Horodatage automatique
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['commune','commune_parametre','zone','quartier','marche'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_modifie_le ON app.%1$s;
             CREATE TRIGGER trg_%1$s_modifie_le BEFORE UPDATE ON app.%1$s
             FOR EACH ROW EXECUTE FUNCTION app.trg_maj_modifie_le();', t);
    END LOOP;
END
$$;
