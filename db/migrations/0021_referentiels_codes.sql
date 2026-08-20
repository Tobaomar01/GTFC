-- ===========================================================================
--  0021 — Référentiels codifiés du document « Référentiel des redevables »
--
--  Le document de juin 2026 fixe une codification stable : ACT-xx pour les
--  activités, EMP-xx pour les emplacements, MAR-xx pour les marchés, AFF-xx
--  pour les dispositifs d'affichage, CHA-xx pour les chantiers.
--
--  Ces codes deviennent la clé métier. Les agents ne saisissent plus de texte
--  libre, et une reprise de données conserve le même identifiant d'une année
--  sur l'autre — c'est ce qui rend les statistiques comparables.
--
--  Statut des libellés : ceux marqués « à obtenir » ou « à créer » dans le
--  document sont insérés avec a_remplacer = true. Ils apparaîtront dans
--  app.v_donnees_a_remplacer jusqu'à validation par le receveur municipal.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Le code de référence sur les catégories d'activité
-- ---------------------------------------------------------------------------
-- On ajoute une colonne plutôt que de réutiliser `code` : `code` est la clé
-- locale de la commune (elle peut vouloir garder sa propre numérotation),
-- `code_reference` est le code national du référentiel partagé.
ALTER TABLE ref.categorie_commerce
    ADD COLUMN IF NOT EXISTS code_reference text,
    ADD COLUMN IF NOT EXISTS secteur        text,
    ADD COLUMN IF NOT EXISTS effectif_pdc   integer;

COMMENT ON COLUMN ref.categorie_commerce.code_reference IS
'Code du référentiel des redevables (ACT-01 à ACT-99). Stable entre communes et entre versions.';
COMMENT ON COLUMN ref.categorie_commerce.effectif_pdc IS
'Effectif relevé au Plan de Développement Communal 2021-2025. Sert de repère de couverture : recensé / attendu.';

CREATE INDEX IF NOT EXISTS idx_categorie_code_reference
    ON ref.categorie_commerce (commune_id, code_reference)
    WHERE code_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Types de dispositifs d'affichage (AFF)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.type_affichage (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    code            text        NOT NULL,          -- AFF-01 …
    libelle         text        NOT NULL,
    description     text,

    -- Un dispositif « occasionnel » (gonflable, réclame sonore) se paie
    -- d'avance : il n'entre pas dans le cycle annuel ordinaire.
    paiement_avance boolean     NOT NULL DEFAULT false,

    -- Un panneau de régie n'est presque jamais rattaché à un commerce.
    commerce_rare   boolean     NOT NULL DEFAULT false,

    -- AFF-06 (plaques professionnelles réglementées) est RÉSERVÉ et laissé
    -- vacant : les agents ne le saisissent pas, l'assujettissement doit
    -- d'abord être tranché avec la municipalité. Le code est occupé pour
    -- qu'aucun autre dispositif ne vienne s'y glisser.
    recensable      boolean     NOT NULL DEFAULT true,
    motif_non_recensable text,

    ordre_affichage smallint    NOT NULL DEFAULT 0,
    actif           boolean     NOT NULL DEFAULT true,

    a_remplacer     boolean     NOT NULL DEFAULT false,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    modifie_le      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT type_affichage_code_unique UNIQUE (commune_id, code),
    CONSTRAINT type_affichage_non_recensable_motive CHECK (
        recensable OR motif_non_recensable IS NOT NULL
    )
);

COMMENT ON TABLE ref.type_affichage IS
'Dispositifs d''affichage soumis à la taxe publicitaire (AFF-01 à AFF-07). AFF-06 est réservé et non recensable.';

-- ---------------------------------------------------------------------------
-- Types d'occupation de chantier (CHA)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.type_occupation_chantier (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id) ON DELETE CASCADE,
    code            text        NOT NULL,          -- CHA-01 …
    libelle         text        NOT NULL,
    description     text,
    ordre_affichage smallint    NOT NULL DEFAULT 0,
    actif           boolean     NOT NULL DEFAULT true,

    a_remplacer     boolean     NOT NULL DEFAULT false,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    modifie_le      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT type_chantier_code_unique UNIQUE (commune_id, code)
);

COMMENT ON TABLE ref.type_occupation_chantier IS
'Formes d''occupation temporaire du domaine public par un chantier (CHA-01 à CHA-06). Recensement seul pendant le pilote.';

-- ---------------------------------------------------------------------------
-- Motifs de contestation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.motif_contestation (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        REFERENCES app.commune(id) ON DELETE CASCADE,  -- NULL = motif global
    code            text        NOT NULL,
    libelle         text        NOT NULL,

    -- Certains motifs appellent un constat sur place : « commerce fermé »
    -- ne se vérifie pas depuis un bureau.
    visite_recommandee boolean  NOT NULL DEFAULT false,
    -- « Paiement effectué mais non enregistré » se tranche par le rapprochement
    -- comptable, pas par le superviseur de zone.
    escalade_receveur  boolean  NOT NULL DEFAULT false,
    piece_jointe_utile boolean  NOT NULL DEFAULT false,

    ordre_affichage smallint    NOT NULL DEFAULT 0,
    actif           boolean     NOT NULL DEFAULT true,
    cree_le         timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT motif_contestation_code_unique UNIQUE (commune_id, code)
);

