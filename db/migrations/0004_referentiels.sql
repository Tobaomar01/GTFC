-- ===========================================================================
--  0004 — Référentiels
--
--  ref.type_taxe est GLOBAL : les 5 taxes sont définies par le code général
--  des impôts, elles ne changent pas d'une commune à l'autre. Ce sont les
--  BARÈMES qui varient (migration 0007).
--
--  ref.categorie_commerce est PAR COMMUNE : chaque mairie a sa propre
--  nomenclature — 21 catégories pour GTFC.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Types de taxes (référentiel global)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.type_taxe (
    id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 text        NOT NULL UNIQUE,
    libelle              text        NOT NULL,
    libelle_court        text        NOT NULL,
    description          text,
    base_legale          text,

    mode_calcul_defaut   app.mode_calcul_taxe NOT NULL,
    periodicite_defaut   app.periodicite      NOT NULL,

    -- Une taxe « conditionnelle » ne s'applique que si un critère est rempli :
    -- la TODP uniquement en cas de débordement mesuré sur le trottoir,
    -- le droit de place uniquement pour un commerce rattaché à un marché.
    conditionnelle       boolean     NOT NULL DEFAULT false,
    condition_libelle    text,

    -- Le paramètre saisi par l'agent pour cette taxe (surface, nb de jours...)
    parametre_requis     text,
    parametre_unite      text,

    ordre_affichage      smallint    NOT NULL DEFAULT 0,
    actif                boolean     NOT NULL DEFAULT true,
    cree_le              timestamptz NOT NULL DEFAULT now(),
    modifie_le           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT type_taxe_code_format CHECK (code ~ '^[a-z_]{2,30}$')
);

COMMENT ON TABLE ref.type_taxe IS
'Les 5 taxes de la plateforme : patente, TODP, TEOM, droit de place, enseignes.';
COMMENT ON COLUMN ref.type_taxe.parametre_requis IS
'Nom du paramètre que l''agent doit saisir sur le terrain (ex. surface_m2 pour la TODP).';

-- ---------------------------------------------------------------------------
-- Activation des taxes par commune
-- Toutes les communes ne perçoivent pas toutes les taxes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.commune_type_taxe (
    commune_id     uuid           NOT NULL REFERENCES app.commune(id)   ON DELETE CASCADE,
    type_taxe_id   uuid           NOT NULL REFERENCES ref.type_taxe(id) ON DELETE RESTRICT,

    actif          boolean        NOT NULL DEFAULT true,
    periodicite    app.periodicite,           -- surcharge la périodicité par défaut
    mode_calcul    app.mode_calcul_taxe,      -- surcharge le mode par défaut
    libelle_local  text,                      -- appellation propre à la commune
    delib_reference text,                     -- n° de délibération du conseil municipal
    delib_date     date,

    a_remplacer    boolean        NOT NULL DEFAULT false,
    cree_le        timestamptz    NOT NULL DEFAULT now(),
    modifie_le     timestamptz    NOT NULL DEFAULT now(),

    PRIMARY KEY (commune_id, type_taxe_id)
);

-- ---------------------------------------------------------------------------
-- Catégories de commerces (21 pour GTFC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.categorie_commerce (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id     uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    code           text        NOT NULL,
    libelle        text        NOT NULL,
    libelle_normalise text     GENERATED ALWAYS AS (app.normaliser(libelle)) STORED,
    description    text,
    icone          text,                       -- nom d'icône pour l'app Android

    -- Taxes appliquées d'office aux commerces de cette catégorie.
    -- L'agent peut en ajouter ou en retirer au cas par cas.
    todp_probable  boolean     NOT NULL DEFAULT false,
    enseigne_probable boolean  NOT NULL DEFAULT false,
    sur_marche     boolean     NOT NULL DEFAULT false,

    ordre_affichage smallint   NOT NULL DEFAULT 0,
    actif          boolean     NOT NULL DEFAULT true,

    a_remplacer    boolean     NOT NULL DEFAULT false,
    cree_le        timestamptz NOT NULL DEFAULT now(),
    modifie_le     timestamptz NOT NULL DEFAULT now(),
    archive_le     timestamptz,

    CONSTRAINT categorie_code_unique_par_commune UNIQUE (commune_id, code)
);

COMMENT ON COLUMN ref.categorie_commerce.todp_probable IS
'true = la TODP est proposée par défaut à l''agent (restaurant avec terrasse, étal...). Reste modifiable au cas par cas.';

-- ---------------------------------------------------------------------------
-- Taxes appliquées d'office par catégorie
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.categorie_taxe (
    categorie_id   uuid        NOT NULL REFERENCES ref.categorie_commerce(id) ON DELETE CASCADE,
    type_taxe_id   uuid        NOT NULL REFERENCES ref.type_taxe(id)          ON DELETE CASCADE,
    obligatoire    boolean     NOT NULL DEFAULT true,
    cree_le        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (categorie_id, type_taxe_id)
);

-- ---------------------------------------------------------------------------
-- Types d'emplacement de marché (droit de place)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.type_emplacement (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id     uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    code           text        NOT NULL,
    libelle        text        NOT NULL,      -- table, étal, cantine, hangar
    surface_type_m2 numeric(6,2),
    ordre_affichage smallint   NOT NULL DEFAULT 0,
    actif          boolean     NOT NULL DEFAULT true,

    a_remplacer    boolean     NOT NULL DEFAULT false,
    cree_le        timestamptz NOT NULL DEFAULT now(),
    modifie_le     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT emplacement_code_unique_par_commune UNIQUE (commune_id, code)
);

-- ---------------------------------------------------------------------------
-- Motifs d'exonération
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.motif_exoneration (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id         uuid        REFERENCES app.commune(id) ON DELETE CASCADE,  -- NULL = motif global
    code               text        NOT NULL,
    libelle            text        NOT NULL,
    description        text,

    -- Une exonération engage la commune : on trace qui peut l'accorder,
    -- si une pièce justificative est exigée, et pour quelle durée maximale.
    role_minimum       app.role_utilisateur NOT NULL DEFAULT 'admin_commune',
    justificatif_requis boolean    NOT NULL DEFAULT true,
    duree_max_mois     smallint,
    actif              boolean     NOT NULL DEFAULT true,

    a_remplacer        boolean     NOT NULL DEFAULT false,
    cree_le            timestamptz NOT NULL DEFAULT now(),
    modifie_le         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT motif_code_unique UNIQUE (commune_id, code)
);

-- ---------------------------------------------------------------------------
-- Index
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_categorie_commune   ON ref.categorie_commerce (commune_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_categorie_libelle   ON ref.categorie_commerce USING GIN (libelle_normalise gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_emplacement_commune ON ref.type_emplacement   (commune_id);
CREATE INDEX IF NOT EXISTS idx_motif_commune       ON ref.motif_exoneration  (commune_id);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['type_taxe','commune_type_taxe','categorie_commerce',
                             'type_emplacement','motif_exoneration'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_modifie_le ON ref.%1$s;
             CREATE TRIGGER trg_%1$s_modifie_le BEFORE UPDATE ON ref.%1$s
             FOR EACH ROW EXECUTE FUNCTION app.trg_maj_modifie_le();', t);
    END LOOP;
END
$$;
