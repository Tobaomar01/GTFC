-- ===========================================================================
--  0032 — La génération mensuelle produit une facture par REDEVABLE
--
--  CE QUI ÉTAIT CASSÉ
--
--  app.generer_avis_periode() insérait un avis par commerce, sans renseigner
--  redevable_id — devenu obligatoire en 0027. La première génération
--  mensuelle après migration aurait échoué sur les 5 443 commerces, silence
--  compris : la fonction rattrape ses erreurs commerce par commerce et les
--  journalise. La mairie aurait constaté le 1er du mois « 0 avis généré,
--  5 443 erreurs » sans autre explication.
--
--  CE QUI CHANGE
--
--  La boucle porte désormais sur les REDEVABLES. Pour chacun :
--   · une ligne par taxe et par commerce qu'il détient ;
--   · une ligne par dispositif d'affichage — huit panneaux, huit lignes,
--     chacune avec sa surface ;
--   · les chantiers sont ignorés tant qu'ils ne sont pas facturables.
--
--  Le report d'arriérés se calcule sur le redevable, plus sur le commerce :
--  c'est lui qui doit, et il ne doit qu'une fois.
--
--  Un redevable en erreur est journalisé et n'empêche pas les autres d'être
--  facturés — le comportement d'origine, conservé.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Calcul de la taxe d'un dispositif d'affichage
--
--  Séparée de app.calculer_taxe() qui raisonne sur un commerce : l'assiette
--  ici est la surface du support, multipliée par le nombre de faces. Un
--  panneau recto-verso expose deux fois sa surface.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.calculer_taxe_affichage(
    p_dispositif_id uuid,
    p_date          date DEFAULT current_date
)
RETURNS TABLE (
    montant          numeric,
    bareme_id        uuid,
    libelle          text,
    mode_calcul      app.mode_calcul_taxe,
    base_calcul      numeric,
    unite            text,
    montant_unitaire numeric,
    detail           jsonb
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_d       app.dispositif_affichage;
    v_type    ref.type_affichage;
    v_bareme  app.bareme_taxe;
    v_taxe    uuid;
    v_base    numeric;
    v_brut    numeric;
BEGIN
    SELECT * INTO v_d FROM app.dispositif_affichage WHERE id = p_dispositif_id;
    IF NOT FOUND OR v_d.archive_le IS NOT NULL OR NOT v_d.actif THEN
        RETURN;
    END IF;

    SELECT * INTO v_type FROM ref.type_affichage WHERE id = v_d.type_affichage_id;

    -- Un dispositif déposé avant le début de la période n'est plus dû.
    IF v_d.date_depose IS NOT NULL AND v_d.date_depose <= p_date THEN
        RETURN;
    END IF;
    -- Ni un dispositif posé après.
    IF v_d.date_apposition IS NOT NULL AND v_d.date_apposition > p_date THEN
        RETURN;
    END IF;

    SELECT id INTO v_taxe FROM ref.type_taxe WHERE code = 'enseigne';
    v_bareme := app.bareme_applicable(v_d.commune_id, v_taxe, p_date);

    IF v_bareme.id IS NULL THEN
        RAISE EXCEPTION
          'Aucun barème de taxe publicitaire en vigueur au % pour la commune %',
          p_date, v_d.commune_id
          USING HINT = 'Renseignez la grille tarifaire issue de la délibération.';
    END IF;

    v_base := v_d.surface_m2 * v_d.nb_faces;
    v_brut := v_base * coalesce(v_bareme.montant_unitaire, 0);

    IF v_bareme.montant_minimum IS NOT NULL THEN
        v_brut := GREATEST(v_brut, v_bareme.montant_minimum);
    END IF;
    IF v_bareme.montant_maximum IS NOT NULL THEN
        v_brut := LEAST(v_brut, v_bareme.montant_maximum);
    END IF;

    RETURN QUERY SELECT
        app.arrondir_xof(v_brut),
        v_bareme.id,
        coalesce(v_type.libelle, 'Dispositif d''affichage') || ' — ' || v_d.code,
        v_bareme.mode_calcul,
        v_base,
        coalesce(v_bareme.unite, 'm2'),
        v_bareme.montant_unitaire,
        jsonb_build_object(
            'dispositif',   v_d.code,
            'type',         v_type.code,
            'surface_m2',   v_d.surface_m2,
            'nb_faces',     v_d.nb_faces,
            'base_retenue', v_base,
            'tarif_unitaire', v_bareme.montant_unitaire,
            'bareme',       v_bareme.libelle,
            'delib',        v_bareme.delib_reference,
            'provisoire',   v_bareme.a_remplacer
        );
END;
$$;

COMMENT ON FUNCTION app.calculer_taxe_affichage IS
'Taxe publicitaire d''un support : surface × nombre de faces × tarif du barème en vigueur. Retourne le détail du calcul, comme app.calculer_taxe().';

-- ---------------------------------------------------------------------------
-- Génération des factures consolidées
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generer_avis_periode(
    p_periode_id uuid,
    p_cree_par   uuid DEFAULT NULL
)
RETURNS TABLE (
    nb_avis        integer,
    nb_lignes      integer,
    montant_total  numeric,
    nb_erreurs     integer
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_periode   app.periode_fiscale;
    v_param     app.commune_parametre;
    v_redevable record;
    v_commerce  record;
    v_dispo     record;
    v_taxe      record;
    v_calc      record;
    v_exo       app.exoneration;
    v_avis_id   uuid;
    v_numero    text;
    v_seq       integer;
    v_total     numeric;
    v_report    numeric;
    v_montant_ligne numeric;
    v_exo_montant   numeric;
    v_nb_avis   integer := 0;
    v_nb_lignes integer := 0;
    v_somme     numeric := 0;
    v_erreurs   integer := 0;
    v_ordre     smallint;
    v_taxe_ens  uuid;
BEGIN
    SELECT * INTO v_periode FROM app.periode_fiscale WHERE id = p_periode_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Période fiscale % introuvable', p_periode_id;
    END IF;
    IF v_periode.close THEN
        RAISE EXCEPTION 'La période % est close : aucun avis ne peut plus y être ajouté', v_periode.code;
    END IF;

    SELECT * INTO v_param FROM app.commune_parametre WHERE commune_id = v_periode.commune_id;
    SELECT id INTO v_taxe_ens FROM ref.type_taxe WHERE code = 'enseigne';

    SELECT coalesce(max(substring(a.numero from '[0-9]+$')::integer), 0)
      INTO v_seq
      FROM app.avis_imposition a
     WHERE a.periode_id = p_periode_id;

    FOR v_redevable IN
        SELECT r.*
        FROM app.redevable r
        WHERE r.commune_id = v_periode.commune_id
          AND r.archive_le IS NULL
          -- Un redevable sans aucun objet actif n'a rien à payer : le
          -- facturer produirait un avis à zéro et un SMS inutile.
          AND (EXISTS (SELECT 1 FROM app.commerce c
                        WHERE c.redevable_id = r.id AND c.archive_le IS NULL
                          AND c.statut IN ('actif', 'ferme_temporaire'))
            OR EXISTS (SELECT 1 FROM app.dispositif_affichage d
                        WHERE d.redevable_id = r.id AND d.archive_le IS NULL AND d.actif))
          AND NOT EXISTS (
              SELECT 1 FROM app.avis_imposition a
              WHERE a.redevable_id = r.id AND a.periode_id = p_periode_id
                AND a.annule_le IS NULL
          )
        ORDER BY r.code
    LOOP
        BEGIN
            v_total := 0;
            v_ordre := 0;
            v_seq   := v_seq + 1;
            v_numero := format('%s-%s-%s',
                               coalesce(v_param.prefixe_code_commerce, 'AVIS'),
                               v_periode.code,
                               lpad(v_seq::text, 6, '0'));

            -- Arriérés du REDEVABLE, tous objets confondus.
            SELECT coalesce(sum(a.montant_restant), 0)
              INTO v_report
              FROM app.avis_imposition a
             WHERE a.redevable_id = v_redevable.id
               AND a.annule_le IS NULL
               AND a.statut IN ('emis', 'partiellement_paye')
               AND a.date_exigibilite < v_periode.date_debut;

            INSERT INTO app.avis_imposition (
                commune_id, redevable_id, commerce_id, periode_id, numero,
                date_exigibilite, report_anterieur, statut, cree_par
            ) VALUES (
                v_periode.commune_id, v_redevable.id,
                -- commerce_id reste renseigné quand le redevable n'en a
                -- qu'un : les écrans et exports existants continuent de
                -- fonctionner sans réécriture.
                (SELECT c.id FROM app.commerce c
                  WHERE c.redevable_id = v_redevable.id AND c.archive_le IS NULL
                  LIMIT 1),
                p_periode_id, v_numero,
                v_periode.date_exigibilite, v_report, 'brouillon', p_cree_par
            ) RETURNING id INTO v_avis_id;

            -- ============ Lignes des commerces ============================
            FOR v_commerce IN
                SELECT c.id, c.code
                  FROM app.commerce c
                 WHERE c.redevable_id = v_redevable.id
                   AND c.archive_le IS NULL
                   AND c.statut IN ('actif', 'ferme_temporaire')
                 ORDER BY c.code
            LOOP
                FOR v_taxe IN
                    SELECT ct.type_taxe_id, tt.code, tt.libelle_court, tt.ordre_affichage
                    FROM app.commerce_taxe ct
                    JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
                    WHERE ct.commerce_id = v_commerce.id
                      AND ct.actif
                      AND ct.periode @> v_periode.date_debut
                      -- La taxe d'affichage est portée par les dispositifs,
                      -- plus par le commerce : la facturer ici la compterait
                      -- deux fois.
                      AND tt.id <> v_taxe_ens
                    ORDER BY tt.ordre_affichage
                LOOP
                    SELECT * INTO v_calc
                      FROM app.calculer_taxe(v_commerce.id, v_taxe.type_taxe_id, v_periode.date_debut);

                    CONTINUE WHEN v_calc.montant IS NULL;

                    v_exo := app.exoneration_applicable(v_commerce.id, v_taxe.type_taxe_id,
                                                        v_periode.date_debut);
                    v_exo_montant   := 0;
                    v_montant_ligne := v_calc.montant;

                    IF v_exo.id IS NOT NULL THEN
                        v_exo_montant   := app.arrondir_xof(v_calc.montant * v_exo.taux_pct / 100);
                        v_montant_ligne := v_calc.montant - v_exo_montant;
                    END IF;

                    v_ordre := v_ordre + 1;
                    INSERT INTO app.avis_ligne (
                        avis_id, type_taxe_id, bareme_id, libelle, mode_calcul,
                        base_calcul, unite, montant_unitaire,
                        montant_brut, taux_exoneration_pct, montant_exonere, montant,
                        exoneration_id, detail_calcul, ordre,
                        objet_type, objet_id, objet_code
                    ) VALUES (
                        v_avis_id, v_taxe.type_taxe_id, v_calc.bareme_id,
                        coalesce(v_taxe.libelle_court, v_calc.libelle), v_calc.mode_calcul,
                        v_calc.base_calcul, v_calc.unite, v_calc.montant_unitaire,
                        v_calc.montant, coalesce(v_exo.taux_pct, 0), v_exo_montant,
                        v_montant_ligne, v_exo.id, v_calc.detail, v_ordre,
                        'commerce', v_commerce.id, v_commerce.code
                    );

                    v_total := v_total + v_montant_ligne;
                    v_nb_lignes := v_nb_lignes + 1;
                END LOOP;
            END LOOP;

            -- ============ Lignes des dispositifs d'affichage ===============
            FOR v_dispo IN
                SELECT d.id, d.code
                  FROM app.dispositif_affichage d
                  JOIN ref.type_affichage ta ON ta.id = d.type_affichage_id
                 WHERE d.redevable_id = v_redevable.id
                   AND d.archive_le IS NULL AND d.actif
                   AND ta.recensable
                 ORDER BY d.code
            LOOP
                SELECT * INTO v_calc
                  FROM app.calculer_taxe_affichage(v_dispo.id, v_periode.date_debut);

                CONTINUE WHEN v_calc.montant IS NULL;

                v_ordre := v_ordre + 1;
                INSERT INTO app.avis_ligne (
                    avis_id, type_taxe_id, bareme_id, libelle, mode_calcul,
                    base_calcul, unite, montant_unitaire,
                    montant_brut, montant, detail_calcul, ordre,
                    objet_type, objet_id, objet_code
                ) VALUES (
                    v_avis_id, v_taxe_ens, v_calc.bareme_id, v_calc.libelle,
                    v_calc.mode_calcul, v_calc.base_calcul, v_calc.unite,
                    v_calc.montant_unitaire, v_calc.montant, v_calc.montant,
                    v_calc.detail, v_ordre,
                    'affichage', v_dispo.id, v_dispo.code
                );

                v_total := v_total + v_calc.montant;
                v_nb_lignes := v_nb_lignes + 1;
            END LOOP;

            -- Les chantiers ne sont pas facturés pendant le pilote : aucune
            -- ligne n'est produite tant que chantier.facturable est faux.

            UPDATE app.avis_imposition
               SET montant_taxes = v_total,
                   montant_total = v_total + v_report,
                   statut = (CASE WHEN v_total + v_report = 0 THEN 'paye'
                                  ELSE 'brouillon' END)::app.statut_avis
             WHERE id = v_avis_id;

            v_nb_avis := v_nb_avis + 1;
            v_somme   := v_somme + v_total + v_report;

        EXCEPTION WHEN OTHERS THEN
            -- Un redevable mal configuré ne doit pas faire échouer les autres.
            v_erreurs := v_erreurs + 1;
            INSERT INTO audit.journal (commune_id, action, entite, entite_id,
                                       entite_libelle, motif, commentaire)
            VALUES (v_periode.commune_id, 'creation', 'avis_imposition', v_redevable.id,
                    v_redevable.code, 'echec_generation_avis', SQLERRM);
        END;
    END LOOP;

    UPDATE app.periode_fiscale
       SET avis_generes    = true,
           avis_generes_le = now(),
           nb_avis         = v_nb_avis,
           montant_attendu = v_somme
     WHERE id = p_periode_id;

    RETURN QUERY SELECT v_nb_avis, v_nb_lignes, v_somme, v_erreurs;
END;
$$;

COMMENT ON FUNCTION app.generer_avis_periode IS
'Génère les factures mensuelles CONSOLIDÉES : une par redevable, avec une ligne par taxe et par objet taxable. Idempotente et tolérante — un redevable en erreur est journalisé, les autres sont facturés.';
