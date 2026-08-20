-- ===========================================================================
--  0023 — La patente sort du périmètre de collecte communale
--
--  CE QUE CETTE MIGRATION CORRIGE
--
--  Le jeu initial appliquait la patente d'office à TOUS les commerces, au
--  même titre que la TEOM. C'est une erreur de fond : la patente a été
--  remplacée en 2018 par la contribution économique locale (CEL), qui se
--  décompose en CEL-VL (valeur locative) et CEL-VA (valeur ajoutée).
--
--  Dans les deux cas l'impôt est établi et recouvré par la Direction Générale
--  des Impôts et des Domaines. Il ne transite pas par un agent municipal.
--  La commune en perçoit le produit — intégralement pour la CEL-VL — mais
--  n'en est pas le collecteur.
--
--  Laisser la patente active aurait fait réclamer par un agent communal un
--  impôt que le commerçant doit déclarer à la DGID. Sur le terrain, cela se
--  serait traduit par un double appel à paiement, et par une contestation
--  légitime que la mairie aurait perdue.
--
--  CE QUI RESTE DÛ À LA COMMUNE par une société installée dans un immeuble :
--  la taxe sur ses dispositifs d'affichage, la TEOM, et la TODP si elle
--  empiète sur le domaine public.
--
--  CE QUE CETTE MIGRATION NE FAIT PAS
--
--  Elle ne touche à AUCUN avis déjà émis. Annuler ou dégrever une créance
--  notifiée est une décision municipale, pas l'effet secondaire d'un script.
--  Les avis concernés sont comptés et signalés à l'exploitant.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. La patente cesse d'être proposée d'office
-- ---------------------------------------------------------------------------
DELETE FROM ref.categorie_taxe ct
 USING ref.type_taxe t
 WHERE ct.type_taxe_id = t.id AND t.code = 'patente';

-- ---------------------------------------------------------------------------
-- 2. Désactivation par commune, avec la raison inscrite en base
-- ---------------------------------------------------------------------------
UPDATE ref.commune_type_taxe ctt
   SET actif       = false,
       libelle_local = 'Patente — remplacée par la CEL (DGID), hors collecte communale',
       modifie_le  = now()
  FROM ref.type_taxe t
 WHERE ctt.type_taxe_id = t.id AND t.code = 'patente';

-- ---------------------------------------------------------------------------
-- 3. Désactivation du type lui-même
--    La substitution est nationale, pas propre à une commune : une commune
--    créée demain ne doit pas pouvoir la réactiver par simple oubli.
-- ---------------------------------------------------------------------------
UPDATE ref.type_taxe
   SET actif       = false,
       description = 'Remplacée depuis 2018 par la contribution économique locale (CEL-VL et '
                     || 'CEL-VA), établie et recouvrée par la DGID. Hors périmètre de collecte '
                     || 'communale : conservée uniquement pour expliquer les avis antérieurs.',
       modifie_le  = now()
 WHERE code = 'patente';

-- ---------------------------------------------------------------------------
-- 4. Clôture des barèmes de patente encore en vigueur
--    Le barème n'est pas supprimé : il explique les avis passés.
-- ---------------------------------------------------------------------------
--    Deux situations distinctes.
--
--    a) Un barème dont la date d'effet est ENCORE À VENIR et sous lequel
--       aucun avis n'a été émis n'a produit aucun effet et n'en produira
--       jamais. Il n'y a rien à expliquer plus tard : il est supprimé.
--       Le clore serait impossible de toute façon — la contrainte bareme_dates
--       exige un intervalle non vide.
DELETE FROM app.bareme_tranche tr
 USING app.bareme_taxe b, ref.type_taxe t
 WHERE tr.bareme_id = b.id AND b.type_taxe_id = t.id AND t.code = 'patente'
   AND b.date_effet > current_date
   AND NOT EXISTS (SELECT 1 FROM app.avis_ligne l WHERE l.bareme_id = b.id);

DELETE FROM app.bareme_taxe b
 USING ref.type_taxe t
 WHERE b.type_taxe_id = t.id AND t.code = 'patente'
   AND b.date_effet > current_date
   AND NOT EXISTS (SELECT 1 FROM app.avis_ligne l WHERE l.bareme_id = b.id);

--    b) Un barème en vigueur est clos aujourd'hui. Le « + 1 jour » couvre le
--       cas d'un barème entré en vigueur le jour même : l'intervalle doit
--       rester non vide, sinon la contrainte le refuse.
UPDATE app.bareme_taxe b
   SET date_fin   = GREATEST(current_date, b.date_effet + 1),
       modifie_le = now()
  FROM ref.type_taxe t
 WHERE b.type_taxe_id = t.id AND t.code = 'patente'
   AND (b.date_fin IS NULL OR b.date_fin > GREATEST(current_date, b.date_effet + 1));

