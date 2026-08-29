-- 0051 — Rattachement automatique des taxes inconditionnelles
--
-- Défaut constaté à l'exécution : la patente n'était rattachée à aucun
-- commerce, alors qu'elle est inconditionnelle — tout commerce la doit.
-- Résultat : elle ne figurait sur aucun avis. La taxe principale du
-- dispositif ne rapportait rien.
--
-- Le rattachement des taxes CONDITIONNELLES relève du terrain : c'est
-- l'agent qui constate un débordement, un emplacement de marché ou une
-- enseigne, et qui en mesure le paramètre. Rien ne peut le décider à sa
-- place.
--
-- Mais une taxe inconditionnelle n'a rien à constater. La laisser au
-- rattachement manuel garantit qu'elle sera oubliée sur une partie du
-- registre — et un oubli de patente ne se voit pas, il se lit seulement
-- dans un total plus faible que prévu.

CREATE OR REPLACE FUNCTION app.rattacher_taxes_inconditionnelles(
    p_commune_id uuid,
    p_commerce_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_nb integer;
BEGIN
    INSERT INTO app.commerce_taxe (commune_id, commerce_id, type_taxe_id, date_debut, actif)
    SELECT c.commune_id, c.id, t.id, greatest(c.cree_le::date, current_date), true
      FROM app.commerce c
      CROSS JOIN ref.type_taxe t
      LEFT JOIN ref.commune_type_taxe cot
             ON cot.commune_id = c.commune_id AND cot.type_taxe_id = t.id
     WHERE c.commune_id = p_commune_id
       AND (p_commerce_id IS NULL OR c.id = p_commerce_id)
       AND c.archive_le IS NULL
       AND c.statut IN ('actif', 'ferme_temporaire')
       AND t.actif
       AND NOT t.conditionnelle
       AND coalesce(cot.actif, true)
       AND NOT EXISTS (
           SELECT 1 FROM app.commerce_taxe ct
            WHERE ct.commerce_id = c.id AND ct.type_taxe_id = t.id AND ct.actif);

    GET DIAGNOSTICS v_nb = ROW_COUNT;
    RETURN v_nb;
END;
$$;

COMMENT ON FUNCTION app.rattacher_taxes_inconditionnelles IS
'Rattache aux commerces les taxes dues sans fait générateur à constater. Idempotente. Les taxes conditionnelles restent du ressort de l''agent, qui seul mesure leur paramètre.';

-- Rattachement à la création d'un commerce : un commerce recensé aujourd'hui
-- ne doit pas attendre un traitement de nuit pour être imposable.
CREATE OR REPLACE FUNCTION app.trg_rattacher_taxes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM app.rattacher_taxes_inconditionnelles(NEW.commune_id, NEW.id);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_commerce_taxes_inconditionnelles ON app.commerce;
CREATE TRIGGER trg_commerce_taxes_inconditionnelles
    AFTER INSERT ON app.commerce
    FOR EACH ROW EXECUTE FUNCTION app.trg_rattacher_taxes();

-- Reprise du registre existant.
DO $$
DECLARE c record; v_total integer := 0; v_nb integer;
BEGIN
    FOR c IN SELECT id, code FROM app.commune WHERE actif LOOP
        v_nb := app.rattacher_taxes_inconditionnelles(c.id);
        v_total := v_total + v_nb;
        RAISE NOTICE '  %  : % rattachement(s)', c.code, v_nb;
    END LOOP;
    RAISE NOTICE 'Total : % rattachement(s) créé(s).', v_total;
END
$$;
