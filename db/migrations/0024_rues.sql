-- ===========================================================================
--  0024 — Référentiel des rues (phase 0 du document redevables)
--
--  POURQUOI UNE TABLE ET PAS UN CHAMP TEXTE
--
--  Si l'agent saisit « rue GT 63 », « Rue GT63 » et « rue gt 63 » selon le
--  jour, aucune agrégation par rue n'est possible et la reprise se fait à la
--  main, ligne par ligne, sur plusieurs milliers d'enregistrements.
--
--  La rue devient donc une entité choisie dans une liste, jamais tapée.
--
--  CE QUE CELA DÉBLOQUE
--   · le suivi de couverture pendant le recensement — quelles rues restent
--     à faire, une question à laquelle personne ne sait répondre aujourd'hui
--   · le taux de collecte par rue en régime établi
--   · l'affectation des agents par segment plutôt que par zone entière
--   · le rattachement automatique d'un redevable à sa rue par le GPS
--
--  La géométrie est optionnelle. Sans elle, la rue reste utilisable comme
--  étiquette : c'est le rattachement automatique et la carte par segments
--  qui attendent le tracé, pas le recensement.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.rue (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id      uuid        NOT NULL REFERENCES app.commune(id)   ON DELETE RESTRICT,
    quartier_id     uuid        REFERENCES app.quartier(id)           ON DELETE SET NULL,
    zone_id         uuid        REFERENCES app.zone(id)               ON DELETE SET NULL,

    -- Code court manipulable par les agents : GT-63, C-41, BD-GT.
    code            text        NOT NULL,
    nom             text        NOT NULL,
    nom_normalise   text        GENERATED ALWAYS AS (app.normaliser(nom)) STORED,

    -- Une même rue porte plusieurs graphies selon la source. On garde les
    -- variantes pour que la recherche de l'agent aboutisse quel que soit le
    -- libellé qu'il a en tête, sans multiplier les lignes.
    variantes       text[]      NOT NULL DEFAULT '{}',

    -- Une rue peut traverser plusieurs quartiers ; quartier_id porte le
    -- rattachement principal, celui qui sert au regroupement statistique.
    type_voie       text,       -- rue, boulevard, avenue, ruelle, impasse
    source          text        NOT NULL DEFAULT 'a_saisir',
    -- pdc | osm | cadastre | terrain | a_saisir

    -- MultiLineString : une rue est souvent découpée en plusieurs tronçons
    -- dans OpenStreetMap, et les recoller en une seule ligne perdrait
    -- l'information sans rien apporter.
    geom            geometry(MultiLineString, 4326),
    longueur_m      numeric(10,1),

    -- --- Couverture du recensement ---------------------------------------
    statut_couverture      app.statut_couverture NOT NULL DEFAULT 'non_commencee',
    couverture_debutee_le  timestamptz,
    couverture_terminee_le timestamptz,
    couverture_par         uuid REFERENCES app.utilisateur(id),
    nb_objets_recenses     integer NOT NULL DEFAULT 0,

    actif           boolean     NOT NULL DEFAULT true,
    a_remplacer     boolean     NOT NULL DEFAULT false,

    cree_le         timestamptz NOT NULL DEFAULT now(),
    cree_par        uuid        REFERENCES app.utilisateur(id),
    modifie_le      timestamptz NOT NULL DEFAULT now(),
    modifie_par     uuid        REFERENCES app.utilisateur(id),
    archive_le      timestamptz,

    CONSTRAINT rue_code_unique_par_commune UNIQUE (commune_id, code),
    CONSTRAINT rue_source_connue CHECK (
        source IN ('pdc', 'osm', 'cadastre', 'terrain', 'a_saisir')
    ),
    -- Une rue « terminée » sans date de fin ne veut rien dire : c'est la date
    -- qui permet de dire quand le recensement d'un secteur s'est achevé.
    CONSTRAINT rue_couverture_datee CHECK (
        statut_couverture <> 'terminee' OR couverture_terminee_le IS NOT NULL
    )
);

COMMENT ON TABLE app.rue IS
'Référentiel des voies de la commune. Doit être constitué AVANT le recensement terrain : sans lui, les noms de rue sont saisis en texte libre et toute statistique par rue devient impossible.';
COMMENT ON COLUMN app.rue.variantes IS
'Graphies alternatives rencontrées dans le PDC, OpenStreetMap ou le cadastre. Alimentent la recherche, pas l''affichage.';
COMMENT ON COLUMN app.rue.nb_objets_recenses IS
'Compteur dénormalisé, tenu par déclencheur. Évite un COUNT sur plusieurs milliers de lignes à chaque affichage de la carte de couverture.';

