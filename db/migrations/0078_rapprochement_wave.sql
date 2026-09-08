-- ===========================================================================
--  Le rapprochement des encaissements Wave
--  Constitution, principe I (NON NEGOCIABLE) :
--      « En cas de desaccord entre le systeme et l'operateur de mobile money,
--        l'encaissement DOIT etre bloque et presente comme en attente.
--        Il NE DOIT jamais etre presume. »
--
--  CE QUI MANQUAIT.
--
--  Cette regle suppose qu'on SACHE reconnaitre un desaccord. Rien ne le
--  faisait : aucune vue, aucun controle, aucune tache ne comparait
--  app.transaction_wave a app.paiement. Le tableau de couverture de la
--  specification le disait — « reste a faire : reconciliation » — et c'est
--  reste une ligne dans un tableau.
--
--  CE QUE CELA VAUT SUR LE TERRAIN. Un webhook se perd : c'est normal, tout
--  operateur en perd. Wave a encaisse, le systeme n'a rien impute. Le
--  commercant a paye et doit toujours, sur le papier. Un agent se presente
--  chez lui pour reclamer une somme deja reglee — et il a le recu sur son
--  telephone. C'est la pire visite possible, et elle serait invisible cote
--  mairie jusqu'a ce qu'il proteste.
--
--  CE QUE CETTE MIGRATION FAIT, ET CE QU'ELLE NE FAIT PAS.
--
--  Elle pose le rapprochement LOCAL : ce que la base peut constater seule,
--  sans interroger Wave. C'est deja l'essentiel des cas, et cela ne depend
--  d'aucune cle operateur.
--
--  Elle NE remplace PAS le rapprochement avec l'operateur — interroger Wave
--  sur les sessions qu'il dit payees et que nous ignorons. Celui-la demande un
--  compte marchand actif ; il est decrit dans docs/QUESTIONS-WAVE.md. Ecrire
--  un client d'API qu'on ne peut pas eprouver serait pire que de ne rien
--  ecrire : cela ressemblerait a un controle.
-- ===========================================================================

CREATE OR REPLACE VIEW app.v_rapprochement_wave AS

-- 1. L'operateur a encaisse, le systeme n'a rien impute.
--    Le cas grave : le commercant a paye et doit toujours.
SELECT t.commune_id,
       'encaisse_non_impute'::text AS anomalie,
       'erreur'::text              AS gravite,
       t.id                        AS transaction_id,
       t.wave_session_id,
       t.montant                   AS montant_wave,
       NULL::numeric               AS montant_impute,
       t.confirme_le,
       'Wave a confirmé cet encaissement, aucun paiement ne lui correspond. '
       'Le redevable a payé et doit toujours : il sera relancé à tort.'::text AS consequence
  FROM app.transaction_wave t
 WHERE t.statut = 'reussie'
   AND t.paiement_id IS NULL

UNION ALL

-- 2. Le paiement rattache a ete annule, alors que l'operateur maintient
--    l'encaissement. Une annulation ne rembourse rien chez Wave.
SELECT t.commune_id,
       'paiement_annule_encaissement_maintenu',
       'erreur',
       t.id,
       t.wave_session_id,
       t.montant,
       p.montant,
       t.confirme_le,
       'Le paiement a été annulé côté mairie, mais Wave maintient l''encaissement. '
       'Une annulation ne rembourse rien : l''argent est chez l''opérateur.'
  FROM app.transaction_wave t
  JOIN app.paiement p ON p.id = t.paiement_id
 WHERE t.statut = 'reussie'
   AND p.annule_le IS NOT NULL

UNION ALL

-- 3. Trop-percu : Wave a encaisse plus que ce qui restait du, et le service
--    plafonne volontairement l'imputation au reste du. L'ecart n'est pas une
--    erreur de calcul — c'est de l'argent recu qui n'est impute nulle part, et
--    quelqu'un doit en decider.
SELECT t.commune_id,
       'trop_percu_non_impute',
       'avertissement',
       t.id,
       t.wave_session_id,
       t.montant,
       p.montant,
       t.confirme_le,
       'Wave a encaissé plus que le reste dû. La différence n''est imputée nulle '
       'part : remboursement ou avoir, c''est une décision de la mairie.'
  FROM app.transaction_wave t
  JOIN app.paiement p ON p.id = t.paiement_id
 WHERE t.statut = 'reussie'
   AND p.annule_le IS NULL
   AND t.montant > p.montant;

