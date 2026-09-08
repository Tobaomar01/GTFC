-- ===========================================================================
--  Aucun avis n'est émis sur un barème provisoire
--  Constitution, principe VIII : « Aucun avis NE DOIT être émis tant que le
--  barème qui le fonde est provisoire. »
--
--  LA REGLE EXISTAIT, ELLE N'ETAIT PAS APPLIQUEE.
--
--  Les donnees provisoires ne produisaient qu'un AVERTISSEMENT dans
--  app.verifier_coherence(), et chaque ligne d'avis se contentait de porter un
--  drapeau « provisoire ». Rien n'empechait d'emettre de vrais avis sur de faux
--  montants — la preuve : le jeu de demonstration en porte soixante.
--
--  Un avis emis n'est pas un brouillon : c'est une creance notifiee a une
--  personne. La fonder sur un montant invente, c'est reclamer de l'argent sur
--  un chiffre que personne n'a delibere.
--
--  POURQUOI UN DECLENCHEUR, ET PAS UN CONTROLE DANS LA ROUTE.
--
--  Parce que la route n'est pas le seul chemin. db/seeds/0006 emet ses avis par
--  un UPDATE direct, sans passer par l'API ; un script de reprise ou une
--  correction a la main feraient de meme. Une regle ecrite dans le service ne
--  protege que ceux qui l'empruntent.
--
--  L'EXCEPTION DE DEMONSTRATION EST EXPLICITE, ET C'EST VOULU.
--
--  Le jeu de demonstration a besoin d'avis emis pour montrer un tableau de bord
--  qui vit. Il desactive donc ce declencheur, NOMMEMENT, le temps de son
--  insertion — comme 0057 le fait deja pour le journal d'audit. Une exception
--  qu'on lit dans le fichier vaut infiniment mieux qu'un trou qu'on ne voit
--  pas : elle se cherche, elle se compte, et elle ne s'etend pas toute seule.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.trg_refuser_avis_provisoire()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, public, pg_catalog
AS $$
DECLARE
    v_taxes text;
BEGIN
    SELECT string_agg(DISTINCT t.libelle_court, ', ' ORDER BY t.libelle_court)
      INTO v_taxes
      FROM app.avis_ligne al
      JOIN app.bareme_taxe b ON b.id = al.bareme_id
      JOIN ref.type_taxe   t ON t.id = b.type_taxe_id
     WHERE al.avis_id = NEW.id
       AND b.a_remplacer;

    IF v_taxes IS NOT NULL THEN
        RAISE EXCEPTION
            'Avis % : le barème de % est encore provisoire. Un avis émis est une '
            'créance notifiée : elle ne peut pas se fonder sur un montant que le '
            'conseil municipal n''a pas délibéré.', NEW.numero, v_taxes
            USING ERRCODE = 'restrict_violation',
                  HINT = 'Renseigner les barèmes réels et leur délibération, '
                         'puis retirer le marqueur À_REMPLACER.';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_refuser_avis_provisoire ON app.avis_imposition;
-- « emis » SEULEMENT, pas « toute sortie de brouillon ».
--
-- Ecrite trop large, la regle refusait aussi l'enregistrement d'un PAIEMENT :
-- imputer un versement fait passer l'avis en « partiellement_paye » ou « paye »,
-- donc le fait sortir de brouillon, et le declencheur bloquait le chemin de
-- l'argent. La constitution parle d'EMISSION — notifier une creance — pas de
-- tout changement de statut. Encaisser ce qu'un redevable a deja verse n'est
-- pas emettre.
CREATE TRIGGER trg_refuser_avis_provisoire
    BEFORE UPDATE OF statut ON app.avis_imposition
    FOR EACH ROW
    WHEN (NEW.statut = 'emis' AND OLD.statut = 'brouillon')
    EXECUTE FUNCTION app.trg_refuser_avis_provisoire();

-- Un avis cree DIRECTEMENT au statut emis contournerait le declencheur
-- ci-dessus, qui ne surveille qu'une transition depuis « brouillon ».
DROP TRIGGER IF EXISTS trg_refuser_avis_provisoire_insert ON app.avis_imposition;
CREATE TRIGGER trg_refuser_avis_provisoire_insert
    AFTER INSERT ON app.avis_imposition
    FOR EACH ROW
    WHEN (NEW.statut = 'emis')
    EXECUTE FUNCTION app.trg_refuser_avis_provisoire();

