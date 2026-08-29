-- 0047 — Prorata temporis sur la période annuelle
--
-- Défaut révélé par l'exécution, invisible à l'analyse syntaxique.
--
-- La sélection des taxes testait `ct.periode @> v_periode.date_debut`. Sur
-- une période annuelle commençant le 1er janvier, un commerce rattaché à ses
-- taxes en cours d'année n'était retenu par aucune ligne : 60 avis à zéro
-- franc sur le jeu de démonstration.
--
-- Ce n'était pas un artefact des données de test. Un commerce recensé en
-- juin n'aurait jamais été facturé.
--
-- Deux corrections :
--   1. chevauchement au lieu d'inclusion du premier jour ;
--   2. prorata temporis — un commerce recensé en cours d'année ne paie que
--      les douzièmes postérieurs à son rattachement (FR-009b).

CREATE OR REPLACE FUNCTION app.generer_avis_periode(p_periode_id uuid, p_cree_par uuid DEFAULT NULL::uuid)
 RETURNS TABLE(nb_avis integer, nb_lignes integer, montant_total numeric, nb_erreurs integer)
 LANGUAGE plpgsql
AS $function$
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
    -- Prorata temporis : un commerce recensé en cours d'année ne doit pas
    -- payer les mois antérieurs à son rattachement (FR-009b).
    v_debut_du  date;
    v_mois_dus  integer;
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
                    SELECT ct.type_taxe_id, ct.date_debut, tt.code, tt.libelle_court, tt.ordre_affichage,
                           coalesce(cot.periodicite, tt.periodicite_defaut) AS periodicite_taxe
                    FROM app.commerce_taxe ct
                    JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
                    LEFT JOIN ref.commune_type_taxe cot
                           ON cot.type_taxe_id = ct.type_taxe_id
                          AND cot.commune_id   = v_periode.commune_id
                    WHERE ct.commerce_id = v_commerce.id
                      AND ct.actif
                      -- Chevauchement, non inclusion du 1er jour : sur une
                      -- période annuelle, un rattachement créé en cours
                      -- d'année doit être retenu (FR-021).
                      AND ct.periode && daterange(v_periode.date_debut,
                                                  v_periode.date_fin, '[]')
                      -- La taxe d'affichage est portée par les dispositifs,
                      -- plus par le commerce : la facturer ici la compterait
                      -- deux fois.
                      AND tt.id <> v_taxe_ens
                    ORDER BY tt.ordre_affichage
                LOOP
                    v_debut_du := greatest(v_periode.date_debut, v_taxe.date_debut);
                    v_mois_dus := least(12, greatest(1,
                        (extract(year  from v_periode.date_fin)::int - extract(year  from v_debut_du)::int) * 12
                      + (extract(month from v_periode.date_fin)::int - extract(month from v_debut_du)::int) + 1));

                    SELECT * INTO v_calc
                      FROM app.calculer_taxe(v_commerce.id, v_taxe.type_taxe_id, v_debut_du);

                    -- Mise à l'échelle annuelle.
                    --
                    -- calculer_taxe renvoie un montant à la périodicité
                    -- CONFIGURÉE pour la taxe. Les cinq taxes du pilote sont
                    -- appelées mensuellement : sur une période annuelle, il
                    -- faut donc MULTIPLIER par le nombre de mois dus, non
                    -- diviser. L'erreur inverse sous-facturerait d'un
                    -- facteur douze.
                    IF v_calc.montant IS NOT NULL AND v_periode.periodicite = 'annuelle' THEN
                        IF v_taxe.periodicite_taxe = 'mensuelle' THEN
                            v_calc.montant := app.arrondir_xof(v_calc.montant * v_mois_dus);
                        ELSIF v_mois_dus < 12 THEN
                            v_calc.montant := app.arrondir_xof(v_calc.montant * v_mois_dus / 12.0);
                        END IF;
                    END IF;

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
$function$