-- ===========================================================================
--  Alimentation, pour chaque commune existante
--
--  Un DO ... LOOP plutôt qu'un INSERT ... SELECT : la plateforme est
--  multi-communes, et une commune créée demain doit recevoir le même
--  référentiel. La fonction app.installer_referentiel_codes() plus bas est
--  appelée ici pour l'existant, et par la création de commune pour la suite.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.installer_referentiel_codes(p_commune uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    -- --- Dispositifs d'affichage (AFF) -------------------------------------
    INSERT INTO ref.type_affichage
        (commune_id, code, libelle, description, paiement_avance,
         commerce_rare, recensable, motif_non_recensable, ordre_affichage)
    VALUES
        (p_commune, 'AFF-01', 'Enseigne lumineuse',
         'Enseigne du commerce, éclairée ou rétro-éclairée.', false, false, true, NULL, 1),
        (p_commune, 'AFF-02', 'Enseigne non lumineuse',
         'Enseigne peinte ou en relief, sans éclairage propre.', false, false, true, NULL, 2),
        (p_commune, 'AFF-03', 'Auvent',
         'Bâche ou store portant une mention commerciale.', false, false, true, NULL, 3),
        (p_commune, 'AFF-04', 'Pré-enseigne',
         'Signalisation à distance du commerce, y compris directionnelle.', false, false, true, NULL, 4),
        (p_commune, 'AFF-05', 'Panneau d''affichage',
         'Support publicitaire. Le redevable est souvent une régie, sans commerce rattaché.',
         false, true, true, NULL, 5),
        (p_commune, 'AFF-06', 'Plaque professionnelle réglementée',
         'Notaires, avocats, médecins. Code réservé.', false, true, false,
         'Hors recensement : dimensions et contenu relèvent d''une déontologie professionnelle. '
         'Assujettissement à trancher avec la municipalité.', 6),
        (p_commune, 'AFF-07', 'Dispositif occasionnel',
         'Gonflable, réclame sonore, animation temporaire. Paiement d''avance.',
         true, false, true, NULL, 7)
    ON CONFLICT (commune_id, code) DO NOTHING;

    -- --- Occupations de chantier (CHA) -------------------------------------
    INSERT INTO ref.type_occupation_chantier
        (commune_id, code, libelle, description, ordre_affichage)
    VALUES
        (p_commune, 'CHA-01', 'Dépôt de matériaux',
         'Sable, gravier, ciment, fer déposés sur trottoir ou chaussée.', 1),
        (p_commune, 'CHA-02', 'Échafaudage',
         'Emprise au sol de l''échafaudage sur le domaine public.', 2),
        (p_commune, 'CHA-03', 'Palissade de chantier',
         'Clôture de chantier débordant sur le trottoir.', 3),
        (p_commune, 'CHA-04', 'Benne à gravats',
         'Conteneur déposé sur la voirie.', 4),
        (p_commune, 'CHA-05', 'Engin de chantier',
         'Grue, malaxeur, camion stationné durablement.', 5),
        (p_commune, 'CHA-06', 'Occupation de chaussée',
         'Neutralisation partielle de la voie de circulation.', 6)
    ON CONFLICT (commune_id, code) DO NOTHING;

    -- --- Types d'emplacement (EMP) -----------------------------------------
    -- Les quatre premiers sont hors marché, les quatre suivants dans un marché.
    -- surface_type_m2 reste NULL : elle sort de la délibération, pas d'ici.
    INSERT INTO ref.type_emplacement
        (commune_id, code, libelle, ordre_affichage, a_remplacer)
    VALUES
        (p_commune, 'EMP-01', 'Local commercial en dur',  1, false),
        (p_commune, 'EMP-02', 'Étalage sur trottoir',     2, false),
        (p_commune, 'EMP-03', 'Commerce ambulant',        3, false),
        (p_commune, 'EMP-04', 'Cantine',                  4, false),
        (p_commune, 'EMP-05', 'Étal / table',             5, false),
        (p_commune, 'EMP-06', 'Hangar',                   6, false),
        (p_commune, 'EMP-07', 'Magasin de marché',        7, false)
    ON CONFLICT (commune_id, code) DO NOTHING;

    -- --- Motifs de contestation --------------------------------------------
    INSERT INTO ref.motif_contestation
        (commune_id, code, libelle, visite_recommandee, escalade_receveur,
         piece_jointe_utile, ordre_affichage)
    VALUES
        (p_commune, 'CTS-01', 'Catégorie d''activité erronée',      false, false, false, 1),
        (p_commune, 'CTS-02', 'Montant de taxe incorrect',          false, true,  false, 2),
        (p_commune, 'CTS-03', 'Emplacement mal saisi',              true,  false, false, 3),
        (p_commune, 'CTS-04', 'Commerce fermé ou déplacé',          true,  false, false, 4),
        (p_commune, 'CTS-05', 'Double enregistrement',              false, false, false, 5),
        (p_commune, 'CTS-06', 'Paiement effectué mais non enregistré', false, true, true, 6)
    ON CONFLICT (commune_id, code) DO NOTHING;
END;
$$;

COMMENT ON FUNCTION app.installer_referentiel_codes(uuid) IS
'Installe les référentiels codifiés AFF / CHA / EMP / motifs de contestation pour une commune. Idempotente.';

DO $$
DECLARE c uuid;
BEGIN
    FOR c IN SELECT id FROM app.commune LOOP
        PERFORM app.installer_referentiel_codes(c);
    END LOOP;
END
$$;
