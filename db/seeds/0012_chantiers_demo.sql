-- Seed 0012 — Chantiers de démonstration
--
-- Ils étaient au seed 0008, et n'ont jamais été créés sur une installation
-- neuve : un chantier s'accroche à une RUE, et les rues n'arrivent qu'au seed
-- 0009. La boucle ne trouvait rien et se terminait sans erreur — un seed muet
-- qui ne fait rien ressemble à un seed qui a réussi.
--
-- Le défaut n'était visible que depuis une base vide. Sur la base de travail,
-- les rues existaient déjà quand 0008 a été rejoué.
--
-- Les chantiers sont recensés et redevables de la TODP, mais NON facturables
-- pendant le pilote : c'est précisément ce qu'il faut démontrer — ils
-- apparaissent au registre et sur la carte sans qu'aucun avis ne parte.
--
-- Idempotent. Tous les libellés portent la mention DEMO.

DO $$
DECLARE
    v_commune uuid;
    v_seq     integer;
    v_n       integer;
    v_c       record;
BEGIN
    SELECT id INTO v_commune FROM app.commune WHERE code = 'GTFC';
    IF v_commune IS NULL THEN
        RAISE NOTICE '[seed 0012] commune GTFC absente — rien à faire';
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM app.rue WHERE commune_id = v_commune) THEN
        -- Dit à voix haute plutôt que de se terminer en silence.
        RAISE WARNING '[seed 0012] aucune rue : aucun chantier ne sera créé';
        RETURN;
    END IF;

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
