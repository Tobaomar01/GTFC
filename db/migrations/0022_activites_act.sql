-- ===========================================================================
--  0022 — Référentiel d'activités ACT (axe 3 du document redevables)
--
--  Remplace les 21 catégories provisoires du jeu initial par les 25 codes du
--  référentiel, repris des tableaux 20 et 22 du PDC 2021-2025.
--
--  Deux principes :
--
--   1. AUCUN COMMERCE N'EST ORPHELIN. Chaque catégorie provisoire est
--      rattachée à son code ACT avant d'être archivée, et les commerces sont
--      repointés dans la même transaction. Une catégorie sans équivalent
--      (pharmacie, papeterie) est CONSERVÉE et rattachée à ACT-99, plutôt que
--      de perdre l'information au profit d'un « autre » indifférencié.
--
--   2. L'EFFECTIF PDC EST CONSERVÉ. Il donne le dénominateur du taux de
--      couverture : 1 285 tailleurs attendus, combien recensés ? Sans ce
--      repère, personne ne sait si le recensement est terminé.
--
--  Les codes ACT-20 à ACT-24 décomposent le poste « ventes diverses » du PDC
--  (813 commerces, dont 589 à Colobane), inexploitable en l'état. Leur
--  effectif est donc inconnu : il sortira du recensement terrain.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app.installer_activites_act(p_commune uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO ref.categorie_commerce
        (commune_id, code, code_reference, libelle, secteur, effectif_pdc,
         todp_probable, enseigne_probable, sur_marche, ordre_affichage, a_remplacer)
    VALUES
        -- --- Commerce ------------------------------------------------------
        (p_commune, 'ACT-01', 'ACT-01', 'Alimentation',              'Commerce',  821, true,  true,  true,   1, false),
        (p_commune, 'ACT-02', 'ACT-02', 'Restauration',              'Commerce',  495, true,  true,  true,   2, false),
        (p_commune, 'ACT-03', 'ACT-03', 'Dibiterie',                 'Commerce',   21, true,  true,  false,  3, false),
        (p_commune, 'ACT-04', 'ACT-04', 'Grande surface / supérette','Commerce',    6, false, true,  false,  4, false),
        (p_commune, 'ACT-05', 'ACT-05', 'Station d''essence',        'Commerce',    9, false, true,  false,  5, false),
        -- --- Artisanat -----------------------------------------------------
        (p_commune, 'ACT-06', 'ACT-06', 'Bijouterie',                'Artisanat',  28, false, true,  false,  6, false),
        (p_commune, 'ACT-07', 'ACT-07', 'Cordonnerie',               'Artisanat',  68, true,  false, true,   7, false),
        (p_commune, 'ACT-08', 'ACT-08', 'Forgerie',                  'Artisanat',  23, true,  false, false,  8, false),
        (p_commune, 'ACT-09', 'ACT-09', 'Garage mécanique',          'Artisanat',  47, true,  true,  false,  9, false),
        (p_commune, 'ACT-10', 'ACT-10', 'Menuiserie bois',           'Artisanat',  82, true,  true,  false, 10, false),
        (p_commune, 'ACT-11', 'ACT-11', 'Vulcanisation',             'Artisanat',  11, true,  false, false, 11, false),
        (p_commune, 'ACT-12', 'ACT-12', 'Tailleur / couture',        'Artisanat', 1285, false, true,  true,  12, false),
        (p_commune, 'ACT-13', 'ACT-13', 'Salon de coiffure',         'Artisanat', 152, false, true,  false, 13, false),
        (p_commune, 'ACT-14', 'ACT-14', 'Boulangerie / pâtisserie',  'Artisanat',   9, false, true,  false, 14, false),
        (p_commune, 'ACT-15', 'ACT-15', 'Quincaillerie',             'Artisanat', 103, true,  true,  true,  15, false),
        (p_commune, 'ACT-16', 'ACT-16', 'Mercerie',                  'Artisanat',  42, false, true,  true,  16, false),
        (p_commune, 'ACT-17', 'ACT-17', 'Pressing',                  'Artisanat',  59, false, true,  false, 17, false),
        (p_commune, 'ACT-18', 'ACT-18', 'Cosmétiques',               'Artisanat',  96, false, true,  true,  18, false),
        (p_commune, 'ACT-19', 'ACT-19', 'Dépôt',                     'Artisanat', 139, true,  false, false, 19, false),
        -- --- Décomposition du poste « ventes diverses » du PDC --------------
        -- effectif_pdc laissé NULL : le poste global (813) ne se répartit pas
        -- a priori. Y mettre un chiffre inventé fausserait le taux de couverture.
        (p_commune, 'ACT-20', 'ACT-20', 'Vêtements / friperie',      'Commerce',  NULL, true,  true,  true,  20, false),
        (p_commune, 'ACT-21', 'ACT-21', 'Chaussures / maroquinerie', 'Commerce',  NULL, true,  true,  true,  21, false),
        (p_commune, 'ACT-22', 'ACT-22', 'Électronique / téléphonie', 'Commerce',  NULL, false, true,  true,  22, false),
        (p_commune, 'ACT-23', 'ACT-23', 'Articles ménagers',         'Commerce',  NULL, true,  true,  true,  23, false),
        (p_commune, 'ACT-24', 'ACT-24', 'Télécentre / multiservices','Commerce',  NULL, false, true,  false, 24, false),
        (p_commune, 'ACT-99', 'ACT-99', 'Autre / non classé',        NULL,        NULL, false, false, false, 99, false)
    ON CONFLICT (commune_id, code) DO UPDATE SET
        code_reference = EXCLUDED.code_reference,
        secteur        = EXCLUDED.secteur,
        effectif_pdc   = EXCLUDED.effectif_pdc,
        modifie_le     = now();

    -- --- Taxes appliquées d'office ----------------------------------------
    -- TEOM pour tous ; TODP, enseigne et droit de place selon la catégorie.
    -- La patente est volontairement absente : voir migration 0023.
    INSERT INTO ref.categorie_taxe (categorie_id, type_taxe_id, obligatoire)
    SELECT c.id, t.id, true
      FROM ref.categorie_commerce c
      CROSS JOIN ref.type_taxe t
     WHERE c.commune_id = p_commune AND c.code_reference IS NOT NULL
       AND t.code = 'teom'
    ON CONFLICT DO NOTHING;

    INSERT INTO ref.categorie_taxe (categorie_id, type_taxe_id, obligatoire)
    SELECT c.id, t.id, false
      FROM ref.categorie_commerce c
      JOIN ref.type_taxe t ON t.code = 'todp'
     WHERE c.commune_id = p_commune AND c.code_reference IS NOT NULL AND c.todp_probable
    ON CONFLICT DO NOTHING;

    INSERT INTO ref.categorie_taxe (categorie_id, type_taxe_id, obligatoire)
    SELECT c.id, t.id, false
      FROM ref.categorie_commerce c
      JOIN ref.type_taxe t ON t.code = 'enseigne'
     WHERE c.commune_id = p_commune AND c.code_reference IS NOT NULL AND c.enseigne_probable
    ON CONFLICT DO NOTHING;

    INSERT INTO ref.categorie_taxe (categorie_id, type_taxe_id, obligatoire)
    SELECT c.id, t.id, false
      FROM ref.categorie_commerce c
      JOIN ref.type_taxe t ON t.code = 'droit_place'
     WHERE c.commune_id = p_commune AND c.code_reference IS NOT NULL AND c.sur_marche
    ON CONFLICT DO NOTHING;
END;
$$;

COMMENT ON FUNCTION app.installer_activites_act(uuid) IS
'Installe les 25 activités du référentiel ACT et leurs taxes d''office. Idempotente.';

-- ---------------------------------------------------------------------------
-- Installation puis reprise des catégories provisoires
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    c            uuid;
    v_ancienne   record;
    v_cible      uuid;
    v_deplaces   integer;
    v_total      integer := 0;

    -- Correspondance ancien code local → code du référentiel.
    -- « Fruits », « boucherie » et « poissonnerie » rejoignent ACT-01 :
    -- le PDC ne les distingue pas, et inventer une distinction rendrait les
    -- effectifs incomparables avec la source.
    correspondance constant text[][] := ARRAY[
        ['ALIM',   'ACT-01'], ['FRUITS', 'ACT-01'], ['BOUCH', 'ACT-01'],
        ['POISS',  'ACT-01'], ['RESTO',  'ACT-02'], ['CAFE',  'ACT-02'],
        ['BOUL',   'ACT-14'], ['TAIL',   'ACT-12'], ['COIFF', 'ACT-13'],
        ['QUINC',  'ACT-15'], ['MENUIS', 'ACT-10'], ['MECA',  'ACT-09'],
        ['ELEC',   'ACT-22'], ['TELEC',  'ACT-24'], ['HABIL', 'ACT-20'],
        ['COSMET', 'ACT-18'], ['GAZ',    'ACT-19'], ['ARTIS', 'ACT-06'],
        ['AUTRE',  'ACT-99']
    ];
BEGIN
    FOR c IN SELECT id FROM app.commune LOOP
        PERFORM app.installer_activites_act(c);

        -- --- Repointage des commerces ------------------------------------
        FOR v_ancienne IN
            SELECT correspondance[i][1] AS ancien, correspondance[i][2] AS nouveau
              FROM generate_subscripts(correspondance, 1) AS i
        LOOP
            SELECT id INTO v_cible
              FROM ref.categorie_commerce
             WHERE commune_id = c AND code = v_ancienne.nouveau;
            IF v_cible IS NULL THEN CONTINUE; END IF;

            UPDATE app.commerce SET categorie_id = v_cible
             WHERE commune_id = c
               AND categorie_id IN (SELECT id FROM ref.categorie_commerce
                                     WHERE commune_id = c AND code = v_ancienne.ancien);
            GET DIAGNOSTICS v_deplaces = ROW_COUNT;
            v_total := v_total + v_deplaces;

            -- Les TRANCHES DE BARÈME suivent le même chemin.
            --
            -- Sans cela, un commerce repointé vers ACT-01 chercherait son
            -- tarif dans un barème dont toutes les tranches pointent encore
            -- vers « ALIM », archivée. Le calcul échouerait avec « aucun
            -- tarif défini pour la catégorie », redevable par redevable, et
            -- la mairie verrait « 0 avis, 5 443 erreurs » le 1er du mois.
            UPDATE app.bareme_tranche t SET categorie_id = v_cible
             WHERE t.categorie_id IN (SELECT id FROM ref.categorie_commerce
                                       WHERE commune_id = c AND code = v_ancienne.ancien);

            -- L'ancienne catégorie est archivée, jamais supprimée : des avis
            -- déjà émis peuvent la mentionner dans leur détail de calcul.
            UPDATE ref.categorie_commerce
               SET actif = false, archive_le = now(), a_remplacer = false,
                   description = coalesce(description || ' / ', '')
                                 || 'Reprise vers ' || v_ancienne.nouveau
                                 || ' (référentiel redevables, juin 2026).'
             WHERE commune_id = c AND code = v_ancienne.ancien AND archive_le IS NULL;
        END LOOP;

        -- --- Tranches devenues concurrentes --------------------------------
        --
        -- Quatre anciennes catégories rejoignent ACT-01 (alimentation, fruits
        -- et légumes, boucherie, poissonnerie). Leurs quatre tranches
        -- pointent désormais vers la même catégorie dans le même barème :
        -- le calcul en retiendrait une au hasard, et deux commerces
        -- identiques pourraient être facturés différemment.
        --
        -- Le MONTANT LE PLUS BAS est retenu. Sur-facturer un commerçant à
        -- cause d'une reprise technique est une faute ; sous-facturer se
        -- corrige à la prochaine délibération. La tranche survivante est
        -- marquée à remplacer : ce montant n'est plus celui qui a été
        -- délibéré, il ne doit pas passer pour officiel.
        WITH doublons AS (
            SELECT t.id,
                   row_number() OVER (PARTITION BY t.bareme_id, t.categorie_id
                                      ORDER BY t.montant, t.id) AS rang,
                   count(*)    OVER (PARTITION BY t.bareme_id, t.categorie_id) AS nb
              FROM app.bareme_tranche t
              JOIN app.bareme_taxe b ON b.id = t.bareme_id
             WHERE b.commune_id = c AND t.categorie_id IS NOT NULL
        )
        UPDATE app.bareme_tranche t
           SET a_remplacer = true,
               libelle     = coalesce(t.libelle, 'tranche') || ' (reprise ACT — à confirmer)'
          FROM doublons d
         WHERE d.id = t.id AND d.rang = 1 AND d.nb > 1;

        WITH doublons AS (
            SELECT t.id,
                   row_number() OVER (PARTITION BY t.bareme_id, t.categorie_id
                                      ORDER BY t.montant, t.id) AS rang
              FROM app.bareme_tranche t
              JOIN app.bareme_taxe b ON b.id = t.bareme_id
             WHERE b.commune_id = c AND t.categorie_id IS NOT NULL
        )
        DELETE FROM app.bareme_tranche t
         USING doublons d
         WHERE d.id = t.id AND d.rang > 1;

        -- --- Catégories sans équivalent au référentiel ---------------------
        -- Pharmacie et papeterie n'existent pas dans les tableaux du PDC.
        -- Les fondre dans « autre » perdrait une information exacte : elles
        -- sont conservées comme précisions locales de ACT-99.
        UPDATE ref.categorie_commerce
           SET libelle        = 'Pharmacie',
               code_reference = 'ACT-99',
               secteur        = 'Commerce',
               a_remplacer    = false,
               modifie_le     = now()
         WHERE commune_id = c AND code = 'PHARM' AND archive_le IS NULL;

        UPDATE ref.categorie_commerce
           SET libelle        = 'Papeterie / librairie',
               code_reference = 'ACT-99',
               secteur        = 'Commerce',
               a_remplacer    = false,
               modifie_le     = now()
         WHERE commune_id = c AND code = 'PAPET' AND archive_le IS NULL;
    END LOOP;

    RAISE NOTICE 'Référentiel ACT installé — % commerce(s) repointé(s).', v_total;
END
$$;

-- ---------------------------------------------------------------------------
-- Garde-fou : aucun commerce ne doit pointer vers une catégorie archivée
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_orphelins integer;
BEGIN
    SELECT count(*) INTO v_orphelins
      FROM app.commerce co
      JOIN ref.categorie_commerce ca ON ca.id = co.categorie_id
     WHERE co.archive_le IS NULL AND ca.archive_le IS NOT NULL;

    IF v_orphelins > 0 THEN
        RAISE EXCEPTION
          '% commerce(s) rattaché(s) à une catégorie archivée. Reprise incomplète, migration annulée.',
          v_orphelins;
    END IF;
END
$$;
