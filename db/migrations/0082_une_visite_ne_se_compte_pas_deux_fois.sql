-- ===========================================================================
--  Une visite renvoyée deux fois était comptée deux fois
--
--  CE QUI A ÉTÉ CONSTATÉ le 09/09/2026, en relisant le chemin de la
--  synchronisation hors ligne.
--
--  Le téléphone remet en file toute opération restée « envoyée » sans réponse.
--  Son propre code le dit :
--
--      « Reprise après interruption : une opération restée "envoyee" sans
--        réponse est remise en file. LE SERVEUR EST IDEMPOTENT, un doublon est
--        sans effet. »
--
--  C'est vrai pour quatre entités sur cinq. traiterCommerce retrouve
--  l'enregistrement par son identifiant local, traiterPaiement par sa
--  référence, traiterAffichage et traiterChantier par leur trace dans
--  app.sync_operation. traiterVisite ne vérifiait RIEN, et app.visite ne
--  portait aucune contrainte d'unicité.
--
--  LE LOT NE PROTÈGE PAS. app.sync_lot déduplique sur
--  (agent_id, identifiant_client) — mais le téléphone tire un
--  Crypto.randomUUID() NEUF à chaque tentative. Deux envois de la même visite
--  sont donc deux lots distincts, et rien ne les rapproche.
--
--  QUAND CELA ARRIVE, ET CE N'EST PAS RARE : l'application tuée pendant un
--  envoi — batterie, Android qui récupère la mémoire, agent qui bascule
--  d'application — puis relancée. C'est-à-dire la journée ordinaire d'un agent
--  de terrain.
--
--  CE QUE CELA COÛTE. La visite est la trace du travail de l'agent : elle
--  nourrit les statistiques d'activité, le suivi de la feuille de route et le
--  déclencheur qui met à jour le commerce. Doublée, elle gonfle l'activité
--  déclarée d'un agent sans que personne ne puisse le voir — et dans une
--  administration fiscale, une mesure d'activité fausse n'est pas un détail
--  d'affichage.
--
--  DEUX BOUTS, ET IL FAUT LES DEUX.
--
--  Ici, la contrainte : la base refuse le doublon quoi qu'il arrive, y compris
--  si une reprise à la main ou un script rejoue un lot.
--
--  Dans sync.service.js, la reconnaissance : sans elle la contrainte ferait
--  ÉCHOUER l'opération, et le téléphone la marquerait rejetée alors qu'elle
--  est parfaitement enregistrée. Le serveur doit répondre « déjà enregistrée »,
--  comme il le fait pour les quatre autres.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  Les doublons déjà présents, s'il y en a.
--
--  Mesure du 09/09/2026 sur la base de recette : aucun. On ne supprime rien
--  pour autant — une écriture ne disparaît pas, c'est le premier principe du
--  projet. On refuse de poser la contrainte et on NOMME ce qu'il faut trancher
--  à la main, avec un humain qui décide.
-- ---------------------------------------------------------------------------
DO $etat_des_lieux$
DECLARE
    v_doublons integer;
BEGIN
    SELECT count(*) INTO v_doublons
      FROM (SELECT commune_id, identifiant_local
              FROM app.visite
             WHERE identifiant_local IS NOT NULL
             GROUP BY 1, 2
            HAVING count(*) > 1) d;

    IF v_doublons > 0 THEN
        RAISE EXCEPTION
            '% visite(s) en double existent déjà. Elles doivent être tranchées '
            'par une décision, pas par une migration : voir '
            'app.v_controle_visites_en_double.', v_doublons;
    END IF;

    RAISE NOTICE 'Aucune visite en double : la contrainte peut être posée.';
END
$etat_des_lieux$;

-- ---------------------------------------------------------------------------
--  La contrainte.
--
--  Partielle : les visites d'avant la synchronisation hors ligne, et celles
--  saisies depuis le tableau de bord, n'ont pas d'identifiant local. Elles ne
--  sont pas concernées — et ne doivent pas empêcher la règle de s'appliquer à
--  celles qui viennent du téléphone.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS visite_identifiant_local_unique
    ON app.visite (commune_id, identifiant_local)
 WHERE identifiant_local IS NOT NULL;