CREATE INDEX IF NOT EXISTS idx_rue_commune    ON app.rue (commune_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_rue_quartier   ON app.rue (commune_id, quartier_id) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_rue_couverture ON app.rue (commune_id, statut_couverture) WHERE archive_le IS NULL;
CREATE INDEX IF NOT EXISTS idx_rue_geom       ON app.rue USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_rue_nom        ON app.rue USING GIN (nom_normalise gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Rattachement des objets existants
-- ---------------------------------------------------------------------------
ALTER TABLE app.commerce
    ADD COLUMN IF NOT EXISTS rue_id            uuid REFERENCES app.rue(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS numero_rue        text,
    ADD COLUMN IF NOT EXISTS rue_detectee_auto boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_commerce_rue ON app.commerce (rue_id) WHERE rue_id IS NOT NULL;

COMMENT ON COLUMN app.commerce.rue_detectee_auto IS
'true = rue déduite du GPS par proximité au tracé ; false = choisie par l''agent. Une déduction reste vérifiable sur le terrain.';

-- ---------------------------------------------------------------------------
-- Rattachement automatique d'un point à la rue la plus proche
--
--  Le seuil de 25 m n'est pas arbitraire : au-delà, dans un tissu urbain
--  dense comme Fass ou Colobane, la « rue la plus proche » est souvent la
--  parallèle. Mieux vaut ne rien proposer que proposer faux — l'agent
--  choisit alors dans la liste.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.detecter_rue(
    p_commune  uuid,
    p_geom     geometry,
    p_seuil_m  numeric DEFAULT 25
)
RETURNS TABLE (rue_id uuid, nom text, distance_m numeric)
LANGUAGE sql
STABLE
AS $$
    SELECT r.id,
           r.nom,
           round(ST_Distance(r.geom::geography, p_geom::geography)::numeric, 1)
      FROM app.rue r
     WHERE r.commune_id = p_commune
       AND r.archive_le IS NULL
       AND r.geom IS NOT NULL
       AND p_geom IS NOT NULL
       AND ST_DWithin(r.geom::geography, p_geom::geography, p_seuil_m)
     ORDER BY r.geom <-> p_geom
     LIMIT 1;
$$;

COMMENT ON FUNCTION app.detecter_rue(uuid, geometry, numeric) IS
'Rue la plus proche d''un point, dans un rayon par défaut de 25 m. Ne retourne rien plutôt qu''une réponse douteuse : au-delà, la rue voisine est aussi probable.';

-- ---------------------------------------------------------------------------
-- Recalcul en masse, après chargement d'un tracé de voirie
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.recalculer_rues(p_commune uuid, p_seuil_m numeric DEFAULT 25)
RETURNS TABLE (rattaches integer, sans_rue integer)
LANGUAGE plpgsql
AS $$
DECLARE v_ok integer;
BEGIN
    -- Seuls les rattachements AUTOMATIQUES sont recalculés. Un choix d'agent
    -- sur le terrain prime sur une déduction : il a vu la plaque, pas nous.
    UPDATE app.commerce c
       SET rue_id            = d.rue_id,
           rue_detectee_auto = true,
           modifie_le        = now()
      FROM LATERAL app.detecter_rue(c.commune_id, c.geom, p_seuil_m) d
     WHERE c.commune_id = p_commune
       AND c.archive_le IS NULL
       AND c.geom IS NOT NULL
       AND (c.rue_id IS NULL OR c.rue_detectee_auto);
    GET DIAGNOSTICS v_ok = ROW_COUNT;

    RETURN QUERY
    SELECT v_ok,
           (SELECT count(*)::integer FROM app.commerce
             WHERE commune_id = p_commune AND archive_le IS NULL AND rue_id IS NULL);
END;
$$;

COMMENT ON FUNCTION app.recalculer_rues(uuid, numeric) IS
'Rerattache les objets géolocalisés à leur rue après chargement d''un tracé. Ne touche pas aux rues choisies manuellement par un agent.';

-- ---------------------------------------------------------------------------
-- Vue de couverture : où en est le recensement, rue par rue
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_couverture_rues AS
SELECT r.commune_id,
       r.id AS rue_id,
       r.code,
       r.nom,
       q.nom  AS quartier,
       z.nom  AS zone,
       r.statut_couverture,
       r.couverture_terminee_le,
       u.nom_complet AS agent,
       r.nb_objets_recenses,
       (r.geom IS NOT NULL) AS tracee,
       r.longueur_m
  FROM app.rue r
  LEFT JOIN app.quartier q    ON q.id = r.quartier_id
  LEFT JOIN app.zone z        ON z.id = r.zone_id
  LEFT JOIN app.utilisateur u ON u.id = r.couverture_par
 WHERE r.archive_le IS NULL AND r.actif
 ORDER BY z.nom NULLS LAST, q.nom NULLS LAST, r.nom;

COMMENT ON VIEW app.v_couverture_rues IS
'Avancement du recensement rue par rue. Répond à « que reste-t-il à faire ? », question sans réponse tant que la rue n''est pas une entité.';
