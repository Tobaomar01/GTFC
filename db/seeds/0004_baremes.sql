-- ===========================================================================
--  SEED 0004 — Barèmes des 5 taxes
--
--  ##########################################################################
--  ###  TOUS LES MONTANTS DE CE FICHIER SONT INVENTÉS                     ###
--  ###                                                                    ###
--  ###  Ils sont là pour que la chaîne complète — calcul, avis, paiement  ###
--  ###  Wave, quittance — soit testable de bout en bout dès aujourd'hui.  ###
--  ###                                                                    ###
--  ###  Ils DOIVENT être remplacés par les tarifs votés par le conseil    ###
--  ###  municipal AVANT toute émission réelle d'avis d'imposition :       ###
--  ###  un montant erroné sur une quittance engage la commune.            ###
--  ##########################################################################
--
--  Toutes les lignes portent a_remplacer = true.
--  Contrôle :  SELECT * FROM app.v_donnees_a_remplacer WHERE entite LIKE 'bareme%';
--
--  Comment remplacer proprement, sans casser l'historique :
--    1. clore le barème provisoire :
--         UPDATE app.bareme_taxe SET date_fin = '2026-09-01' WHERE a_remplacer;
--    2. insérer le barème officiel avec date_effet = '2026-09-01'
--       et a_remplacer = false.
--    La contrainte bareme_pas_de_chevauchement empêche toute incohérence,
--    et les avis déjà émis conservent le tarif qui leur a été appliqué.
--
--  Note technique : ce fichier n'utilise pas ON CONFLICT sur app.bareme_taxe.
--  L'unicité y est assurée par une contrainte d'EXCLUSION (chevauchement de
--  périodes), que ON CONFLICT ne sait pas intercepter. L'idempotence passe
--  donc par un test d'existence explicite.
-- ===========================================================================

DO $$
DECLARE
    v_commune_id uuid;
    v_bareme_id  uuid;
    v_type_id    uuid;
    v_date_effet constant date := date_trunc('year', current_date)::date;
BEGIN

SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
IF v_commune_id IS NULL THEN
    RAISE EXCEPTION 'Commune GTFC absente — lancez d''abord les seeds 0002 et 0003.';
END IF;

-- ===========================================================================
-- 1. PATENTE — SUPPRIMÉE
--
--    La patente a été remplacée en 2018 par la contribution économique
--    locale (CEL-VL et CEL-VA), établie et recouvrée par la Direction
--    Générale des Impôts et des Domaines.
--
--    La commune en perçoit le produit mais n'en est pas le collecteur :
--    aucun agent municipal ne la réclame. Créer ici un barème provisoire
--    aurait suffi à la faire réapparaître sur les factures d'une
--    installation neuve, alors que la migration 0023 la retire partout
--    ailleurs — et le défaut ne se serait vu que sur une quittance.
--
--    Voir : db/migrations/0023_patente_remplacee_par_cel.sql
-- ===========================================================================
-- ===========================================================================
-- 2. TODP — occupation du domaine public, au m² par mois
--    C'est LE tarif le plus structurant du dispositif : c'est lui qui décide
--    du montant facturé à chaque commerçant qui déborde sur le trottoir.
-- ===========================================================================
SELECT id INTO v_type_id FROM ref.type_taxe WHERE code = 'todp';
v_bareme_id := NULL;
SELECT b.id INTO v_bareme_id FROM app.bareme_taxe b
 WHERE b.commune_id = v_commune_id AND b.type_taxe_id = v_type_id
   AND b.periode @> v_date_effet;

IF v_bareme_id IS NULL THEN
    INSERT INTO app.bareme_taxe (
        commune_id, type_taxe_id, libelle, mode_calcul, periodicite,
        montant_unitaire, unite, montant_minimum, montant_maximum,
        date_effet, delib_reference, a_remplacer
    ) VALUES (
        v_commune_id, v_type_id,
        'À_REMPLACER — TODP, tarif au m² par mois',
        'par_m2', 'mensuelle',
        500,           -- 500 XOF/m²/mois — VALEUR INVENTÉE
        'm²',
        1000,          -- plancher inventé
        100000,        -- plafond inventé
        v_date_effet, 'À_REMPLACER — n° de délibération', true
    ) RETURNING id INTO v_bareme_id;
END IF;

DELETE FROM app.bareme_tranche WHERE bareme_id = v_bareme_id AND a_remplacer;

-- Modulation par zone : une artère passante coûte plus cher qu'une ruelle.
-- Structure fournie à titre d'exemple — à confirmer avec la mairie.
INSERT INTO app.bareme_tranche (bareme_id, zone_id, libelle, montant, montant_unitaire, ordre, a_remplacer)
SELECT v_bareme_id, z.id,
       format('À_REMPLACER — tarif m² %s', z.code),
       0,
       CASE z.code WHEN 'Z1' THEN 600 WHEN 'Z2' THEN 500 ELSE 400 END,
       z.ordre, true
FROM app.zone z WHERE z.commune_id = v_commune_id;

