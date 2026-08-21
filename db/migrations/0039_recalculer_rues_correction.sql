-- ===========================================================================
--  0039 — Correction de app.recalculer_rues()
--
--  CE QUI ÉTAIT CASSÉ
--
--  La fonction écrivait :
--
--      UPDATE app.commerce c
--         SET rue_id = d.rue_id
--        FROM LATERAL app.detecter_rue(c.commune_id, c.geom, ...) d
--
--  PostgreSQL refuse : dans un UPDATE, la table cible n'est pas visible
--  depuis un LATERAL de la clause FROM. Le message — « invalid reference to
--  FROM-clause entry for table "c" » — ne dit rien de tout cela.
--
--  Le défaut ne se voyait NULLE PART jusqu'ici : la fonction n'est appelée
--  qu'après le chargement d'un tracé de voirie, ce qui n'était encore jamais
--  arrivé. Elle aurait échoué le jour de la phase 0, au moment précis où la
--  mairie attend de voir 5 443 commerces se rattacher à leurs rues.
--
--  Une sous-requête corrélée fait le même travail et reste lisible.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.recalculer_rues(p_commune uuid, p_seuil_m numeric DEFAULT 25)
RETURNS TABLE (rattaches integer, sans_rue integer)
LANGUAGE plpgsql
AS $$
DECLARE v_ok integer;
BEGIN
    -- Seuls les rattachements AUTOMATIQUES sont recalculés. Un choix d'agent
    -- sur le terrain prime sur une déduction : il a vu la plaque, pas nous.
    UPDATE app.commerce c
       SET rue_id = (SELECT d.rue_id
                       FROM app.detecter_rue(c.commune_id, c.geom, p_seuil_m) d),
           rue_detectee_auto = true,
           modifie_le = now()
     WHERE c.commune_id = p_commune
       AND c.archive_le IS NULL
       AND c.geom IS NOT NULL
       AND (c.rue_id IS NULL OR c.rue_detectee_auto)
       -- Sans cette condition, les commerces hors de portée d'une rue
       -- verraient leur rue_id passer à NULL et rue_detectee_auto à true —
       -- un « rattachement automatique vers rien », impossible à distinguer
       -- d'un commerce jamais traité.
       AND EXISTS (SELECT 1 FROM app.detecter_rue(c.commune_id, c.geom, p_seuil_m));
    GET DIAGNOSTICS v_ok = ROW_COUNT;

    RETURN QUERY
    SELECT v_ok,
           (SELECT count(*)::integer FROM app.commerce
             WHERE commune_id = p_commune AND archive_le IS NULL AND rue_id IS NULL);
END;
$$;

COMMENT ON FUNCTION app.recalculer_rues(uuid, numeric) IS
'Rerattache les objets géolocalisés à leur rue après chargement d''un tracé. Ne touche pas aux rues choisies manuellement par un agent, et ne détache jamais un objet hors de portée.';

-- ---------------------------------------------------------------------------
-- Les dispositifs d'affichage aussi
--
--  Ils sont recensés rue par rue : le rattachement automatique leur est
--  encore plus utile qu'aux commerces, puisqu'un panneau de régie n'a pas
--  de devanture pour le situer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.recalculer_rues_affichages(p_commune uuid, p_seuil_m numeric DEFAULT 25)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_ok integer;
BEGIN
    UPDATE app.dispositif_affichage d
       SET rue_id = (SELECT r.rue_id
                       FROM app.detecter_rue(d.commune_id, d.geom, p_seuil_m) r),
           modifie_le = now()
     WHERE d.commune_id = p_commune
       AND d.archive_le IS NULL
       AND d.geom IS NOT NULL
       AND d.rue_id IS NULL
       AND EXISTS (SELECT 1 FROM app.detecter_rue(d.commune_id, d.geom, p_seuil_m));
    GET DIAGNOSTICS v_ok = ROW_COUNT;
    RETURN v_ok;
END;
$$;