-- ---------------------------------------------------------------------------
-- 4 bis. LE POINT QUI ARRÊTE RÉELLEMENT LA FACTURATION
--
--  app.generer_avis_periode() ne consulte NI ref.type_taxe.actif, NI
--  ref.commune_type_taxe.actif : elle parcourt app.commerce_taxe, le lien
--  entre un commerce et les taxes qu'il doit, établi lors du recensement.
--
--  Désactiver la patente aux deux premiers niveaux sans toucher au troisième
--  aurait donné une base d'apparence propre — patente inactive partout dans
--  les référentiels — et une facture de septembre portant toujours la ligne.
--  C'est le genre d'écart qu'on ne découvre qu'en lisant la quittance d'un
--  commerçant mécontent.
--
--  Le lien est CLOS à la date du jour plutôt que supprimé : il explique les
--  avis émis tant qu'il était ouvert.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_liens integer;
BEGIN
    UPDATE app.commerce_taxe ct
       SET actif      = false,
           date_fin   = GREATEST(current_date, ct.date_debut + 1),
           modifie_le = now()
      FROM ref.type_taxe t
     WHERE ct.type_taxe_id = t.id AND t.code = 'patente' AND ct.actif;
    GET DIAGNOSTICS v_liens = ROW_COUNT;

    RAISE NOTICE 'Patente : % lien(s) commerce-taxe clos — plus aucune facturation à venir.', v_liens;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Avis encore au brouillon : la ligne de patente est retirée
--    Un brouillon n'a été notifié à personne. Le corriger est sans effet de
--    bord — et le laisser tel quel enverrait la facture fausse au 1er du mois.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_lignes    integer;
    v_avis      integer;
    v_emis      integer;
    v_montant   numeric;
BEGIN
    CREATE TEMP TABLE avis_touches ON COMMIT DROP AS
    SELECT DISTINCT l.avis_id
      FROM app.avis_ligne l
      JOIN ref.type_taxe t ON t.id = l.type_taxe_id
      JOIN app.avis_imposition a ON a.id = l.avis_id
     WHERE t.code = 'patente' AND a.statut = 'brouillon';

    DELETE FROM app.avis_ligne l
     USING ref.type_taxe t, app.avis_imposition a
     WHERE l.type_taxe_id = t.id AND a.id = l.avis_id
       AND t.code = 'patente' AND a.statut = 'brouillon';
    GET DIAGNOSTICS v_lignes = ROW_COUNT;

    -- Les totaux de l'avis sont recalculés depuis ses lignes restantes :
    -- les recopier à la main les ferait diverger au premier oubli.
    UPDATE app.avis_imposition a
       SET montant_taxes   = coalesce(s.brut, 0),
           montant_exonere = coalesce(s.exonere, 0),
           montant_total   = coalesce(s.net, 0) + a.montant_penalite
                             - a.montant_remise + a.report_anterieur,
           modifie_le      = now()
      FROM (SELECT l.avis_id,
                   sum(l.montant_brut)     AS brut,
                   sum(l.montant_exonere)  AS exonere,
                   sum(l.montant)          AS net
              FROM app.avis_ligne l
             GROUP BY l.avis_id) s
     WHERE a.id = s.avis_id AND a.id IN (SELECT avis_id FROM avis_touches);

    -- Un avis dont la patente était la seule ligne tombe à zéro.
    UPDATE app.avis_imposition a
       SET montant_taxes = 0, montant_exonere = 0,
           montant_total = a.montant_penalite - a.montant_remise + a.report_anterieur,
           modifie_le    = now()
     WHERE a.id IN (SELECT avis_id FROM avis_touches)
       AND NOT EXISTS (SELECT 1 FROM app.avis_ligne l WHERE l.avis_id = a.id);

    SELECT count(*) INTO v_avis FROM avis_touches;

    -- --- Avis déjà notifiés : on informe, on ne touche à rien -------------
    SELECT count(DISTINCT a.id), coalesce(sum(l.montant), 0)
      INTO v_emis, v_montant
      FROM app.avis_ligne l
      JOIN ref.type_taxe t   ON t.id = l.type_taxe_id
      JOIN app.avis_imposition a ON a.id = l.avis_id
     WHERE t.code = 'patente' AND a.statut <> 'brouillon';

    RAISE NOTICE 'Patente retirée : % ligne(s) supprimée(s) sur % avis au brouillon.',
                 v_lignes, v_avis;

    IF v_emis > 0 THEN
        RAISE WARNING
          '% avis DÉJÀ ÉMIS comportent une ligne de patente (% FCFA au total). '
          'Ils ne sont pas modifiés : la régularisation (dégrèvement ou annulation) '
          'relève d''une décision de la mairie. Liste : SELECT * FROM app.v_avis_patente_a_regulariser;',
          v_emis, v_montant;
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 6. La liste des avis à régulariser, pour que la mairie puisse décider
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_avis_patente_a_regulariser AS
SELECT a.commune_id,
       a.id            AS avis_id,
       a.numero,
       a.statut,
       a.date_emission,
       a.montant_total AS montant_avis,
       l.montant       AS montant_patente,
       a.montant_paye,
       c.code          AS commerce_code,
       c.enseigne
  FROM app.avis_ligne l
  JOIN ref.type_taxe t        ON t.id = l.type_taxe_id
  JOIN app.avis_imposition a  ON a.id = l.avis_id
  JOIN app.commerce c         ON c.id = a.commerce_id
 WHERE t.code = 'patente' AND a.statut <> 'brouillon'
 ORDER BY a.date_emission DESC NULLS LAST, a.numero;

COMMENT ON VIEW app.v_avis_patente_a_regulariser IS
'Avis notifiés comportant une ligne de patente, impôt sorti du périmètre communal (CEL/DGID). À arbitrer par la mairie : dégrèvement, annulation, ou maintien si l''avis est antérieur au basculement.';