-- ===========================================================================
-- 3. TEOM — enlèvement des ordures, forfait mensuel par catégorie
-- ===========================================================================
SELECT id INTO v_type_id FROM ref.type_taxe WHERE code = 'teom';
v_bareme_id := NULL;
SELECT b.id INTO v_bareme_id FROM app.bareme_taxe b
 WHERE b.commune_id = v_commune_id AND b.type_taxe_id = v_type_id
   AND b.periode @> v_date_effet;

IF v_bareme_id IS NULL THEN
    INSERT INTO app.bareme_taxe (
        commune_id, type_taxe_id, libelle, mode_calcul, periodicite,
        date_effet, delib_reference, a_remplacer
    ) VALUES (
        v_commune_id, v_type_id,
        'À_REMPLACER — TEOM, forfait mensuel par catégorie',
        'par_categorie', 'mensuelle',
        v_date_effet, 'À_REMPLACER — n° de délibération', true
    ) RETURNING id INTO v_bareme_id;
END IF;

DELETE FROM app.bareme_tranche WHERE bareme_id = v_bareme_id AND a_remplacer;

-- Les activités produisant le plus de déchets paient davantage
INSERT INTO app.bareme_tranche (bareme_id, categorie_id, libelle, montant, ordre, a_remplacer)
SELECT v_bareme_id, c.id, 'À_REMPLACER — TEOM ' || c.code,
       CASE
           -- Restauration, dibiterie, boulangerie : déchets organiques
           -- quotidiens, volume le plus élevé.
           WHEN c.code_reference IN ('ACT-02','ACT-03','ACT-14')     THEN 5000
           -- Alimentation, grande surface, garage, menuiserie, dépôt :
           -- volume important mais moins fermentescible.
           WHEN c.code_reference IN ('ACT-01','ACT-04','ACT-09','ACT-10','ACT-19')
                                                                     THEN 3000
           ELSE 2000
       END,
       c.ordre_affichage, true
FROM ref.categorie_commerce c WHERE c.commune_id = v_commune_id;

-- ===========================================================================
-- 4. DROIT DE PLACE — tarif journalier selon le type d'emplacement
-- ===========================================================================
SELECT id INTO v_type_id FROM ref.type_taxe WHERE code = 'droit_place';
v_bareme_id := NULL;
SELECT b.id INTO v_bareme_id FROM app.bareme_taxe b
 WHERE b.commune_id = v_commune_id AND b.type_taxe_id = v_type_id
   AND b.periode @> v_date_effet;

IF v_bareme_id IS NULL THEN
    INSERT INTO app.bareme_taxe (
        commune_id, type_taxe_id, libelle, mode_calcul, periodicite,
        montant_unitaire, unite, date_effet, delib_reference, a_remplacer
    ) VALUES (
        v_commune_id, v_type_id,
        'À_REMPLACER — Droit de place, tarif journalier',
        'par_jour', 'mensuelle',
        200, 'jour',
        v_date_effet, 'À_REMPLACER — n° de délibération', true
    ) RETURNING id INTO v_bareme_id;
END IF;

DELETE FROM app.bareme_tranche WHERE bareme_id = v_bareme_id AND a_remplacer;

INSERT INTO app.bareme_tranche (bareme_id, type_emplacement_id, libelle, montant, montant_unitaire, ordre, a_remplacer)
SELECT v_bareme_id, e.id, 'À_REMPLACER — ' || e.code, 0,
       CASE e.code
           -- Codes du référentiel : EMP-05 étal/table, EMP-04 cantine,
           -- EMP-06 hangar, EMP-07 magasin de marché.
           WHEN 'EMP-05' THEN 250
           WHEN 'EMP-04' THEN 500
           WHEN 'EMP-06' THEN 800
           WHEN 'EMP-07' THEN 1000
           ELSE 200
       END,
       e.ordre_affichage, true
FROM ref.type_emplacement e WHERE e.commune_id = v_commune_id;

-- ===========================================================================
-- 5. TAXE SUR LES ENSEIGNES — au m² par mois
-- ===========================================================================
SELECT id INTO v_type_id FROM ref.type_taxe WHERE code = 'enseigne';
v_bareme_id := NULL;
SELECT b.id INTO v_bareme_id FROM app.bareme_taxe b
 WHERE b.commune_id = v_commune_id AND b.type_taxe_id = v_type_id
   AND b.periode @> v_date_effet;

IF v_bareme_id IS NULL THEN
    INSERT INTO app.bareme_taxe (
        commune_id, type_taxe_id, libelle, mode_calcul, periodicite,
        montant_unitaire, unite, montant_minimum,
        date_effet, delib_reference, a_remplacer
    ) VALUES (
        v_commune_id, v_type_id,
        'À_REMPLACER — Enseignes, tarif au m² par mois',
        'par_m2', 'mensuelle',
        1000, 'm²', 1000,
        v_date_effet, 'À_REMPLACER — n° de délibération', true
    );
END IF;

RAISE NOTICE '[seed 0004] % barèmes et % tranches — TOUS PROVISOIRES',
    (SELECT count(*) FROM app.bareme_taxe    WHERE commune_id = v_commune_id),
    (SELECT count(*) FROM app.bareme_tranche t
       JOIN app.bareme_taxe b ON b.id = t.bareme_id WHERE b.commune_id = v_commune_id);

END
$$;
