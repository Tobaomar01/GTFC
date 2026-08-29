-- 0061 — Prévenir avant que le journal d'audit ne refuse d'écrire
--
-- Le journal est partitionné par mois et n'a AUCUNE partition par défaut. Le
-- mois où la dernière s'épuise, toute écriture auditée échoue — et comme
-- l'audit se déclenche sur chaque écriture sensible, c'est le système entier
-- qui s'arrête. Un premier du mois, d'un coup, sans prévenir.
--
-- La tâche qui prolonge les partitions échouait depuis des mois : elle
-- appelait une fonction supprimée avec le suivi de position des agents. Elle
-- est réparée, mais réparer ne suffit pas. Ce qui manquait, c'est que
-- l'épuisement se VOIE venir : la panne aurait été totale, brutale, et sa
-- cause enfouie dans une ligne de journal du 25 du mois précédent.
--
-- Ce contrôle rejoint la vérification de cohérence quotidienne. Il annonce
-- l'échéance longtemps à l'avance, et il crie quand la marge devient courte.

CREATE OR REPLACE FUNCTION audit.marge_partitions()
RETURNS TABLE(derniere_couverture date, mois_restants integer, alerte text)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_fin timestamptz;
BEGIN
    -- La borne haute de la dernière partition. On la lit dans le catalogue
    -- plutôt que de la déduire d'une convention de nommage : un nom peut
    -- mentir, une borne non.
    SELECT max((regexp_match(pg_get_expr(c.relpartbound, c.oid),
                             'TO \(''([^'']+)''\)'))[1]::timestamptz)
      INTO v_fin
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'audit.journal'::regclass
       AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT';

    IF v_fin IS NULL THEN
        derniere_couverture := NULL;
        mois_restants := 0;
        alerte := 'AUCUNE partition : le journal refuse deja toute ecriture';
        RETURN NEXT;
        RETURN;
    END IF;

    derniere_couverture := v_fin::date;
    mois_restants := greatest(0,
        (extract(year from v_fin)::int - extract(year from now())::int) * 12
      + (extract(month from v_fin)::int - extract(month from now())::int));

    alerte := CASE
        WHEN mois_restants <= 1 THEN
            'CRITIQUE : le journal d''audit cessera d''accepter des ecritures le '
            || to_char(v_fin, 'DD/MM/YYYY') || ', et le systeme entier avec lui'
        WHEN mois_restants <= 2 THEN
            'Partitions du journal d''audit epuisees le '
            || to_char(v_fin, 'DD/MM/YYYY') || ' : verifier la tache « partitions »'
        ELSE NULL
    END;
    RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION audit.marge_partitions IS
  'Combien de mois le journal d''audit peut encore accepter d''écritures. '
  'À zéro, tout le système s''arrête : l''audit se déclenche sur chaque '
  'écriture sensible.';

GRANT EXECUTE ON FUNCTION audit.marge_partitions() TO gtfc_app;
