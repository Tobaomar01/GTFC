-- ===========================================================================
--  0011 — Fonctions géospatiales
--
--  Rappel d'ordre des coordonnées : PostGIS attend ST_MakePoint(LONGITUDE,
--  LATITUDE) — l'inverse de ce qu'affichent Google Maps et la plupart des GPS.
--  L'inversion est la première cause de points qui « atterrissent » au milieu
--  de l'océan. Toutes les fonctions ci-dessous prennent donc explicitement
--  (longitude, latitude) dans cet ordre, et le vérifient.
--
--  Repère : la commune GTFC est autour de longitude -17,44 / latitude 14,69.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Construction d'un point à partir de coordonnées GPS, avec garde-fou
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.point_gps(longitude numeric, latitude numeric)
RETURNS geometry(Point, 4326)
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
BEGIN
    IF longitude IS NULL OR latitude IS NULL THEN
        RETURN NULL;
    END IF;
    IF longitude NOT BETWEEN -180 AND 180 OR latitude NOT BETWEEN -90 AND 90 THEN
        RAISE EXCEPTION 'Coordonnées hors limites : longitude=%, latitude=%', longitude, latitude
            USING HINT = 'Ordre attendu : point_gps(longitude, latitude). Le Sénégal a une longitude négative (~-17) et une latitude positive (~14).';
    END IF;
    RETURN ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326);
END;
$$;

COMMENT ON FUNCTION app.point_gps IS
'Crée un point WGS84. L''ordre est (longitude, latitude) — l''inverse de l''affichage habituel des GPS.';

