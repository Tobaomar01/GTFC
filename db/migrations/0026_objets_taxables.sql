-- ===========================================================================
--  0026 — Dispositifs d'affichage et chantiers
--
--  Deux nouvelles familles d'objets taxables, à côté du commerce.
--
--  DISPOSITIF D'AFFICHAGE
--  Le rattachement à un commerce est OPTIONNEL : le redevable est l'annonceur.
--  Ce peut être le commerce lui-même, une profession libérale sans commerce,
--  ou une régie publicitaire tierce portant huit panneaux sur un boulevard.
--  Une ligne par support, chacun avec sa surface propre — c'est la seule
--  façon de calculer une taxe au m2 et par dispositif.
--
--  CHANTIER
--  Recensement seul pendant le pilote : aucune facturation. Mais tous les
--  champs nécessaires au calcul sont collectés dès maintenant. Le jour où la
--  commune délibère un tarif, il n'y aura pas de repassage terrain à
--  organiser sur des chantiers déjà refermés.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Dispositifs d'affichage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.dispositif_affichage (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id       uuid        NOT NULL REFERENCES app.commune(id)         ON DELETE RESTRICT,
    redevable_id     uuid        NOT NULL REFERENCES app.redevable(id)       ON DELETE RESTRICT,
    -- NULL pour une régie ou une profession libérale : c'est le cas normal
    -- pour AFF-05, pas une donnée manquante.
    commerce_id      uuid        REFERENCES app.commerce(id)                 ON DELETE SET NULL,
    type_affichage_id uuid       NOT NULL REFERENCES ref.type_affichage(id)  ON DELETE RESTRICT,

    code             text        NOT NULL,           -- GTFC-A-00042
    numero_sequence  integer     NOT NULL,

    -- --- Localisation ------------------------------------------------------
    -- Le recensement se fait par balayage systématique, rue par rue, et non
    -- redevable par redevable : la rue est donc portée par le dispositif
    -- lui-même, et pas déduite d'un commerce qui peut ne pas exister.
    rue_id           uuid        REFERENCES app.rue(id)      ON DELETE SET NULL,
    quartier_id      uuid        REFERENCES app.quartier(id) ON DELETE SET NULL,
    zone_id          uuid        REFERENCES app.zone(id)     ON DELETE SET NULL,
    adresse_libelle  text,
    geom             geometry(Point, 4326),
    precision_gps_m  numeric(6,2),

    -- --- Assiette de la taxe ----------------------------------------------
    surface_m2       numeric(8,2) NOT NULL,
    largeur_m        numeric(6,2),
    hauteur_m        numeric(6,2),
    -- Double face : un panneau recto-verso porte deux fois la surface.
    nb_faces         smallint    NOT NULL DEFAULT 1,
    lumineux         boolean     NOT NULL DEFAULT false,
    texte_affiche    text,

    -- --- Cycle de vie ------------------------------------------------------
    -- La taxe est annuelle, exigible au plus tard le 31 mars, le premier
    -- paiement intervenant juste après l'apposition.
    date_apposition  date,
    date_constat     date        NOT NULL DEFAULT current_date,
    date_depose      date,
    numero_autorisation text,

    actif            boolean     NOT NULL DEFAULT true,

    -- --- Traçabilité terrain ----------------------------------------------
    agent_recenseur_id uuid      REFERENCES app.utilisateur(id),
    notes            text,
    version          integer     NOT NULL DEFAULT 1,
    origine          text        NOT NULL DEFAULT 'terrain',

    cree_le          timestamptz NOT NULL DEFAULT now(),
    cree_par         uuid        REFERENCES app.utilisateur(id),
    modifie_le       timestamptz NOT NULL DEFAULT now(),
    modifie_par      uuid        REFERENCES app.utilisateur(id),
    archive_le       timestamptz,
    archive_par      uuid        REFERENCES app.utilisateur(id),
    motif_archivage  text,

    CONSTRAINT affichage_code_unique UNIQUE (commune_id, code),
    CONSTRAINT affichage_surface_positive CHECK (surface_m2 > 0),
    CONSTRAINT affichage_faces CHECK (nb_faces BETWEEN 1 AND 4),
    CONSTRAINT affichage_dimensions CHECK (
        (largeur_m IS NULL AND hauteur_m IS NULL)
        OR (largeur_m > 0 AND hauteur_m > 0)
    ),
    -- Un dispositif déposé après avoir été apposé, c'est l'ordre du monde.
    CONSTRAINT affichage_dates_coherentes CHECK (
        date_depose IS NULL OR date_apposition IS NULL OR date_depose >= date_apposition
    ),
    CONSTRAINT affichage_archivage_motive CHECK (
        archive_le IS NULL OR motif_archivage IS NOT NULL
    ),
    CONSTRAINT affichage_origine CHECK (origine IN ('terrain', 'import', 'dashboard', 'reprise'))
);

