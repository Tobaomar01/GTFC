-- 0049 — Le prorata se compte sur les mois COUVERTS, non depuis janvier
--
-- Défaut constaté à l'exécution : attendu_prorata valait
-- montant_total × mois_écoulés_depuis_janvier / 12.
--
-- Sur un avis qui ne couvre que cinq mois — commerce recensé en août — cela
-- donnait 42 500 × 8/12 = 28 333 F « attendus » fin août, alors qu'un seul
-- mois avait couru. Le redevable, parfaitement à jour, aurait été signalé en
-- retard et relancé.
--
-- Une relance envoyée à quelqu'un qui a payé détruit la confiance plus
-- sûrement qu'une relance oubliée.
--
-- Correction : l'avis porte désormais le nombre de mois qu'il couvre, et le
-- prorata se calcule sur cette base.

ALTER TABLE app.avis_imposition
    ADD COLUMN IF NOT EXISTS mois_couverts smallint;

COMMENT ON COLUMN app.avis_imposition.mois_couverts IS
'Nombre de mois que le montant couvre. Vaut 12 sur une année pleine, moins pour un commerce recensé en cours d''année (FR-009b).';

-- Reprise des avis annuels déjà émis : on déduit les mois couverts de
-- l'écart entre le début d'accumulation et la fin de période.
UPDATE app.avis_imposition a
   SET mois_couverts = 12
  FROM app.periode_fiscale p
 WHERE p.id = a.periode_id
   AND a.mois_couverts IS NULL
   AND p.periodicite <> 'annuelle';

DROP VIEW IF EXISTS app.v_regularite_prorata;

CREATE VIEW app.v_regularite_prorata AS
WITH base AS (
    SELECT a.id               AS avis_id,
           a.commune_id,
           a.commerce_id,
           a.numero,
           p.annee,
           a.date_exigibilite,
           a.montant_total,
           a.montant_paye,
           a.montant_restant  AS solde,
           coalesce(a.mois_couverts, 12) AS mois_couverts,
           -- Premier mois réellement couvert par le montant.
           (date_trunc('month', p.date_fin)
              - make_interval(months => coalesce(a.mois_couverts, 12) - 1))::date AS debut_accumulation,
           greatest(1,
               (extract(year  from a.date_exigibilite)::int - extract(year  from current_date)::int) * 12
             + (extract(month from a.date_exigibilite)::int - extract(month from current_date)::int) + 1
           )                  AS mois_restants
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE a.annule_le IS NULL
       AND a.statut <> 'brouillon'
       AND p.periodicite = 'annuelle'
), calcule AS (
    SELECT b.*,
           least(b.mois_couverts, greatest(0,
               (extract(year  from current_date)::int - extract(year  from b.debut_accumulation)::int) * 12
             + (extract(month from current_date)::int - extract(month from b.debut_accumulation)::int) + 1
           )) AS mois_ecoules
      FROM base b
)
SELECT c.*,
       round(c.montant_total * c.mois_ecoules / c.mois_couverts::numeric) AS attendu_prorata,
       greatest(0, round(c.montant_total * c.mois_ecoules / c.mois_couverts::numeric) - c.montant_paye)
                                                    AS retard_regularite,
       (c.montant_paye > round(c.montant_total * c.mois_ecoules / c.mois_couverts::numeric))
                                                    AS en_avance,
       CASE WHEN c.solde > 0
            THEN app.arrondir_xof(ceil(c.solde::numeric / c.mois_restants))
            ELSE 0 END                              AS mensuel_conseille
  FROM calcule c;

COMMENT ON VIEW app.v_regularite_prorata IS
'Repère de pilotage et de paiement. Le prorata se compte sur les mois réellement couverts par l''avis, jamais depuis janvier : un commerce recensé en cours d''année ne doit pas être signalé en retard (US3/AC7).';
