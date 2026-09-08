-- ===========================================================================
--  SEED 0002 — Commune GTFC, 3 zones, 15 quartiers
--
--  ############  DONNÉES PROVISOIRES  ############
--  Les seuls éléments RÉELS ici sont ceux du cahier des charges : le nom de
--  la commune, sa superficie (2 km²), sa population (~52 000), le nombre de
--  zones (3) et de quartiers (15).
--
--  Sont PROVISOIRES et marqués a_remplacer = true :
--    - les NOMS des zones et des quartiers
--    - les POLYGONES : ce sont des rectangles arbitraires découpant la
--      commune en grille 5×3. Ils permettent de tester dès maintenant la
--      détection automatique du quartier par GPS, mais ils ne correspondent
--      à AUCUNE limite administrative réelle.
--    - les limites de la commune elle-même (rectangle approché autour de
--      Gueule Tapée-Fass-Colobane, Dakar)
--
--  Remplacement le jour où la mairie fournit ses données :
--    1. mettre à jour les noms ;
--    2. charger les vrais polygones (GeoJSON/Shapefile) ;
--    3. lancer SELECT * FROM app.recalculer_quartiers('<commune_id>');
--       tous les commerces déjà recensés sont rerattachés automatiquement.
--  ###############################################
-- ===========================================================================

DO $$
DECLARE
    v_commune_id uuid;
    v_zone_id    uuid;
    -- Emprise approximative de la commune (Dakar, Sénégal)
    -- Rappel : longitude NÉGATIVE (~-17,44), latitude POSITIVE (~14,69)
    lon_min constant numeric := -17.4560;
    lon_max constant numeric := -17.4380;
    lat_min constant numeric :=  14.6800;
    lat_max constant numeric :=  14.6920;
    nb_col  constant integer := 5;    -- 5 colonnes × 3 zones = 15 quartiers
    v_zone  integer;
    v_col   integer;
    v_num   integer;
    x1 numeric; x2 numeric; y1 numeric; y2 numeric;
BEGIN

-- ---------------------------------------------------------------------------
-- 1. La commune
-- ---------------------------------------------------------------------------
INSERT INTO app.commune (
    code, slug, nom, nom_court, departement, region,
    superficie_km2, population, geom, centre,
    adresse_mairie, couleur_principale,
    actif, date_activation, est_pilote, a_remplacer
) VALUES (
    'GTFC', 'gtfc',
    'Gueule Tapée-Fass-Colobane',
    'GTFC',
    'Dakar', 'Dakar',
    2.000, 52000,
    ST_Multi(ST_MakeEnvelope(lon_min, lat_min, lon_max, lat_max, 4326)),
    ST_SetSRID(ST_MakePoint((lon_min + lon_max) / 2, (lat_min + lat_max) / 2), 4326),
    'À_REMPLACER — adresse de la mairie',
    '#0B5D2B',
    true, current_date, true,
    true            -- limites administratives approchées
)
ON CONFLICT (code) DO UPDATE SET nom = EXCLUDED.nom
RETURNING id INTO v_commune_id;

IF v_commune_id IS NULL THEN
    SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
END IF;