COMMENT ON INDEX app.visite_identifiant_local_unique IS
    'Une visite renvoyée par le téléphone après une interruption ne peut pas '
    'être enregistrée deux fois. Le lot, lui, ne protège pas : son identifiant '
    'est tiré au sort à chaque tentative.';

-- ---------------------------------------------------------------------------
--  La vue de contrôle. Elle doit rester vide.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_controle_visites_en_double AS
SELECT v.commune_id,
       v.identifiant_local,
       count(*)                     AS nombre,
       min(v.debute_le)             AS premiere,
       max(v.debute_le)             AS derniere,
       'Même visite enregistrée plusieurs fois : l''activité de l''agent est '
       'surévaluée d''autant.'::text AS consequence
  FROM app.visite v
 WHERE v.identifiant_local IS NOT NULL
 GROUP BY v.commune_id, v.identifiant_local
HAVING count(*) > 1;

COMMENT ON VIEW app.v_controle_visites_en_double IS
    'DOIT rester vide. Chaque ligne est une visite comptée plusieurs fois, '
    'donc une mesure d''activité fausse.';

ALTER VIEW app.v_controle_visites_en_double SET (security_invoker = true);

DO $droits$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        EXECUTE 'GRANT SELECT ON app.v_controle_visites_en_double TO gtfc_app';
    END IF;
END
$droits$;

-- ---------------------------------------------------------------------------
--  Vérification : la contrainte refuse-t-elle vraiment ?
--
--  On l'éprouve sur place plutôt que de la déclarer bonne. Une migration qui
--  pose un garde-fou sans le mettre à l'épreuve, c'est exactement ce qui a
--  permis à 0023 de passer pour appliquée en ne faisant rien.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_commune  uuid;
    v_agent    uuid;
    v_commerce uuid;
    v_marque   text := 'epreuve-doublon-' || gen_random_uuid()::text;
    v_refuse   boolean := false;
BEGIN
    SELECT c.id INTO v_commune FROM app.commune c ORDER BY c.cree_le LIMIT 1;
    SELECT u.id INTO v_agent
      FROM app.utilisateur u
     WHERE u.commune_id = v_commune AND u.archive_le IS NULL
     LIMIT 1;
    SELECT co.id INTO v_commerce
      FROM app.commerce co
     WHERE co.commune_id = v_commune AND co.archive_le IS NULL
     LIMIT 1;

    IF v_commune IS NULL OR v_agent IS NULL OR v_commerce IS NULL THEN
        RAISE NOTICE 'Base sans commune, agent ou commerce : contrainte non éprouvée ici.';
        RETURN;
    END IF;

    BEGIN
        INSERT INTO app.visite (commune_id, commerce_id, agent_id, resultat,
                                debute_le, hors_ligne, identifiant_local)
        VALUES (v_commune, v_commerce, v_agent, 'controle', now(), true, v_marque);

        -- Le même envoi, une seconde fois : c'est la reprise après interruption.
        INSERT INTO app.visite (commune_id, commerce_id, agent_id, resultat,
                                debute_le, hors_ligne, identifiant_local)
        VALUES (v_commune, v_commerce, v_agent, 'controle', now(), true, v_marque);
    EXCEPTION WHEN unique_violation THEN
        v_refuse := true;
    END;

    -- On ne laisse pas derrière soi la visite de l'épreuve : elle compterait
    -- dans l'activité de l'agent, ce que cette migration cherche justement à
    -- garder juste.
    DELETE FROM app.visite WHERE identifiant_local = v_marque;

    IF NOT v_refuse THEN
        RAISE EXCEPTION
            'La contrainte n''a PAS refusé la seconde visite : elle ne protège rien.';
    END IF;

    RAISE NOTICE 'Contrainte éprouvée : une visite renvoyée deux fois est refusée.';
END
$verif$;
