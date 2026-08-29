-- Seed 0008 — Dispositifs d'affichage et chantiers de démonstration
--
-- Le jeu de démonstration n'en contenait aucun. Conséquence : la taxe sur les
-- enseignes et la TODP de chantier n'étaient jamais exercées — ni par les
-- tests, ni par une démonstration à la mairie. Deux chemins de facturation
-- entiers restaient dans l'angle mort.
--
-- Les dimensions retenues sont plausibles pour une devanture de quartier :
-- une enseigne de boutique fait rarement plus de 2 m², un panneau
-- publicitaire de rue une dizaine.
--
-- Idempotent. Tous les libellés portent la mention DEMO.

DO $$
DECLARE
    v_commune uuid;
    v_c       record;
    v_type    uuid;
    v_n       integer := 0;
    v_seq     integer;
    v_surface numeric;
BEGIN
    SELECT id INTO v_commune FROM app.commune WHERE code = 'GTFC';
    IF v_commune IS NULL THEN
        RAISE EXCEPTION 'Commune GTFC absente — lancez d''abord le seed 0002.';
    END IF;

    IF EXISTS (SELECT 1 FROM app.dispositif_affichage WHERE commune_id = v_commune) THEN
        RAISE NOTICE 'Dispositifs déjà présents — rien à faire.';
    ELSE
        SELECT coalesce(max(numero_sequence), 0) INTO v_seq
          FROM app.dispositif_affichage WHERE commune_id = v_commune;

        -- Un dispositif pour un commerce sur quatre : toutes les devantures
        -- n'ont pas d'enseigne déclarée, loin de là.
        FOR v_c IN
            SELECT c.id, c.code, c.redevable_id, c.rue_id, c.quartier_id, c.zone_id,
                   row_number() OVER (ORDER BY c.code) AS rang
              FROM app.commerce c
             WHERE c.commune_id = v_commune AND c.archive_le IS NULL
             ORDER BY c.code
        LOOP
            CONTINUE WHEN v_c.rang % 4 <> 0;

            SELECT id INTO v_type FROM ref.type_affichage
             WHERE code = CASE (v_c.rang / 4) % 3
                            WHEN 0 THEN 'AFF-01'   -- enseigne lumineuse
                            WHEN 1 THEN 'AFF-02'   -- enseigne non lumineuse
                            ELSE        'AFF-03'   -- auvent
                          END;

            -- De 1,2 m² pour une plaque à 4,2 m² pour un auvent de restaurant.
            v_surface := 1.2 + ((v_c.rang % 5) * 0.75);
            v_seq := v_seq + 1;

            INSERT INTO app.dispositif_affichage
                (commune_id, redevable_id, commerce_id, type_affichage_id, code,
                 numero_sequence, rue_id, quartier_id, zone_id,
                 surface_m2, nb_faces, lumineux, texte_affiche,
                 date_apposition, date_constat, actif, origine)
            VALUES (v_commune, v_c.redevable_id, v_c.id, v_type,
                    'GTFC-A-' || lpad(v_seq::text, 5, '0'), v_seq,
                    v_c.rue_id, v_c.quartier_id, v_c.zone_id,
                    v_surface, 1, (v_c.rang / 4) % 3 = 0,
                    'DEMO — enseigne ' || v_c.code,
                    current_date - 180, current_date, true, 'terrain');
            v_n := v_n + 1;
        END LOOP;
        RAISE NOTICE 'Dispositifs d''affichage créés : %', v_n;
    END IF;

    -- Chantiers : recensés, redevables de la TODP, mais NON facturables
    -- durant le pilote (FR-021d). C'est justement ce qu'il faut pouvoir
    -- démontrer : ils apparaissent au registre et sur la carte sans qu'aucun
    -- avis ne parte.
    IF EXISTS (SELECT 1 FROM app.chantier WHERE commune_id = v_commune) THEN
        RAISE NOTICE 'Chantiers déjà présents — rien à faire.';
    ELSE
        v_n := 0;
        SELECT coalesce(max(numero_sequence), 0) INTO v_seq
          FROM app.chantier WHERE commune_id = v_commune;

        FOR v_c IN
            SELECT r.id AS redevable_id, ru.id AS rue_id, ru.quartier_id,
                   q.zone_id, row_number() OVER (ORDER BY ru.code) AS rang
              FROM app.rue ru
              JOIN app.quartier q ON q.id = ru.quartier_id
              CROSS JOIN LATERAL (
                  SELECT id FROM app.redevable
                   WHERE commune_id = v_commune AND archive_le IS NULL LIMIT 1) r
             WHERE ru.commune_id = v_commune
             ORDER BY ru.code LIMIT 5
        LOOP
            v_seq := v_seq + 1;
            INSERT INTO app.chantier
                (commune_id, redevable_id, code, numero_sequence, libelle,
                 rue_id, quartier_id, zone_id, surface_m2,
                 date_constat, duree_prevue_jours, autorisation_vue,
                 statut, facturable)
            VALUES (v_commune, v_c.redevable_id,
                    'GTFC-C-' || lpad(v_seq::text, 5, '0'), v_seq,
                    'DEMO — chantier ' || v_c.rang,
                    v_c.rue_id, v_c.quartier_id, v_c.zone_id,
                    8.0 + v_c.rang * 4,
                    current_date - 30, 90, v_c.rang % 2 = 0,
                    'en_cours', false);
            v_n := v_n + 1;
        END LOOP;
        RAISE NOTICE 'Chantiers créés : % (tous non facturables)', v_n;
    END IF;
END
$$;
