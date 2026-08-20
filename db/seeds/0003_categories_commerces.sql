-- ===========================================================================
--  SEED 0003 — Activités du référentiel des redevables (axe 3)
--
--  Ce seed ne fabrique plus de catégories plausibles : il installe les
--  25 codes ACT du « Référentiel des redevables communaux » de juin 2026,
--  repris des tableaux 20 et 22 du PDC 2021-2025.
--
--  Ce ne sont donc PAS des données inventées. Les libellés viennent d'une
--  source de la commune, et les effectifs du PDC servent de dénominateur au
--  taux de couverture du recensement : 1 285 tailleurs attendus, combien
--  trouvés ?
--
--  Ce qui reste à valider par le receveur municipal :
--   · la codification elle-même, présentée comme une proposition ;
--   · la répartition réelle de ACT-20 à ACT-24, qui décomposent le poste
--     « ventes diverses » du PDC (813 commerces) et n'ont donc pas d'effectif
--     de référence ;
--   · l'existence éventuelle d'une nomenclature DGID à laquelle s'aligner.
--
--  L'installation est faite par app.installer_activites_act() et
--  app.installer_referentiel_codes(), définies dans les migrations 0021 et
--  0022. Le même code sert donc à installer une commune neuve et à mettre à
--  jour une commune existante — il ne peut pas y avoir deux vérités.
-- ===========================================================================

DO $$
DECLARE
    v_commune_id uuid;
BEGIN

SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
IF v_commune_id IS NULL THEN
    RAISE EXCEPTION 'La commune GTFC n''existe pas — lancez d''abord le seed 0002.';
END IF;

-- Emplacements EMP, dispositifs AFF, occupations CHA, motifs de contestation
PERFORM app.installer_referentiel_codes(v_commune_id);

-- Activités ACT et taxes appliquées d'office
-- (la patente n'y figure pas : voir migration 0023, elle a été remplacée par
--  la CEL, recouvrée par la DGID et non par un agent municipal)
PERFORM app.installer_activites_act(v_commune_id);

RAISE NOTICE '[seed 0003] % activités ACT, % emplacements, % dispositifs, % associations catégorie/taxe',
    (SELECT count(*) FROM ref.categorie_commerce
      WHERE commune_id = v_commune_id AND code_reference IS NOT NULL),
    (SELECT count(*) FROM ref.type_emplacement    WHERE commune_id = v_commune_id),
    (SELECT count(*) FROM ref.type_affichage      WHERE commune_id = v_commune_id),
    (SELECT count(*) FROM ref.categorie_taxe ct
      JOIN ref.categorie_commerce c ON c.id = ct.categorie_id
     WHERE c.commune_id = v_commune_id);

END
$$;
