-- ===========================================================================
--  La feuille de route s'ordonne aussi par le risque de defaut
--  Exigence FR-088 (specification, session 2026-09-08)
--
--  L'indicateur ne servait a rien. Il s'affichait sur une page que personne
--  n'a le temps d'ouvrir tous les matins, et les tournees continuaient d'etre
--  composees sans lui. Un indicateur qui ne change aucune decision n'est pas
--  un indicateur : c'est une decoration.
--
--  IL DEPARTAGE, IL NE COMMANDE PAS. Le MOTIF reste le premier critere :
--  une fiche a completer passe toujours devant un impaye, et un impaye devant
--  un paiement partiel. Le score n'intervient qu'A L'INTERIEUR d'un meme
--  motif, la ou le tri se faisait jusqu'ici par simple anciennete de visite.
--  L'inverser donnerait au calcul le dernier mot sur la journee d'un agent.
--
--  L'AGENT NE VOIT TOUJOURS AUCUN NIVEAU. Seul l'ORDRE des lignes change. Il
--  lit le meme motif en clair qu'avant — « paiement interrompu » — qui dit
--  quoi faire sans porter de jugement sur la personne visitee (FR-088).
--
--  UN COMMERCE SANS MEMOIRE NE PERD RIEN : score zero, et il garde son rang
--  d'anciennete. Pendant toute la phase ou l'historique est mince, cette
--  migration ne change donc rien du tout — ce qui est le comportement voulu.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.composer_feuille_route(p_agent uuid, p_date date DEFAULT CURRENT_DATE, p_par uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_commune  uuid;
    v_role     text;
    v_actif    boolean;
    v_objectif integer;
    v_delai    integer;
    v_feuille  uuid;
BEGIN
    SELECT u.commune_id, u.role::text, u.actif
      INTO v_commune, v_role, v_actif
      FROM app.utilisateur u WHERE u.id = p_agent;

    IF v_commune IS NULL THEN
        RAISE EXCEPTION 'Agent introuvable : %', p_agent;
    END IF;
    IF NOT v_actif THEN
        RAISE EXCEPTION 'Agent inactif : aucune feuille de route';
    END IF;
    IF v_role <> 'agent' THEN
        RAISE EXCEPTION 'Une feuille de route ne se compose que pour un agent (role : %)', v_role;
    END IF;

    SELECT f.id INTO v_feuille
      FROM app.feuille_route f
     WHERE f.agent_id = p_agent AND f.date_tournee = p_date;
    IF v_feuille IS NOT NULL THEN
        RETURN v_feuille;
    END IF;

    SELECT coalesce(cp.objectif_visites_jour_agent, 0),
           coalesce(cp.delai_suivi_recensement_jours, 0)
      INTO v_objectif, v_delai
      FROM app.commune_parametre cp WHERE cp.commune_id = v_commune;
    v_objectif := coalesce(v_objectif, 0);
    v_delai    := coalesce(v_delai, 0);

    INSERT INTO app.feuille_route (commune_id, agent_id, date_tournee, objectif, composee_par)
    VALUES (v_commune, p_agent, p_date, v_objectif, p_par)
    RETURNING id INTO v_feuille;

    INSERT INTO app.feuille_route_ligne (feuille_id, commerce_id, motif, ordre)
    SELECT v_feuille, c.commerce_id, c.motif,
           row_number() OVER (ORDER BY c.rang, c.score_risque DESC, c.derniere_visite_le NULLS FIRST, c.code)
      FROM (
        SELECT co.id AS commerce_id,
               co.code,
               CASE
                 WHEN fc.id IS NOT NULL
                   THEN 'fiche_a_completer'::app.motif_visite
                 WHEN sp.motif_accompagnement IS NOT NULL
                   THEN sp.motif_accompagnement
                 -- Le suivi ne vaut qu'AVANT le premier avis : ensuite, les
                 -- motifs de paiement en disent davantage.
                 WHEN v_delai > 0
                      AND sp.commerce_id IS NULL
                      AND co.date_recensement IS NOT NULL
                      AND co.date_recensement <= (p_date - v_delai)
                      AND NOT EXISTS (
                            SELECT 1 FROM app.visite vs
                             WHERE vs.commerce_id = co.id
                               AND vs.debute_le::date > co.date_recensement)
                   THEN 'suivi_recensement'::app.motif_visite
                 ELSE NULL
               END AS motif,
               CASE
                 WHEN fc.id IS NOT NULL                              THEN 1
                 WHEN sp.motif_accompagnement = 'jamais_paye'         THEN 2
                 WHEN sp.motif_accompagnement IS NULL                 THEN 3
                 WHEN sp.motif_accompagnement = 'paiement_interrompu' THEN 4
                 WHEN sp.motif_accompagnement = 'paiement_partiel'    THEN 5
                 ELSE 9
               END AS rang,
               -- La derniere RE-visite, pas la derniere visite : le
               -- recensement lui-meme ne compte pas. Voir le garde-fou
               -- plus bas, qu'il annulait.
               (SELECT max(vi.debute_le) FROM app.visite vi
                 WHERE vi.commerce_id = co.id
                   AND vi.debute_le::date > co.date_recensement) AS derniere_visite_le,
               -- Zero quand la memoire ne dit rien : un commerce sans
               -- historique ne passe ni devant ni derriere, il garde son
               -- rang d'anciennete.
               coalesce(rq.score, 0) AS score_risque
          FROM app.commerce co
          LEFT JOIN app.v_fiche_a_completer fc ON fc.id = co.id
          LEFT JOIN app.v_situation_paiement sp ON sp.commerce_id = co.id
          LEFT JOIN app.v_risque_defaut rq ON rq.commerce_id = co.id
         WHERE co.commune_id = v_commune
           AND co.archive_le IS NULL
           AND EXISTS (
                 SELECT 1 FROM app.affectation_agent aa
                  WHERE aa.utilisateur_id = p_agent
                    AND aa.date_debut <= p_date
                    AND (aa.date_fin IS NULL OR aa.date_fin >= p_date)
                    AND ( (aa.quartier_id IS NOT NULL AND aa.quartier_id = co.quartier_id)
                       OR (aa.quartier_id IS NULL AND aa.zone_id = co.zone_id) ))
      ) c
     WHERE c.motif IS NOT NULL
       -- ---------------------------------------------------------------
       --  On ne revient pas chez quelqu'un vu il y a moins de trente jours.
       --
       --  MAIS le recensement ne compte pas comme une visite recente, et
       --  c'est tout l'objet du « > co.date_recensement » ci-dessus.
       --
       --  Sans cette precision, un commerce recense il y a neuf jours portait
       --  une visite vieille de neuf jours, et ce garde-fou l'ecartait — alors
       --  meme que son gerant n'est pas joignable et qu'aucun avis ne peut
       --  partir sans lui. La liste du second passage n'atteignait donc AUCUNE
       --  feuille de route pendant le premier mois, precisement la periode ou
       --  elle sert. Et la visite de suivi, jamais.
       --
       --  Mesure avant correction : sept fiches a completer, six commerces
       --  eligibles au suivi, ZERO retenu. Trouve en composant.
       -- ---------------------------------------------------------------
       AND (c.derniere_visite_le IS NULL
            OR c.derniere_visite_le < (p_date - interval '30 days'))
       AND NOT EXISTS (
             SELECT 1 FROM app.feuille_route_ligne l
               JOIN app.feuille_route f ON f.id = l.feuille_id
              WHERE f.date_tournee = p_date
                AND f.commune_id = v_commune
                AND l.commerce_id = c.commerce_id
                AND l.retiree_le IS NULL)
     ORDER BY c.rang, c.score_risque DESC, c.derniere_visite_le NULLS FIRST, c.code
     LIMIT v_objectif;

    RETURN v_feuille;
END
$function$;
