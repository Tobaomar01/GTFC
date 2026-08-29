-- 0046 — Liquidation annuelle et solde restant dû
--          (FR-021, FR-021a, FR-021c, FR-021e, FR-021f)
--
-- Décision du commanditaire : la taxe est liquidée UNE FOIS PAR AN. La somme
-- constitue un solde que le redevable résorbe à son rythme — en une fois,
-- par mensualités, ou par versements de son choix. Il peut payer en avance.
--
-- Pourquoi ce changement : un calendrier fixe de douze échéances produit des
-- « retards » artificiels chez qui paie plus tôt et plus gros, et fausse le
-- taux de recouvrement. Le solde, lui, dit la vérité.
--
-- La mécanique existante n'est pas jetée : `montant_restant` était déjà un
-- solde, et generer_avis_periode travaille déjà sur une période fiscale. Il
-- suffit que la période soit annuelle et que le mensuel devienne un repère.

-- 1. Le douzième mensuel, comme repère de régularité et non comme échéance
ALTER TABLE app.avis_imposition
    ADD COLUMN IF NOT EXISTS mensuel_indicatif numeric(14,0)
        GENERATED ALWAYS AS (round(montant_total / 12.0)) STORED;

COMMENT ON COLUMN app.avis_imposition.mensuel_indicatif IS
'Douzième de la liquidation annuelle. Repère proposé au redevable, sans valeur d''échéance opposable (FR-021f).';

COMMENT ON COLUMN app.avis_imposition.montant_restant IS
'Solde restant dû. C''est lui qui fait foi, pas un calendrier de mensualités (FR-021, FR-021e).';

-- 2. Création d'une période ANNUELLE
CREATE OR REPLACE FUNCTION app.creer_periode_annuelle(
    p_commune_id uuid,
    p_annee      integer,
    p_jour_exigibilite integer DEFAULT 31
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    v_id     uuid;
    v_debut  date := make_date(p_annee, 1, 1);
    v_fin    date := make_date(p_annee, 12, 31);
    v_exig   date := make_date(p_annee, 12, least(p_jour_exigibilite, 31));
BEGIN
    INSERT INTO app.periode_fiscale
        (commune_id, code, annee, mois, periodicite, date_debut, date_fin, date_exigibilite)
    VALUES (p_commune_id, p_annee::text, p_annee, NULL, 'annuelle', v_debut, v_fin, v_exig)
    ON CONFLICT (commune_id, code) DO UPDATE SET date_exigibilite = EXCLUDED.date_exigibilite
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION app.creer_periode_annuelle IS
'Crée la période fiscale de l''année. Remplace creer_periode_mensuelle pour la facturation (FR-021).';

-- 3. Indicateur de régularité au prorata (US3/AC7)
--
-- Le solde fait foi juridiquement. Cet indicateur ne sert qu'au pilotage :
-- il compare ce qui a été versé à ce qui l'aurait été au rythme du douzième.
-- Un écart n'est PAS une dette exigible — le vocabulaire le dit.
CREATE OR REPLACE VIEW app.v_regularite_prorata AS
    SELECT a.id                AS avis_id,
           a.commune_id,
           a.commerce_id,
           a.numero,
           p.annee,
           a.montant_total,
           a.montant_paye,
           a.montant_restant  AS solde,
           a.mensuel_indicatif,
           least(12, greatest(0,
               (extract(year  from current_date)::int - extract(year  from p.date_debut)::int) * 12
             + (extract(month from current_date)::int - extract(month from p.date_debut)::int) + 1
           ))                  AS mois_ecoules,
           round(a.montant_total * least(12, greatest(0,
               (extract(year  from current_date)::int - extract(year  from p.date_debut)::int) * 12
             + (extract(month from current_date)::int - extract(month from p.date_debut)::int) + 1
           )) / 12.0)          AS attendu_prorata,
           greatest(0, round(a.montant_total * least(12, greatest(0,
               (extract(year  from current_date)::int - extract(year  from p.date_debut)::int) * 12
             + (extract(month from current_date)::int - extract(month from p.date_debut)::int) + 1
           )) / 12.0) - a.montant_paye) AS retard_regularite,
           (a.montant_paye > round(a.montant_total * least(12, greatest(0,
               (extract(year  from current_date)::int - extract(year  from p.date_debut)::int) * 12
             + (extract(month from current_date)::int - extract(month from p.date_debut)::int) + 1
           )) / 12.0))         AS en_avance
      FROM app.avis_imposition a
      JOIN app.periode_fiscale p ON p.id = a.periode_id
     WHERE a.annule_le IS NULL
       AND a.statut <> 'brouillon'
       AND p.periodicite = 'annuelle';

COMMENT ON VIEW app.v_regularite_prorata IS
'Repère de pilotage, jamais une dette exigible. Un redevable qui a payé en avance n''est jamais en retard de régularité (US3/AC7).';

-- 4. La facturation mensuelle est dépréciée, non supprimée : d'anciennes
--    périodes mensuelles peuvent exister et doivent rester lisibles.
COMMENT ON FUNCTION app.creer_periode_mensuelle(uuid, integer, integer) IS
'DÉPRÉCIÉE depuis 0046 — la facturation est annuelle. Conservée pour les périodes déjà créées.';