-- ---------------------------------------------------------------------------
-- 2. Paramètres fiscaux
--    Valeurs de travail : à confirmer par la mairie (voir QUESTIONS-PHASE-2).
-- ---------------------------------------------------------------------------
INSERT INTO app.commune_parametre (
    commune_id, devise,
    jour_exigibilite, delai_grace_jours,
    taux_penalite_pct, penalite_plafond_pct,
    todp_surface_minimale_m2, todp_arrondi,
    prefixe_code_commerce,
    rayon_tolerance_gps_m,
    photo_devanture_obligatoire, photo_todp_obligatoire,
    objectif_visites_jour_agent,
    encaissement_especes_autorise,  -- forcé à false depuis 0041
    a_remplacer
) VALUES (
    v_commune_id, 'XOF',
    10,      -- exigible le 10 du mois          -- À_REMPLACER
    5,       -- 5 jours de grâce                -- À_REMPLACER
    10.00,   -- 10 % de pénalité de retard      -- À_REMPLACER
    50.00,   -- plafonnée à 50 % du principal   -- À_REMPLACER
    1.00,    -- TODP facturée à partir de 1 m²  -- À_REMPLACER
    'superieur',  -- 3,4 m² -> 4 m²             -- À_REMPLACER
    'GTFC',
    50,
    true, true,
    25,
    false,   -- encaissement en espèces interdit depuis 0041 (FR-030)
    true
)
ON CONFLICT (commune_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Rattachement des taxes a GTFC
--
--    « actif » RECOPIE t.actif au lieu d'etre fixe a true. Un type desactive
--    nationalement — la patente, remplacee par la CEL et recouvree par la DGID —
--    ne doit pas revenir actif par le simple fait qu'une commune est ouverte.
--    C'est exactement ce qui se passait : ce seed la rattachait active, et
--    annulait la migration 0023.
-- ---------------------------------------------------------------------------
INSERT INTO ref.commune_type_taxe (commune_id, type_taxe_id, actif, periodicite, a_remplacer)
SELECT v_commune_id, t.id, t.actif,
       CASE t.code
           WHEN 'enseigne' THEN 'mensuelle'::app.periodicite
           ELSE t.periodicite_defaut
       END,
       true
FROM ref.type_taxe t
ON CONFLICT (commune_id, type_taxe_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Les 3 zones — noms provisoires, polygones = bandes horizontales
-- ---------------------------------------------------------------------------
FOR v_zone IN 1..3 LOOP
    y1 := lat_min + (lat_max - lat_min) * (v_zone - 1) / 3.0;
    y2 := lat_min + (lat_max - lat_min) * v_zone / 3.0;

    INSERT INTO app.zone (commune_id, code, nom, description, geom, couleur, ordre, a_remplacer)
    VALUES (
        v_commune_id,
        'Z' || v_zone,
        format('À_REMPLACER — Zone %s', v_zone),
        'Nom et limites à remplacer par les données officielles de la mairie',
        ST_Multi(ST_MakeEnvelope(lon_min, y1, lon_max, y2, 4326)),
        (ARRAY['#0B5D2B', '#1D7A45', '#2F9760'])[v_zone],
        v_zone,
        true
    )
    ON CONFLICT (commune_id, code) DO NOTHING;
END LOOP;

-- ---------------------------------------------------------------------------
-- 5. Les 15 quartiers — grille 5 colonnes × 3 zones
-- ---------------------------------------------------------------------------
v_num := 0;
FOR v_zone IN 1..3 LOOP
    SELECT id INTO v_zone_id FROM app.zone
     WHERE commune_id = v_commune_id AND code = 'Z' || v_zone;

    y1 := lat_min + (lat_max - lat_min) * (v_zone - 1) / 3.0;
    y2 := lat_min + (lat_max - lat_min) * v_zone / 3.0;

    FOR v_col IN 1..nb_col LOOP
        v_num := v_num + 1;
        x1 := lon_min + (lon_max - lon_min) * (v_col - 1) / nb_col::numeric;
        x2 := lon_min + (lon_max - lon_min) * v_col / nb_col::numeric;

        INSERT INTO app.quartier (
            commune_id, zone_id, code, nom, geom, centre,
            population, nb_commerces_estime, a_remplacer
        ) VALUES (
            v_commune_id, v_zone_id,
            'Q' || lpad(v_num::text, 2, '0'),
            format('À_REMPLACER — Quartier %s', lpad(v_num::text, 2, '0')),
            ST_Multi(ST_MakeEnvelope(x1, y1, x2, y2, 4326)),
            ST_SetSRID(ST_MakePoint((x1 + x2) / 2, (y1 + y2) / 2), 4326),
            52000 / 15,          -- population répartie uniformément (provisoire)
            5443 / 15,           -- 5 443 commerces répartis uniformément (provisoire)
            true
        )
        ON CONFLICT (commune_id, code) DO NOTHING;
    END LOOP;
END LOOP;

-- ---------------------------------------------------------------------------
-- 6. Les marchés du référentiel
--
--  Plus de marché « de démonstration » : le référentiel en décrit sept, dont
--  cinq permanents et un hebdomadaire. En créer un de plus produirait un
--  doublon que l'agent verrait dans sa liste, sans savoir lequel choisir.
--
--  Seul le marché de Colobane est nommé par le PDC ; les cinq autres sont
--  marqués à remplacer jusqu'à ce que la mairie fournisse les dénominations.
-- ---------------------------------------------------------------------------
PERFORM app.installer_marches(v_commune_id);

-- Le marché de Colobane reçoit la géométrie du quartier, pour être visible
-- sur la carte avant que la mairie n'en donne le tracé exact.
UPDATE app.marche m
   SET quartier_id = q.id, geom = q.centre, nb_places = 150
  FROM app.quartier q
 WHERE m.commune_id = v_commune_id AND m.code = 'MAR-04'
   AND q.commune_id = v_commune_id AND q.code = 'Q08'
   AND m.geom IS NULL;

-- ---------------------------------------------------------------------------
-- 7. Types d'emplacement — installés par le référentiel
--
--  EMP-01 à EMP-07 viennent de app.installer_referentiel_codes(), appelée
--  par le seed 0003. Les recréer ici sous d'autres codes ferait cohabiter
--  « Cantine » et « EMP-04 Cantine » dans la liste de l'agent.
--
--  Les surfaces types restent à renseigner par la mairie : elles sortent de
--  la délibération, pas d'une estimation.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 8. Motifs d'exonération
-- ---------------------------------------------------------------------------
INSERT INTO ref.motif_exoneration (commune_id, code, libelle, description, role_minimum, justificatif_requis, duree_max_mois, a_remplacer)
VALUES
    (v_commune_id, 'NOUVEAU',   'À_REMPLACER — Nouveau commerce',
     'Exonération temporaire pour un commerce récemment ouvert', 'admin_commune', true, 6, true),
    (v_commune_id, 'HANDICAP',  'À_REMPLACER — Gérant en situation de handicap',
     'Sur présentation de la carte d''égalité des chances', 'admin_commune', true, NULL, true),
    (v_commune_id, 'ASSOC',     'À_REMPLACER — Association ou coopérative',
     'Structure à but non lucratif reconnue par la commune', 'admin_commune', true, 12, true),
    (v_commune_id, 'SINISTRE',  'À_REMPLACER — Sinistre (incendie, inondation)',
     'Exonération exceptionnelle après constat', 'admin_commune', true, 3, true)
ON CONFLICT (commune_id, code) DO NOTHING;

RAISE NOTICE '[seed 0002] Commune GTFC : % zones, % quartiers',
    (SELECT count(*) FROM app.zone     WHERE commune_id = v_commune_id),
    (SELECT count(*) FROM app.quartier WHERE commune_id = v_commune_id);

END
$$;
