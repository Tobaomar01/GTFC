-- ===========================================================================
--  L'indicateur de risque de defaut de paiement
--  Exigences FR-089 a FR-092 (specification, session 2026-09-08)
--
--  CE QU'IL EST, ET CE QU'IL N'EST PAS.
--
--  Il sert a ORDONNER LES VISITES D'ACCOMPAGNEMENT : a qui le temps d'un agent
--  profite-t-il le plus. Il ne declenche aucun acte administratif, ne descend
--  pas sur le telephone des agents, et n'apparait dans aucun message au
--  redevable (FR-092). L'agent continue de lire un MOTIF en clair — « paiement
--  interrompu » — jamais une note. Quelqu'un qui lit « risque eleve » avant
--  d'entrer ne parle pas de la meme facon a la personne qu'il visite.
--
--  POURQUOI DES REGLES ET PAS UN MODELE. Il n'y a rien a apprendre : la base
--  porte quelques mois. Et un modele appris n'explique pas sa sortie au
--  commercant qui la conteste. Ici chaque facteur est nomme, pese, et rendu
--  AVEC le niveau — FR-089 interdit d'afficher l'un sans les autres.
--
--  POURQUOI LES POIDS SONT EN BASE. Un seuil de recouvrement se decide par
--  deliberation du conseil municipal, pas par deploiement (principe VIII).
--  Les valeurs livrees sont PROVISOIRES et attendent la mairie : voir
--  docs/QUESTIONS-RISQUE-DEFAUT.md.
--
--  CE QUI EST ECARTE DU CALCUL, ET POURQUOI :
--    · les mois sans avis          — rien n'etait facture, il n'y a rien a juger ;
--    · les exonerations en vigueur — c'est une decision de la mairie, pas un
--                                    comportement du commercant ;
--    · les contestations ouvertes  — tant que le montant est discute, ne pas
--                                    payer n'est pas un defaut.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  Les poids et les seuils, parametres de la commune.
-- ---------------------------------------------------------------------------
ALTER TABLE app.commune_parametre
    ADD COLUMN IF NOT EXISTS risque_mois_minimaux smallint NOT NULL DEFAULT 2,
    ADD COLUMN IF NOT EXISTS risque_poids_jamais_regle smallint NOT NULL DEFAULT 40,
    ADD COLUMN IF NOT EXISTS risque_poids_reglement_interrompu smallint NOT NULL DEFAULT 25,
    ADD COLUMN IF NOT EXISTS risque_poids_retard_habituel smallint NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS risque_poids_reglement_partiel smallint NOT NULL DEFAULT 15,
    ADD COLUMN IF NOT EXISTS risque_poids_relances_repetees smallint NOT NULL DEFAULT 5,
    ADD COLUMN IF NOT EXISTS risque_interruption_jours smallint NOT NULL DEFAULT 60,
    ADD COLUMN IF NOT EXISTS risque_relances_tolerees smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS risque_seuil_attention smallint NOT NULL DEFAULT 30,
    ADD COLUMN IF NOT EXISTS risque_seuil_eleve smallint NOT NULL DEFAULT 60;

COMMENT ON COLUMN app.commune_parametre.risque_mois_minimaux IS
    'En deca de ce nombre de mois observes, l''indicateur repond « indetermine » '
    '(FR-091). Un chiffre calcule sur un historique trop mince est une illusion '
    'de connaissance.';

COMMENT ON COLUMN app.commune_parametre.risque_seuil_eleve IS
    'Total a partir duquel un commerce est propose en priorite pour une visite '
    'd''accompagnement. La bonne valeur depend du nombre d''agents et de la '
    'taille des tournees, pas d''un principe.';

DO $bornes$
BEGIN
    -- Un seuil « eleve » sous le seuil « attention » rendrait le classement
    -- incomprehensible sans rien casser : exactement le genre de reglage faux
    -- qui passe inapercu des mois.
    ALTER TABLE app.commune_parametre
        DROP CONSTRAINT IF EXISTS ck_risque_seuils_ordonnes;
    ALTER TABLE app.commune_parametre
        ADD CONSTRAINT ck_risque_seuils_ordonnes
        CHECK (risque_seuil_attention > 0
               AND risque_seuil_eleve > risque_seuil_attention
               AND risque_mois_minimaux >= 1
               AND risque_interruption_jours >= 1);
END
$bornes$;