COMMENT ON VIEW app.v_rapprochement_wave IS
    'Desaccords entre les transactions Wave et les paiements imputes. Les lignes '
    'de gravite « erreur » DOIVENT rester vides : chacune est un redevable qui a '
    'paye et que le systeme croit debiteur.';

ALTER VIEW app.v_rapprochement_wave SET (security_invoker = true);
GRANT SELECT ON app.v_rapprochement_wave TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Le controle de coherence quotidien s'en saisit.
--
--  Il tourne deja tous les matins a 6h30 et ecrit son resultat ; c'est le bon
--  endroit pour que ce rapprochement soit REGARDE, et pas seulement disponible.
-- ---------------------------------------------------------------------------
-- On RENOMME l'existante au lieu de recopier son corps : deux copies d'un
-- controle finissent toujours par diverger, et c'est la copie oubliee qui
-- tourne en production.
DO $renommer$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'app' AND p.proname = 'verifier_coherence_base'
    ) THEN
        ALTER FUNCTION app.verifier_coherence(uuid) RENAME TO verifier_coherence_base;
    END IF;
END
$renommer$;

GRANT EXECUTE ON FUNCTION app.verifier_coherence_base(uuid) TO gtfc_app;

CREATE OR REPLACE FUNCTION app.verifier_coherence(p_commune_id uuid DEFAULT NULL)
RETURNS TABLE (gravite text, controle text, nb bigint, detail text)
LANGUAGE sql STABLE
AS $$
    SELECT * FROM app.verifier_coherence_base($1)

UNION ALL
    SELECT r.gravite,
           'rapprochement Wave : ' || r.anomalie,
           count(*),
           max(r.consequence)
      FROM app.v_rapprochement_wave r
     WHERE (p_commune_id IS NULL OR r.commune_id = p_commune_id)
     GROUP BY r.gravite, r.anomalie
    HAVING count(*) > 0
$$;

COMMENT ON FUNCTION app.verifier_coherence(uuid) IS
    'Controles de coherence quotidiens, rapprochement Wave compris.';

GRANT EXECUTE ON FUNCTION app.verifier_coherence(uuid) TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Verification : le rapprochement sait-il DESIGNER une anomalie ?
--
--  On en fabrique une, on verifie qu'elle est vue, et on defait. Un controle
--  qu'on n'a pas vu se declencher n'est pas un controle.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_avis    uuid;
    v_commune uuid;
    v_vues    integer;
BEGIN
    SELECT id, commune_id INTO v_avis, v_commune FROM app.avis_imposition LIMIT 1;
    IF v_avis IS NULL THEN
        RAISE NOTICE 'Aucun avis : rapprochement non eprouve ici.';
        RETURN;
    END IF;

    INSERT INTO app.transaction_wave (commune_id, avis_id, wave_session_id, montant,
                                      devise, telephone, statut, environnement,
                                      expire_le, confirme_le)
    VALUES (v_commune, v_avis, 'cos_epreuve_rapprochement', 1000, 'XOF',
            '+221700000000', 'reussie', 'sandbox', now() + interval '1 day', now());

    SELECT count(*) INTO v_vues
      FROM app.v_rapprochement_wave
     WHERE wave_session_id = 'cos_epreuve_rapprochement' AND gravite = 'erreur';

    DELETE FROM app.transaction_wave WHERE wave_session_id = 'cos_epreuve_rapprochement';

    IF v_vues <> 1 THEN
        RAISE EXCEPTION 'Le rapprochement n''a PAS vu un encaissement non impute.';
    END IF;
    RAISE NOTICE 'Rapprochement eprouve : un encaissement non impute est bien designe.';
END
$verif$;
