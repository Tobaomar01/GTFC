-- ===========================================================================
--  0007 — Barèmes, taxes appliquées aux commerces, exonérations
--
--  Principe directeur : un barème n'est JAMAIS modifié en place, il est
--  VERSIONNÉ par date d'effet. Quand le conseil municipal vote une hausse,
--  on ajoute une ligne avec une nouvelle date d'effet ; les quittances déjà
--  émises continuent de refléter le tarif en vigueur à leur date.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.bareme_taxe (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE CASCADE,
    type_taxe_id      uuid        NOT NULL REFERENCES ref.type_taxe(id) ON DELETE RESTRICT,

    libelle           text        NOT NULL,
    mode_calcul       app.mode_calcul_taxe NOT NULL,
    periodicite       app.periodicite      NOT NULL,

    -- Un seul de ces montants est utilisé, selon le mode de calcul :
    --   forfait                -> montant_fixe
    --   par_m2 / par_jour      -> montant_unitaire
    --   par_categorie / tranche-> voir app.bareme_tranche
    montant_fixe      numeric(14,0),
    montant_unitaire  numeric(14,2),
    unite             text,                     -- m², jour, mètre linéaire

    montant_minimum   numeric(14,0),
    montant_maximum   numeric(14,0),

    -- Période de validité. L'exclusion plus bas empêche deux barèmes
    -- concurrents pour la même taxe au même moment.
    date_effet        date        NOT NULL,
    date_fin          date,
    periode           daterange   GENERATED ALWAYS AS (daterange(date_effet, date_fin, '[)')) STORED,

    -- Traçabilité juridique : un barème engage la commune
    delib_reference   text,
    delib_date        date,
    delib_document_url text,

    a_remplacer       boolean     NOT NULL DEFAULT false,
    cree_le           timestamptz NOT NULL DEFAULT now(),
    cree_par          uuid        REFERENCES app.utilisateur(id),
    modifie_le        timestamptz NOT NULL DEFAULT now(),
    modifie_par       uuid        REFERENCES app.utilisateur(id),

    CONSTRAINT bareme_dates CHECK (date_fin IS NULL OR date_fin > date_effet),
    CONSTRAINT bareme_montants_positifs CHECK (
        coalesce(montant_fixe, 0)     >= 0 AND
        coalesce(montant_unitaire, 0) >= 0 AND
        coalesce(montant_minimum, 0)  >= 0 AND
        coalesce(montant_maximum, 0)  >= 0
    ),
    CONSTRAINT bareme_bornes CHECK (
        montant_maximum IS NULL OR montant_minimum IS NULL OR montant_maximum >= montant_minimum
    ),
    -- Cohérence entre le mode de calcul et le montant renseigné
    CONSTRAINT bareme_montant_coherent CHECK (
        (mode_calcul = 'forfait'          AND montant_fixe     IS NOT NULL) OR
        (mode_calcul IN ('par_m2','par_jour') AND montant_unitaire IS NOT NULL) OR
        (mode_calcul IN ('par_categorie','par_tranche'))
    )
);

-- Deux barèmes ne peuvent pas se chevaucher dans le temps pour une même taxe
-- d'une même commune. Contrôle assuré par la base, pas par le code applicatif.
ALTER TABLE app.bareme_taxe DROP CONSTRAINT IF EXISTS bareme_pas_de_chevauchement;
ALTER TABLE app.bareme_taxe ADD CONSTRAINT bareme_pas_de_chevauchement
    EXCLUDE USING gist (
        commune_id   WITH =,
        type_taxe_id WITH =,
        periode      WITH &&
    );

COMMENT ON TABLE app.bareme_taxe IS
'Tarifs votés par le conseil municipal, versionnés par date d''effet. Jamais modifiés rétroactivement.';
COMMENT ON CONSTRAINT bareme_pas_de_chevauchement ON app.bareme_taxe IS
'Empêche deux tarifs concurrents pour la même taxe à la même date.';

CREATE INDEX IF NOT EXISTS idx_bareme_commune_taxe ON app.bareme_taxe (commune_id, type_taxe_id, date_effet DESC);
CREATE INDEX IF NOT EXISTS idx_bareme_a_remplacer  ON app.bareme_taxe (commune_id) WHERE a_remplacer;