-- ===========================================================================
--  Ce que la memoire dit d'un commerce.
-- ===========================================================================
CREATE OR REPLACE VIEW app.v_risque_defaut AS
WITH observes AS (
    SELECT o.commune_id,
           o.commerce_id,
           o.mois,
           o.montant_regle_cumule,
           o.montant_regle_mois,
           o.montant_restant,
           o.echeance_depassee,
           o.jours_depuis_reglement,
           o.nb_avis_relances
      FROM app.observation_mensuelle o
     WHERE o.remplacee_le IS NULL
       AND o.nb_avis > 0
       AND NOT o.exoneration_en_vigueur
       AND NOT o.contestation_ouverte
),
comptes AS (
    SELECT commune_id,
           commerce_id,
           count(*)::integer                                            AS nb_mois,
           max(mois)                                                    AS dernier_mois,
           count(*) FILTER (WHERE echeance_depassee)::integer            AS nb_mois_echeance_depassee,
           count(*) FILTER (WHERE montant_regle_mois > 0
                              AND montant_restant > 0)::integer          AS nb_mois_partiels,
           max(nb_avis_relances)::integer                                AS relances_maximum,
           -- Les valeurs du DERNIER mois observe : l'etat le plus recent que
           -- la memoire connaisse, et non l'etat courant — qui, lui, bouge.
           (array_agg(montant_regle_cumule ORDER BY mois DESC))[1]       AS regle_cumule_fin,
           (array_agg(montant_restant      ORDER BY mois DESC))[1]       AS restant_fin,
           (array_agg(jours_depuis_reglement ORDER BY mois DESC))[1]     AS jours_sans_reglement
      FROM observes
     GROUP BY commune_id, commerce_id
)
SELECT
    c.commune_id,
    c.commerce_id,
    c.nb_mois,
    c.dernier_mois,
    f.score,
    -- FR-091 : en deca du minimum, aucun niveau. Le score reste lisible, mais
    -- il ne CLASSE pas — c'est la difference entre une mesure et un jugement.
    CASE
        WHEN c.nb_mois < p.risque_mois_minimaux    THEN 'indetermine'
        WHEN f.score >= p.risque_seuil_eleve       THEN 'eleve'
        WHEN f.score >= p.risque_seuil_attention   THEN 'attention'
        ELSE 'faible'
    END AS niveau,
    p.risque_mois_minimaux AS mois_minimaux,
    -- FR-089 : le niveau ne se montre jamais sans ce qui l'a forme.
    coalesce(f.facteurs, '[]'::jsonb) AS facteurs
  FROM comptes c
  JOIN app.commune_parametre p ON p.commune_id = c.commune_id
  CROSS JOIN LATERAL (
      SELECT coalesce(sum((x.facteur->>'poids')::integer), 0)::integer AS score,
             jsonb_agg(x.facteur ORDER BY (x.facteur->>'poids')::integer DESC) AS facteurs
        FROM (
            SELECT jsonb_build_object(
                       'code', 'jamais_regle',
                       'libelle', 'N''a jamais rien regle depuis le premier avis',
                       'poids', p.risque_poids_jamais_regle) AS facteur
             WHERE c.regle_cumule_fin = 0
            UNION ALL
            SELECT jsonb_build_object(
                       'code', 'reglement_interrompu',
                       'libelle', 'A regle par le passe, puis plus rien depuis '
                                  || p.risque_interruption_jours || ' jours',
                       'poids', p.risque_poids_reglement_interrompu)
             WHERE c.regle_cumule_fin > 0
               AND c.restant_fin > 0
               AND c.jours_sans_reglement > p.risque_interruption_jours
            UNION ALL
            SELECT jsonb_build_object(
                       'code', 'retard_habituel',
                       'libelle', 'Echeance depassee la plupart des mois observes',
                       'poids', p.risque_poids_retard_habituel)
             WHERE c.nb_mois_echeance_depassee * 2 > c.nb_mois
            UNION ALL
            SELECT jsonb_build_object(
                       'code', 'reglement_partiel_repete',
                       'libelle', 'Verse sans solder, plusieurs mois de suite',
                       'poids', p.risque_poids_reglement_partiel)
             WHERE c.nb_mois_partiels >= 2
            UNION ALL
            SELECT jsonb_build_object(
                       'code', 'relances_repetees',
                       'libelle', 'Relance plus souvent que le seuil tolere',
                       'poids', p.risque_poids_relances_repetees)
             WHERE c.relances_maximum > p.risque_relances_tolerees
        ) x
  ) f;

ALTER VIEW app.v_risque_defaut SET (security_invoker = true);

COMMENT ON VIEW app.v_risque_defaut IS
    'Indicateur de risque de defaut, lu sur les observations arretees. Rend le '
    'niveau ET les facteurs qui l''ont forme : afficher l''un sans les autres '
    'viole FR-089. Reserve aux profils de la mairie (FR-092).';

GRANT SELECT ON app.v_risque_defaut TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Verification : l'isolation n'est pas rouverte par cette vue.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_restantes text;
BEGIN
    SELECT string_agg(DISTINCT vue, ', ') INTO v_restantes
      FROM app.v_controle_vues_isolees;

    IF v_restantes IS NOT NULL THEN
        RAISE EXCEPTION 'Vues hors isolation apres 0074 : %', v_restantes;
    END IF;
END
$verif$;