COMMENT ON TABLE app.dispositif_affichage IS
'Un support d''affichage = une ligne = une assiette. Le redevable est l''annonceur ; le rattachement à un commerce est optionnel.';
COMMENT ON COLUMN app.dispositif_affichage.commerce_id IS
'NULL pour une régie publicitaire ou une profession libérale. Absence normale, pas donnée manquante.';
COMMENT ON COLUMN app.dispositif_affichage.nb_faces IS
'Un panneau recto-verso expose deux fois sa surface. La taxe se calcule sur surface_m2 × nb_faces.';

CREATE INDEX IF NOT EXISTS idx_affichage_redevable ON app.dispositif_affichage (redevable_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_affichage_commune   ON app.dispositif_affichage (commune_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_affichage_commerce  ON app.dispositif_affichage (commerce_id) WHERE commerce_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affichage_rue       ON app.dispositif_affichage (rue_id) WHERE rue_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_affichage_geom      ON app.dispositif_affichage USING GIST (geom);

-- ---------------------------------------------------------------------------
-- Chantiers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.chantier (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id       uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE RESTRICT,
    redevable_id     uuid        NOT NULL REFERENCES app.redevable(id) ON DELETE RESTRICT,

    code             text        NOT NULL,           -- GTFC-C-00042
    numero_sequence  integer     NOT NULL,
    libelle          text,

    rue_id           uuid        REFERENCES app.rue(id)      ON DELETE SET NULL,
    quartier_id      uuid        REFERENCES app.quartier(id) ON DELETE SET NULL,
    zone_id          uuid        REFERENCES app.zone(id)     ON DELETE SET NULL,
    adresse_libelle  text,
    geom             geometry(Point, 4326),

    surface_m2       numeric(8,2) NOT NULL,
    date_constat     date        NOT NULL DEFAULT current_date,
    duree_prevue_jours integer,
    date_fin_prevue  date,
    date_fin_constatee date,

    numero_autorisation text,     -- permis de construire présenté à l'agent
    autorisation_vue boolean     NOT NULL DEFAULT false,

    statut           app.statut_chantier NOT NULL DEFAULT 'en_cours',

    -- Le pilote recense sans facturer. Le drapeau est porté par la ligne, et
    -- non déduit d'un paramètre global : le jour où la commune délibère, les
    -- chantiers déjà clos ne doivent pas devenir rétroactivement facturables.
    facturable       boolean     NOT NULL DEFAULT false,

    agent_recenseur_id uuid      REFERENCES app.utilisateur(id),
    derniere_visite_le timestamptz,
    notes            text,
    version          integer     NOT NULL DEFAULT 1,

    cree_le          timestamptz NOT NULL DEFAULT now(),
    cree_par         uuid        REFERENCES app.utilisateur(id),
    modifie_le       timestamptz NOT NULL DEFAULT now(),
    modifie_par      uuid        REFERENCES app.utilisateur(id),
    archive_le       timestamptz,
    motif_archivage  text,

    CONSTRAINT chantier_code_unique UNIQUE (commune_id, code),
    CONSTRAINT chantier_surface_positive CHECK (surface_m2 > 0),
    CONSTRAINT chantier_duree_positive CHECK (duree_prevue_jours IS NULL OR duree_prevue_jours > 0),
    CONSTRAINT chantier_fin_coherente CHECK (
        date_fin_constatee IS NULL OR date_fin_constatee >= date_constat
    ),
    -- Un chantier déclaré terminé sans date de fin constatée laisserait
    -- l'occupation ouverte indéfiniment dans les statistiques.
    CONSTRAINT chantier_fin_datee CHECK (
        statut <> 'termine' OR date_fin_constatee IS NOT NULL
    ),
    CONSTRAINT chantier_archivage_motive CHECK (
        archive_le IS NULL OR motif_archivage IS NOT NULL
    )
);

COMMENT ON TABLE app.chantier IS
'Occupation temporaire du domaine public par un chantier. Recensé mais non facturé pendant le pilote — facturable reste false jusqu''à délibération.';
COMMENT ON COLUMN app.chantier.facturable IS
'Porté par la ligne et non par un paramètre global : activer le tarif ne doit pas rendre facturables des chantiers déjà clos.';

CREATE INDEX IF NOT EXISTS idx_chantier_redevable ON app.chantier (redevable_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_chantier_commune   ON app.chantier (commune_id, statut) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_chantier_geom      ON app.chantier USING GIST (geom);
-- Chantiers à repasser : le terme est dépassé et la fin n'a pas été constatée.
CREATE INDEX IF NOT EXISTS idx_chantier_a_revoir  ON app.chantier (commune_id, date_fin_prevue)
    WHERE statut IN ('en_cours', 'prolonge') AND archive_le IS NULL;

-- Un chantier cumule les formes d'occupation : dépôt de matériaux ET benne
-- ET échafaudage. Une table de liaison plutôt qu'un tableau de codes : elle
-- garantit que chaque code existe réellement au référentiel.
CREATE TABLE IF NOT EXISTS app.chantier_occupation (
    chantier_id  uuid NOT NULL REFERENCES app.chantier(id)                  ON DELETE CASCADE,
    type_id      uuid NOT NULL REFERENCES ref.type_occupation_chantier(id)  ON DELETE RESTRICT,
    surface_m2   numeric(8,2),
    cree_le      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chantier_id, type_id)
);

-- ---------------------------------------------------------------------------
-- Numérotation des nouveaux objets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generer_code_objet(p_commune_id uuid, p_lettre text)
RETURNS TABLE (code text, numero_sequence integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_prefixe text;
    v_seq     integer;
BEGIN
    SELECT coalesce(p.prefixe_code_commerce, c.code)
      INTO v_prefixe
      FROM app.commune c
      LEFT JOIN app.commune_parametre p ON p.commune_id = c.id
     WHERE c.id = p_commune_id;

    IF v_prefixe IS NULL THEN
        RAISE EXCEPTION 'Commune % introuvable', p_commune_id;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(p_lettre || p_commune_id::text));

    -- Les colonnes sont préfixées par un alias : `numero_sequence` est aussi
    -- le nom d'un paramètre de sortie de cette fonction, et PostgreSQL refuse
    -- de trancher entre les deux.
    IF p_lettre = 'A' THEN
        SELECT coalesce(max(d.numero_sequence), 0) + 1 INTO v_seq
          FROM app.dispositif_affichage d WHERE d.commune_id = p_commune_id;
    ELSIF p_lettre = 'C' THEN
        SELECT coalesce(max(ch.numero_sequence), 0) + 1 INTO v_seq
          FROM app.chantier ch WHERE ch.commune_id = p_commune_id;
    ELSE
        RAISE EXCEPTION 'Lettre d''objet inconnue : % (attendu A ou C)', p_lettre;
    END IF;

    RETURN QUERY SELECT
        format('%s-%s-%s', v_prefixe, p_lettre, lpad(v_seq::text, 5, '0')),
        v_seq;
END;
$$;

COMMENT ON FUNCTION app.generer_code_objet IS
'Numérotation des dispositifs d''affichage (A) et des chantiers (C), sur le modèle des codes commerce.';

-- ===========================================================================
--  Reprise : les enseignes saisies sur la fiche commerce deviennent
--  des dispositifs d'affichage à part entière
--
--  Le modèle précédent portait enseigne_surface_m2 et enseigne_lumineuse
--  comme deux colonnes du commerce : un commerce ne pouvait donc avoir
--  qu'une seule enseigne, et une régie sans commerce n'existait pas.
-- ===========================================================================
DO $$
DECLARE
    v_c      record;
    v_type   uuid;
    v_code   text;
    v_seq    integer;
    v_crees  integer := 0;
BEGIN
    FOR v_c IN
        SELECT c.id, c.commune_id, c.redevable_id, c.enseigne,
               c.enseigne_surface_m2, c.enseigne_lumineuse,
               c.quartier_id, c.zone_id, c.rue_id, c.adresse_libelle,
               c.geom, c.agent_recenseur_id, c.date_recensement, c.cree_par
          FROM app.commerce c
         WHERE c.enseigne_surface_m2 IS NOT NULL
           AND c.enseigne_surface_m2 > 0
           AND c.archive_le IS NULL
           AND NOT EXISTS (SELECT 1 FROM app.dispositif_affichage d
                            WHERE d.commerce_id = c.id AND d.archive_le IS NULL)
    LOOP
        SELECT id INTO v_type FROM ref.type_affichage
         WHERE commune_id = v_c.commune_id
           AND code = CASE WHEN v_c.enseigne_lumineuse THEN 'AFF-01' ELSE 'AFF-02' END;
        CONTINUE WHEN v_type IS NULL;

        SELECT g.code, g.numero_sequence INTO v_code, v_seq
          FROM app.generer_code_objet(v_c.commune_id, 'A') g;

        INSERT INTO app.dispositif_affichage (
            commune_id, redevable_id, commerce_id, type_affichage_id,
            code, numero_sequence, rue_id, quartier_id, zone_id,
            adresse_libelle, geom, surface_m2, lumineux, texte_affiche,
            date_constat, agent_recenseur_id, origine, cree_par
        ) VALUES (
            v_c.commune_id, v_c.redevable_id, v_c.id, v_type,
            v_code, v_seq, v_c.rue_id, v_c.quartier_id, v_c.zone_id,
            v_c.adresse_libelle, v_c.geom, v_c.enseigne_surface_m2,
            v_c.enseigne_lumineuse, v_c.enseigne,
            coalesce(v_c.date_recensement, current_date),
            v_c.agent_recenseur_id, 'reprise', v_c.cree_par
        );
        v_crees := v_crees + 1;
    END LOOP;

    RAISE NOTICE 'Reprise affichage : % enseigne(s) devenue(s) dispositif(s).', v_crees;
END
$$;

-- Les colonnes d'origine sont vidées : deux sources pour la même assiette
-- finissent toujours par diverger, et c'est alors la facture qui tranche.
UPDATE app.commerce
   SET enseigne_surface_m2 = NULL
 WHERE enseigne_surface_m2 IS NOT NULL;

COMMENT ON COLUMN app.commerce.enseigne_surface_m2 IS
'OBSOLÈTE depuis la migration 0026. L''enseigne est un objet taxable à part entière : voir app.dispositif_affichage. Colonne conservée le temps que l''application mobile déployée sur le terrain soit mise à jour.';
COMMENT ON COLUMN app.commerce.enseigne_lumineuse IS
'OBSOLÈTE depuis la migration 0026. Porté par app.dispositif_affichage.lumineux.';
