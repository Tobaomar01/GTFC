-- 0048 — Le repère mensuel se calcule sur les mois RESTANTS
--
-- Défaut constaté à l'exécution : mensuel_indicatif valait montant_total / 12.
-- Sur une année pleine c'est juste. Sur une année partielle — un commerce
-- recensé en août doit 42 500 F sur cinq mois — le repère affichait 3 542 F
-- au lieu de 8 500 F. Un redevable qui l'aurait suivi aurait sous-payé.
--
-- Un repère de régularité qui conduit à sous-payer manque son but.
--
-- Le calcul devient DYNAMIQUE : solde restant dû divisé par le nombre de
-- mois qui séparent aujourd'hui de l'exigibilité. Il dit ce qu'il faut
-- verser à partir de maintenant pour solder à temps, et se resserre
-- naturellement si le redevable prend du retard.
--
-- Un montant généré ne peut pas dépendre de la date du jour : la colonne
-- est donc dépréciée au profit d'une vue.

COMMENT ON COLUMN app.avis_imposition.mensuel_indicatif IS
'DÉPRÉCIÉE depuis 0048 — douzième figé, trompeur sur une année partielle. Utiliser app.v_regularite_prorata.mensuel_conseille.';

-- La vue change de colonnes : CREATE OR REPLACE ne suffit pas.
DROP VIEW IF EXISTS app.v_regularite_prorata;

CREATE VIEW app.v_regularite_prorata AS
WITH base AS (
    SELECT a.id                AS avis_id,
           a.commune_id,
           a.commerce_id,
           a.numero,
           p.annee,
           p.date_debut,
           a.date_exigibilite,
           a.montant_total,
           a.montant_paye,
           a.montant_restant  AS solde,
           least(12, greatest(0,
               (extract(year  from current_date)::int - extract(year  from p.date_debut)::int) * 12
             + (extract(month from current_date)::int - extract(month from p.date_debut)::int) + 1
           ))                  AS mois_ecoules,
           -- Au moins un mois : passé l'exigibilité, le solde est dû en une fois.
           greatest(1,
               (extract(year  from a.date_exigibilite)::int - extract(year  from current_date)::int) * 12
             + (extract(month from a.date_exigibilite)::int - extract(month from current_date)::int) + 1
           )                   AS mois_restants
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE a.annule_le IS NULL
       AND a.statut <> 'brouillon'
       AND p.periodicite = 'annuelle'
)
SELECT b.*,
       round(b.montant_total * b.mois_ecoules / 12.0) AS attendu_prorata,
       greatest(0, round(b.montant_total * b.mois_ecoules / 12.0) - b.montant_paye)
                                                      AS retard_regularite,
       (b.montant_paye > round(b.montant_total * b.mois_ecoules / 12.0)) AS en_avance,
       -- Arrondi au SUPÉRIEUR : arrondir au plus proche laisserait un
       -- reliquat de quelques francs au dernier versement.
       CASE WHEN b.solde > 0
            THEN app.arrondir_xof(ceil(b.solde::numeric / b.mois_restants))
            ELSE 0 END                                AS mensuel_conseille
  FROM base b;

COMMENT ON VIEW app.v_regularite_prorata IS
'Repère de pilotage et de paiement. mensuel_conseille = solde / mois restants jusqu''à exigibilité : ce qu''il faut verser à partir de maintenant pour solder à temps (FR-021f).';

COMMENT ON COLUMN app.v_regularite_prorata.retard_regularite IS
'Écart au rythme du douzième. Repère de pilotage, JAMAIS une dette exigible : le solde seul fait foi (US3/AC7).';
