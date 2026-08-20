-- ===========================================================================
--  0035 — Le statut fiscal suit le redevable, pas seulement le commerce
--
--  CE QUI MANQUAIT
--
--  app.recalculer_statut_fiscal() raisonne sur un COMMERCE : elle regarde ses
--  avis et en déduit une couleur pour la carte. Le redevable, lui, portait
--  bien les colonnes statut_fiscal et solde_du — mais rien ne les mettait
--  jamais à jour.
--
--  Résultat visible : soixante factures émises, trente payées, et tous les
--  redevables affichés « aucun avis émis ». Le tableau de bord et le portail
--  disaient la même chose, tranquillement fausse.
--
--  Le défaut est de ceux qui ne cassent rien : aucune erreur, aucun rejet,
--  juste un chiffre qui ne bouge pas. C'est ce qui les rend coûteux — on les
--  découvre quand quelqu'un se fie à l'écran.
--
--  LA RÈGLE
--
--  Un redevable est à jour s'il ne doit rien. Sinon, il est en retard dès
--  qu'une échéance est dépassée, et en paiement partiel s'il a commencé à
--  payer. Ce sont les mêmes règles que pour un commerce, appliquées à
--  l'ensemble de ses objets — puisque c'est lui qui reçoit une facture unique.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.recalculer_statut_redevable(p_redevable uuid)
RETURNS app.statut_fiscal
LANGUAGE plpgsql
AS $$
DECLARE
    v_du        numeric := 0;
    v_paye      numeric := 0;
    v_en_retard boolean := false;
    v_avis      integer := 0;
    v_exonere   boolean := false;
    v_statut    app.statut_fiscal;
BEGIN
    SELECT coalesce(sum(a.montant_restant), 0),
           coalesce(sum(a.montant_paye), 0),
           bool_or(a.date_exigibilite < current_date AND a.montant_restant > 0),
           count(*),
           -- Exonéré seulement si TOUS les avis le sont : une exonération
           -- partielle ne dispense pas du reste.
           count(*) FILTER (WHERE a.statut = 'exonere') = count(*)
      INTO v_du, v_paye, v_en_retard, v_avis, v_exonere
      FROM app.avis_imposition a
     WHERE a.redevable_id = p_redevable
       AND a.annule_le IS NULL
       AND a.statut <> 'brouillon';

    IF v_avis = 0 THEN
        v_statut := 'inconnu';
    ELSIF v_exonere THEN
        v_statut := 'exonere';
    ELSIF v_du <= 0 THEN
        v_statut := 'a_jour';
    ELSIF v_en_retard AND v_paye > 0 THEN
        -- A commencé à payer mais l'échéance est passée : « partiel » plutôt
        -- que « impayé ». Traiter de la même façon celui qui n'a rien versé
        -- et celui qui a versé les trois quarts décourage le second.
        v_statut := 'partiel';
    ELSIF v_en_retard THEN
        v_statut := 'impaye';
    ELSIF v_paye > 0 THEN
        v_statut := 'partiel';
    ELSE
        -- Facture émise, échéance à venir, rien versé : ce n'est pas un
        -- retard. L'afficher en rouge serait injuste et ferait fuir le
        -- commerçant du portail.
        v_statut := 'inconnu';
    END IF;

    UPDATE app.redevable
       SET statut_fiscal = v_statut,
           statut_fiscal_calcule_le = now(),
           solde_du = GREATEST(v_du, 0)
     WHERE id = p_redevable;

    RETURN v_statut;
END;
$$;

COMMENT ON FUNCTION app.recalculer_statut_redevable IS
'Situation consolidée d''un redevable, tous objets confondus. Alimente la pastille du tableau de bord et celle du portail.';

-- ---------------------------------------------------------------------------
-- Recalcul en masse, pour une commune
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.recalculer_statuts_redevables(p_commune uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE v_n integer := 0; r record;
BEGIN
    FOR r IN SELECT id FROM app.redevable
              WHERE commune_id = p_commune AND archive_le IS NULL
    LOOP
        PERFORM app.recalculer_statut_redevable(r.id);
        v_n := v_n + 1;
    END LOOP;
    RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Mise à jour automatique
--
--  Portée par un déclencheur plutôt que par l'API : un avis change d'état
--  par le webhook Wave, par un encaissement en espèces, par une annulation
--  au guichet et par le planificateur de pénalités. Quatre chemins, donc
--  quatre occasions d'oublier l'appel.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.avis_maj_statut_redevable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM app.recalculer_statut_redevable(OLD.redevable_id);
        RETURN NULL;
    END IF;

    PERFORM app.recalculer_statut_redevable(NEW.redevable_id);
    IF TG_OP = 'UPDATE' AND NEW.redevable_id IS DISTINCT FROM OLD.redevable_id THEN
        PERFORM app.recalculer_statut_redevable(OLD.redevable_id);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_avis_statut_redevable ON app.avis_imposition;
CREATE TRIGGER trg_avis_statut_redevable
    AFTER INSERT OR DELETE OR UPDATE OF montant_paye, montant_total, statut,
                                        annule_le, redevable_id, date_exigibilite
    ON app.avis_imposition
    FOR EACH ROW
    EXECUTE FUNCTION app.avis_maj_statut_redevable();

-- ---------------------------------------------------------------------------
-- Rattrapage de l'existant
-- ---------------------------------------------------------------------------
DO $$
DECLARE c uuid; n integer; total integer := 0;
BEGIN
    FOR c IN SELECT id FROM app.commune LOOP
        SELECT app.recalculer_statuts_redevables(c) INTO n;
        total := total + n;
    END LOOP;
    RAISE NOTICE 'Statut fiscal recalculé pour % redevable(s).', total;
END
$$;