-- ---------------------------------------------------------------------------
-- Détection automatique du quartier à partir d'un point GPS
--
-- Stratégie en trois temps, du plus fiable au plus tolérant :
--   1. le point est DANS un polygone de quartier              -> certain
--   2. le point est à moins de `tolerance_m` d'un quartier    -> probable
--      (précision GPS dégradée entre les immeubles)
--   3. aucun polygone disponible                              -> NULL,
--      l'agent choisit le quartier dans la liste
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.detecter_quartier(
    p_commune_id  uuid,
    p_longitude   numeric,
    p_latitude    numeric,
    p_tolerance_m integer DEFAULT 50
)
RETURNS TABLE (
    quartier_id   uuid,
    quartier_nom  text,
    zone_id       uuid,
    zone_nom      text,
    methode       text,
    distance_m    numeric
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_point geometry(Point, 4326);
BEGIN
    v_point := app.point_gps(p_longitude, p_latitude);
    IF v_point IS NULL THEN
        RETURN;
    END IF;

    -- 1. Contenance stricte
    RETURN QUERY
    SELECT q.id, q.nom, z.id, z.nom, 'polygone'::text, 0::numeric
    FROM app.quartier q
    JOIN app.zone z ON z.id = q.zone_id
    WHERE q.commune_id = p_commune_id
      AND q.archive_le IS NULL
      AND q.geom IS NOT NULL
      AND ST_Contains(q.geom, v_point)
    LIMIT 1;

    IF FOUND THEN
        RETURN;
    END IF;

    -- 2. Quartier le plus proche dans la tolérance.
    --    Le calcul de distance se fait en `geography` : le résultat est en
    --    mètres réels, pas en degrés.
    RETURN QUERY
    SELECT q.id, q.nom, z.id, z.nom, 'proximite'::text,
           round(ST_Distance(q.geom::geography, v_point::geography)::numeric, 1)
    FROM app.quartier q
    JOIN app.zone z ON z.id = q.zone_id
    WHERE q.commune_id = p_commune_id
      AND q.archive_le IS NULL
      AND q.geom IS NOT NULL
      AND ST_DWithin(q.geom::geography, v_point::geography, p_tolerance_m)
    ORDER BY q.geom::geography <-> v_point::geography
    LIMIT 1;

    -- 3. Aucun polygone renseigné : on ne renvoie rien, l'appelant bascule
    --    sur la saisie manuelle. Ne JAMAIS deviner un quartier au hasard :
    --    un commerce mal rattaché fausse les statistiques de la mairie.
    RETURN;
END;
$$;

COMMENT ON FUNCTION app.detecter_quartier IS
'Déduit le quartier d''un point GPS. Renvoie 0 ligne si aucun polygone n''est renseigné : l''agent saisit alors le quartier manuellement.';

-- ---------------------------------------------------------------------------
-- Le point est-il dans les limites de la commune ?
-- Sert à rejeter une saisie faite hors du territoire (agent en déplacement,
-- GPS parti en vrille).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.point_dans_commune(
    p_commune_id  uuid,
    p_longitude   numeric,
    p_latitude    numeric,
    p_tolerance_m integer DEFAULT 200
)
RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_point geometry(Point, 4326);
    v_geom  geometry;
BEGIN
    v_point := app.point_gps(p_longitude, p_latitude);
    IF v_point IS NULL THEN
        RETURN false;
    END IF;

    SELECT geom INTO v_geom FROM app.commune WHERE id = p_commune_id;

    -- Limites non renseignées : on ne peut rien affirmer, on laisse passer
    -- plutôt que de bloquer un agent sur le terrain.
    IF v_geom IS NULL THEN
        RETURN true;
    END IF;

    RETURN ST_DWithin(v_geom::geography, v_point::geography, p_tolerance_m);
END;
$$;

-- ---------------------------------------------------------------------------
-- Commerces à proximité — l'agent voit ce qui est déjà recensé autour de lui,
-- ce qui évite les doublons lors du recensement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.commerces_proches(
    p_commune_id uuid,
    p_longitude  numeric,
    p_latitude   numeric,
    p_rayon_m    integer DEFAULT 100,
    p_limite     integer DEFAULT 20
)
RETURNS TABLE (
    commerce_id   uuid,
    code          text,
    enseigne      text,
    categorie     text,
    statut_fiscal app.statut_fiscal,
    distance_m    numeric
)
LANGUAGE sql STABLE
AS $$
    SELECT c.id, c.code, c.enseigne, cat.libelle, c.statut_fiscal,
           round(ST_Distance(c.geom::geography, app.point_gps(p_longitude, p_latitude)::geography)::numeric, 1)
    FROM app.commerce c
    JOIN ref.categorie_commerce cat ON cat.id = c.categorie_id
    WHERE c.commune_id = p_commune_id
      AND c.archive_le IS NULL
      AND c.geom IS NOT NULL
      AND ST_DWithin(c.geom::geography,
                     app.point_gps(p_longitude, p_latitude)::geography,
                     p_rayon_m)
    ORDER BY c.geom::geography <-> app.point_gps(p_longitude, p_latitude)::geography
    LIMIT p_limite;
$$;

COMMENT ON FUNCTION app.commerces_proches IS
'Liste les commerces déjà recensés autour de l''agent. Premier rempart contre les doublons de recensement.';

-- ---------------------------------------------------------------------------
-- Distance entre l'agent et le commerce visité, en mètres.
-- Alimente app.visite.distance_commerce_m, qui sert au contrôle des tournées.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.distance_metres(p_a geometry, p_b geometry)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN p_a IS NULL OR p_b IS NULL THEN NULL
        ELSE round(ST_Distance(p_a::geography, p_b::geography)::numeric, 1)
    END;
$$;

-- ---------------------------------------------------------------------------
-- Recalcul en masse du rattachement des quartiers.
-- À lancer le jour où la mairie fournit enfin les polygones : tous les
-- commerces déjà recensés sont rerattachés d'après leurs coordonnées.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.recalculer_quartiers(p_commune_id uuid)
RETURNS TABLE (
    nb_traites      integer,
    nb_modifies     integer,
    nb_hors_zone    integer
)
LANGUAGE plpgsql
AS $$
DECLARE
    r          record;
    v_detect   record;
    v_traites  integer := 0;
    v_modifies integer := 0;
    v_hors     integer := 0;
BEGIN
    FOR r IN
        SELECT id, quartier_id, ST_X(geom)::numeric AS lon, ST_Y(geom)::numeric AS lat
        FROM app.commerce
        WHERE commune_id = p_commune_id AND archive_le IS NULL AND geom IS NOT NULL
    LOOP
        v_traites := v_traites + 1;

        SELECT * INTO v_detect
        FROM app.detecter_quartier(p_commune_id, r.lon, r.lat) LIMIT 1;

        IF v_detect.quartier_id IS NULL THEN
            v_hors := v_hors + 1;
        ELSIF v_detect.quartier_id <> r.quartier_id THEN
            UPDATE app.commerce
               SET quartier_id = v_detect.quartier_id,
                   zone_id     = v_detect.zone_id,
                   quartier_detecte_auto = true
             WHERE id = r.id;
            v_modifies := v_modifies + 1;
        END IF;
    END LOOP;

    RETURN QUERY SELECT v_traites, v_modifies, v_hors;
END;
$$;

COMMENT ON FUNCTION app.recalculer_quartiers IS
'Rerattache tous les commerces d''une commune après ajout des polygones de quartiers. Les modifications sont tracées par le journal d''audit.';
