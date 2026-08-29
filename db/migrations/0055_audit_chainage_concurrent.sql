-- 0055 — Le chaînage d'audit ne résistait pas à la concurrence
--
-- Défaut constaté en exécution : deux écritures séparées de cinq millisecondes
-- ont lu la MÊME dernière empreinte et s'y sont toutes deux accrochées. La
-- chaîne se dédouble, et `audit.verifier_chaine()` signale une rupture.
--
--   3362  16:06:33.955  précédente d69ff068…
--   3363  16:06:33.960  précédente d69ff068…   ← même parent
--
-- La conséquence est plus grave que le symptôme. Sur le terrain, plusieurs
-- agents synchronisent en même temps : la chaîne se romprait plusieurs fois
-- par jour, pour des raisons parfaitement innocentes. Or une rupture est
-- censée signifier une altération. Un signal qui se déclenche tous les jours
-- sans raison n'est plus un signal — celui qui le surveille cesse de le
-- regarder, et c'est le jour d'une vraie altération que personne ne verra
-- rien. Un garde-fou qui crie faux est pire qu'aucun garde-fou.
--
-- Correction : le calcul de l'empreinte est sérialisé par un verrou consultatif
-- de transaction. La lecture de la dernière empreinte et l'écriture de la
-- suivante deviennent indivisibles ; la seconde transaction attend.
--
-- Le coût est assumé. Les écritures du journal se suivent au lieu de se
-- croiser — quelques millisecondes chacune, sur une commune qui compte
-- 5 443 commerces et quelques dizaines d'écritures par minute en pointe. Une
-- opération longue qui journalise beaucoup, comme la génération des avis,
-- retient le verrou pendant sa durée : c'est voulu. On ne veut pas d'écritures
-- entrelacées au milieu d'une facturation.
--
-- Le verrou est pris DANS le déclencheur, donc impossible à oublier : aucun
-- appelant n'a à le connaître.

CREATE OR REPLACE FUNCTION audit.chainer()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_prec text;
BEGIN
    -- Clé arbitraire mais STABLE, propre au chaînage du journal. Le verrou est
    -- relâché à la validation de la transaction, sans intervention.
    PERFORM pg_advisory_xact_lock(hashtext('audit.journal.chainage'));

    SELECT j.empreinte INTO v_prec
      FROM audit.journal j ORDER BY j.horodatage DESC, j.id DESC LIMIT 1;
    NEW.empreinte_precedente := v_prec;
    NEW.empreinte := encode(digest(
        coalesce(v_prec,'') ||
        coalesce(NEW.commune_id::text,'') ||
        coalesce(NEW.utilisateur_id::text,'') ||
        NEW.action::text || NEW.entite ||
        coalesce(NEW.entite_id::text,'') ||
        coalesce(NEW.valeurs_avant::text,'') ||
        coalesce(NEW.valeurs_apres::text,'') ||
        NEW.horodatage::text,
        'sha256'), 'hex');
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION audit.chainer IS
  'Chaîne chaque entrée sur la précédente (SHA-256). Sérialisé par verrou '
  'consultatif : sans lui, deux écritures simultanées se rattachent au même '
  'parent et la chaîne paraît rompue sans qu''aucune altération ait eu lieu.';