-- ---------------------------------------------------------------------------
-- Grille détaillée : montant par catégorie de commerce, ou par tranche
-- (de surface, de chiffre d'affaires...).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.bareme_tranche (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    bareme_id         uuid        NOT NULL REFERENCES app.bareme_taxe(id) ON DELETE CASCADE,
    categorie_id      uuid        REFERENCES ref.categorie_commerce(id)   ON DELETE CASCADE,
    type_emplacement_id uuid      REFERENCES ref.type_emplacement(id)     ON DELETE CASCADE,
    zone_id           uuid        REFERENCES app.zone(id)                 ON DELETE CASCADE,

    libelle           text,
    borne_min         numeric(14,2),      -- inclusive ; NULL = pas de borne basse
    borne_max         numeric(14,2),      -- exclusive ; NULL = pas de borne haute
    montant           numeric(14,0) NOT NULL,
    montant_unitaire  numeric(14,2),      -- pour les grilles au m² variables par zone

    ordre             smallint    NOT NULL DEFAULT 0,
    a_remplacer       boolean     NOT NULL DEFAULT false,
    cree_le           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tranche_bornes  CHECK (borne_max IS NULL OR borne_min IS NULL OR borne_max > borne_min),
    CONSTRAINT tranche_montant CHECK (montant >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tranche_bareme    ON app.bareme_tranche (bareme_id);
CREATE INDEX IF NOT EXISTS idx_tranche_categorie ON app.bareme_tranche (categorie_id) WHERE categorie_id IS NOT NULL;

COMMENT ON COLUMN app.bareme_tranche.borne_max IS
'Borne exclusive : une tranche 0–20 m² et une tranche 20–50 m² ne se recouvrent pas à 20 m².';

-- ---------------------------------------------------------------------------
-- Taxes appliquées à un commerce donné
--
-- Une ligne par taxe redevable. La TODP n'apparaît que si l'agent a mesuré un
-- débordement ; le droit de place, que si le commerce est sur un marché.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.commerce_taxe (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE CASCADE,
    commerce_id       uuid        NOT NULL REFERENCES app.commerce(id)  ON DELETE CASCADE,
    type_taxe_id      uuid        NOT NULL REFERENCES ref.type_taxe(id) ON DELETE RESTRICT,

    -- Valeur du paramètre de calcul saisie par l'agent :
    -- surface TODP en m², surface d'enseigne, nombre de jours de marché...
    parametre_valeur  numeric(12,2),
    parametre_source  text        NOT NULL DEFAULT 'agent',   -- agent | categorie | import | dashboard

    -- Surcharge exceptionnelle du montant, sur décision motivée
    montant_force     numeric(14,0),
    motif_montant_force text,

    date_debut        date        NOT NULL DEFAULT current_date,
    date_fin          date,
    periode           daterange   GENERATED ALWAYS AS (daterange(date_debut, date_fin, '[)')) STORED,

    actif             boolean     NOT NULL DEFAULT true,

    cree_le           timestamptz NOT NULL DEFAULT now(),
    cree_par          uuid        REFERENCES app.utilisateur(id),
    modifie_le        timestamptz NOT NULL DEFAULT now(),
    modifie_par       uuid        REFERENCES app.utilisateur(id),

    CONSTRAINT commerce_taxe_dates CHECK (date_fin IS NULL OR date_fin > date_debut),
    CONSTRAINT commerce_taxe_parametre_positif CHECK (parametre_valeur IS NULL OR parametre_valeur >= 0),
    CONSTRAINT commerce_taxe_force_motive CHECK (
        montant_force IS NULL OR motif_montant_force IS NOT NULL
    ),
    CONSTRAINT commerce_taxe_source CHECK (parametre_source IN ('agent','categorie','import','dashboard'))
);

-- Une même taxe ne peut pas être due deux fois simultanément par un commerce
ALTER TABLE app.commerce_taxe DROP CONSTRAINT IF EXISTS commerce_taxe_pas_de_doublon;
ALTER TABLE app.commerce_taxe ADD CONSTRAINT commerce_taxe_pas_de_doublon
    EXCLUDE USING gist (
        commerce_id  WITH =,
        type_taxe_id WITH =,
        periode      WITH &&
    );

CREATE INDEX IF NOT EXISTS idx_commerce_taxe_commerce ON app.commerce_taxe (commerce_id) WHERE actif;
CREATE INDEX IF NOT EXISTS idx_commerce_taxe_type     ON app.commerce_taxe (commune_id, type_taxe_id) WHERE actif;

COMMENT ON COLUMN app.commerce_taxe.montant_force IS
'Montant imposé manuellement, hors barème. Exige un motif et déclenche une entrée au journal d''audit.';

-- ---------------------------------------------------------------------------
-- Exonérations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.exoneration (
    id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid        NOT NULL REFERENCES app.commune(id)      ON DELETE CASCADE,
    commerce_id       uuid        NOT NULL REFERENCES app.commerce(id)     ON DELETE CASCADE,
    type_taxe_id      uuid        REFERENCES ref.type_taxe(id)             ON DELETE RESTRICT,  -- NULL = toutes
    motif_id          uuid        NOT NULL REFERENCES ref.motif_exoneration(id) ON DELETE RESTRICT,

    taux_pct          numeric(5,2) NOT NULL DEFAULT 100.00,   -- 100 = exonération totale
    date_debut        date        NOT NULL,
    date_fin          date,
    periode           daterange   GENERATED ALWAYS AS (daterange(date_debut, date_fin, '[)')) STORED,

    justification     text        NOT NULL,
    justificatif_bucket text,
    justificatif_chemin text,

    -- Une exonération est une décision engageante : on trace qui l'accorde,
    -- qui la valide, et qui la révoque éventuellement.
    accorde_par       uuid        NOT NULL REFERENCES app.utilisateur(id),
    accorde_le        timestamptz NOT NULL DEFAULT now(),
    valide_par        uuid        REFERENCES app.utilisateur(id),
    valide_le         timestamptz,
    revoque_par       uuid        REFERENCES app.utilisateur(id),
    revoque_le        timestamptz,
    motif_revocation  text,

    CONSTRAINT exoneration_taux  CHECK (taux_pct > 0 AND taux_pct <= 100),
    CONSTRAINT exoneration_dates CHECK (date_fin IS NULL OR date_fin > date_debut)
);

CREATE INDEX IF NOT EXISTS idx_exoneration_commerce ON app.exoneration (commerce_id) WHERE revoque_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_exoneration_commune  ON app.exoneration (commune_id, date_debut DESC);

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['bareme_taxe','commerce_taxe'] LOOP
        EXECUTE format(
            'DROP TRIGGER IF EXISTS trg_%1$s_modifie_le ON app.%1$s;
             CREATE TRIGGER trg_%1$s_modifie_le BEFORE UPDATE ON app.%1$s
             FOR EACH ROW EXECUTE FUNCTION app.trg_maj_modifie_le();', t);
    END LOOP;
END
$$;
