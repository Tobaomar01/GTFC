-- Seed 0009 — Rues des fourchettes du PDC absentes d'OpenStreetMap
--
-- La phase 0 demande de croiser trois sources : OpenStreetMap, la carte du
-- PDC 2021-2025 et le plan de voirie communal. L'import OSM en a fourni 85.
--
-- Le PDC cite deux fourchettes explicites — « rues GT 53 à 71, rues 37 à 48
-- côté Colobane ». Quinze numéros de ces séries manquent à OSM. Ils sont
-- ajoutés ici.
--
-- CE QUI EST FAIT ET CE QUI NE L'EST PAS
--
-- Aucun nom n'est inventé : ce sont des NUMÉROS dans des séries que le
-- document désigne nommément. Ce qui manque, en revanche, c'est le TRACÉ —
-- OSM ne connaît pas ces voies, elles n'ont donc pas de géométrie et
-- n'apparaîtront pas sur la carte tant que quelqu'un ne l'aura pas relevée.
--
-- Toutes sont marquées source = 'pdc' et a_remplacer = true : la mairie doit
-- les relire. Sans sa validation, les statistiques par rue seront
-- contestables — c'est le document lui-même qui le dit.
--
-- Le déséquilibre mérite d'être noté : Colobane concentre 68 % des
-- redevables et n'avait que 2 rues sur 12 dans OSM. C'est le quartier où la
-- couverture cartographique est la plus faible et l'enjeu le plus fort.
--
-- Idempotent.

DO $$
DECLARE
    v_commune  uuid;
    v_quartier uuid;
    v_zone     uuid;
    v_n        integer := 0;
    r          record;
BEGIN
    SELECT id INTO v_commune FROM app.commune WHERE code = 'GTFC';
    IF v_commune IS NULL THEN
        RAISE EXCEPTION 'Commune GTFC absente — lancez d''abord le seed 0002.';
    END IF;

    FOR r IN
        SELECT * FROM (VALUES
            -- Série Gueule Tapée, fourchette GT 53 à 71 du PDC
            ('GT-56', 'Rue GT-56', 'Q01'),
            ('GT-67', 'Rue GT-67', 'Q01'),
            ('GT-69', 'Rue GT-69', 'Q01'),
            ('GT-70', 'Rue GT-70', 'Q01'),
            ('GT-71', 'Rue GT-71', 'Q01'),
            -- Série Colobane, fourchette 37 à 48 du PDC
            ('CO-38', 'Rue 38', 'Q03'),
            ('CO-39', 'Rue 39', 'Q03'),
            ('CO-41', 'Rue 41', 'Q03'),
            ('CO-42', 'Rue 42', 'Q03'),
            ('CO-43', 'Rue 43', 'Q03'),
            ('CO-44', 'Rue 44', 'Q03'),
            ('CO-45', 'Rue 45', 'Q03'),
            ('CO-46', 'Rue 46', 'Q03'),
            ('CO-47', 'Rue 47', 'Q03'),
            ('CO-48', 'Rue 48', 'Q03')
        ) AS v(code, nom, quartier)
    LOOP
        SELECT q.id, q.zone_id INTO v_quartier, v_zone
          FROM app.quartier q
         WHERE q.commune_id = v_commune AND q.code = r.quartier;

        INSERT INTO app.rue
            (commune_id, quartier_id, zone_id, code, nom, type_voie,
             source, a_remplacer, actif)
        VALUES (v_commune, v_quartier, v_zone, r.code, r.nom, 'rue',
                'pdc', true, true)
        ON CONFLICT DO NOTHING;

        IF FOUND THEN v_n := v_n + 1; END IF;
    END LOOP;

    RAISE NOTICE 'Rues du PDC ajoutées : % (sans tracé, à relever)', v_n;
END
$$;
