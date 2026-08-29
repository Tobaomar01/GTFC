-- Seed 0008 — Dispositifs d'affichage de démonstration
--
-- Le jeu de démonstration n'en contenait aucun. Conséquence : la taxe sur les
-- enseignes n'était jamais exercée — ni par les tests, ni par une
-- démonstration à la mairie. Un chemin de facturation entier restait dans
-- l'angle mort.
--
-- Les chantiers, qui figuraient ici, sont passés au seed 0012 : ils
-- s'accrochent à une rue, et les rues ne sont créées qu'au seed 0009. Placés
-- avant elles, ils n'en trouvaient aucune et le seed en créait ZÉRO sans rien
-- signaler.
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
END
$$;