-- ---------------------------------------------------------------------------
--  Le controle de coherence cesse de se contenter d'un avertissement.
--
--  Il continue de compter les donnees provisoires — utile pour savoir ou on en
--  est — mais il signale desormais en ERREUR les baremes qui fondent des avis
--  DEJA emis. Ceux-la existent : ils ont ete emis avant que la regle ne soit
--  posee, et personne ne peut les annuler d'un script.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_avis_sur_bareme_provisoire AS
SELECT a.commune_id,
       a.id        AS avis_id,
       a.numero,
       a.statut,
       a.date_emission,
       string_agg(DISTINCT t.libelle_court, ', ' ORDER BY t.libelle_court) AS taxes
  FROM app.avis_imposition a
  JOIN app.avis_ligne al ON al.avis_id = a.id
  JOIN app.bareme_taxe b ON b.id = al.bareme_id
  JOIN ref.type_taxe   t ON t.id = b.type_taxe_id
 WHERE a.statut <> 'brouillon'
   AND a.annule_le IS NULL
   AND b.a_remplacer
 GROUP BY a.commune_id, a.id, a.numero, a.statut, a.date_emission;

COMMENT ON VIEW app.v_avis_sur_bareme_provisoire IS
    'Avis emis dont un barème est encore provisoire. Ils datent d''avant la règle '
    'et ne peuvent être annulés que par décision municipale (BR-010).';

ALTER VIEW app.v_avis_sur_bareme_provisoire SET (security_invoker = true);
GRANT SELECT ON app.v_avis_sur_bareme_provisoire TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Verification : le declencheur refuse-t-il vraiment ?
--
--  On l'eprouve sur place plutot que de le declarer bon. Une migration qui pose
--  un garde-fou sans le mettre a l'epreuve, c'est exactement ce qui a permis a
--  0023 de passer pour appliquee en ne faisant rien.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_avis    uuid;
    v_statut  text;
    v_refuse  boolean := false;
BEGIN
    -- On note le statut d'origine pour le REMETTRE : une migration qui eprouve
    -- une regle ne doit pas laisser derriere elle un avis dans un autre etat.
    SELECT a.id, a.statut::text INTO v_avis, v_statut
      FROM app.avis_imposition a
      JOIN app.avis_ligne al ON al.avis_id = a.id
      JOIN app.bareme_taxe b ON b.id = al.bareme_id
     WHERE b.a_remplacer
     LIMIT 1;

    IF v_avis IS NULL THEN
        RAISE NOTICE 'Aucun avis sur barème provisoire : rien à éprouver ici.';
        RETURN;
    END IF;

    BEGIN
        UPDATE app.avis_imposition SET statut = 'brouillon' WHERE id = v_avis;
        UPDATE app.avis_imposition SET statut = 'emis'      WHERE id = v_avis;
    EXCEPTION WHEN restrict_violation THEN
        v_refuse := true;
    END;

    IF NOT v_refuse THEN
        RAISE EXCEPTION 'Le declencheur n''a PAS refuse l''emission sur un bareme provisoire.';
    END IF;

    RAISE NOTICE 'Declencheur eprouve : l''emission sur un bareme provisoire est refusee.';

    -- Et le chemin de l'ARGENT doit rester ouvert : imputer un versement fait
    -- sortir l'avis de brouillon sans l'emettre. Ecrite trop large, la regle
    -- bloquait l'encaissement — defaut trouve par la verification sur base
    -- neuve, pas par la lecture.
    BEGIN
        UPDATE app.avis_imposition SET statut = 'brouillon' WHERE id = v_avis;
        UPDATE app.avis_imposition SET statut = 'partiellement_paye' WHERE id = v_avis;
    EXCEPTION WHEN restrict_violation THEN
        RAISE EXCEPTION 'La regle bloque l''imputation d''un paiement : elle est trop large.';
    END;
    RAISE NOTICE 'Chemin de l''argent : imputer un versement reste possible.';

    -- Remise en etat.
    UPDATE app.avis_imposition SET statut = v_statut::app.statut_avis WHERE id = v_avis;
END
$verif$;
