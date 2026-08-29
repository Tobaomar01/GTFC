-- 0044 — Registre des décisions dérogatoires
--
-- Séparée de 0043 : PostgreSQL n'autorise pas l'usage d'une valeur
-- d'énumération ajoutée dans la même transaction que son ajout.

CREATE TABLE IF NOT EXISTS app.decision_derogatoire (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id        uuid NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    nature            text NOT NULL,
    commerce_id       uuid REFERENCES app.commerce(id)       ON DELETE RESTRICT,
    commerce_taxe_id  uuid REFERENCES app.commerce_taxe(id)  ON DELETE RESTRICT,
    exoneration_id    uuid REFERENCES app.exoneration(id)    ON DELETE RESTRICT,

    montant_calcule      numeric(14,0),
    montant_retenu       numeric(14,0),
    taux_exoneration_pct numeric(5,2),
    motif                text NOT NULL,

    saisi_par         uuid NOT NULL REFERENCES app.utilisateur(id),
    saisi_le          timestamptz NOT NULL DEFAULT now(),
    valide_par        uuid REFERENCES app.utilisateur(id),
    valide_le         timestamptz,

    CONSTRAINT derogation_nature_connue
        CHECK (nature IN ('montant_force','exoneration')),
    CONSTRAINT derogation_double_verification
        CHECK (valide_par IS NULL OR valide_par <> saisi_par),
    CONSTRAINT derogation_validation_datee
        CHECK ((valide_par IS NULL) = (valide_le IS NULL)),
    CONSTRAINT derogation_motif_non_vide
        CHECK (length(btrim(motif)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_derogation_commerce ON app.decision_derogatoire (commerce_id);

-- Un montant forcé n'est opposable qu'une fois validé. Le calcul de
-- liquidation ne doit interroger que cette vue.
CREATE OR REPLACE VIEW app.v_montant_force_opposable AS
    SELECT commerce_taxe_id, montant_retenu
      FROM app.decision_derogatoire
     WHERE nature = 'montant_force'
       AND valide_par IS NOT NULL
       AND commerce_taxe_id IS NOT NULL;

-- L'exonération existante avait déjà accorde_par et valide_par, mais rien
-- n'interdisait que ce soit la même personne.
ALTER TABLE app.exoneration DROP CONSTRAINT IF EXISTS exoneration_double_verification;
ALTER TABLE app.exoneration ADD  CONSTRAINT exoneration_double_verification
    CHECK (valide_par IS NULL OR valide_par <> accorde_par);

CREATE OR REPLACE VIEW app.v_exoneration_opposable AS
    SELECT * FROM app.exoneration WHERE valide_par IS NOT NULL;

COMMENT ON TABLE app.decision_derogatoire IS
'Registre réservé aux chefs de projet. Montants forcés et exonérations : les deux façons d''effacer une dette (FR-020k).';
COMMENT ON VIEW app.v_exoneration_opposable IS
'Seules les exonérations validées réduisent un montant dû (FR-020i).';
