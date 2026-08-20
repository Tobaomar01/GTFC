-- ===========================================================================
--  0012 — Fonctions et procédures métier
--
--  Le calcul des montants vit ICI, dans la base, et pas dans l'API. Trois
--  raisons : un import en masse et une saisie terrain doivent produire le
--  même montant au franc près ; le calcul reste vérifiable en SQL lors d'un
--  contrôle ; et une évolution de barème ne demande pas de redéployer l'API.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Arrondi d'une surface selon la règle de la commune
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.arrondir_surface(p_valeur numeric, p_regle text)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT CASE
        WHEN p_valeur IS NULL THEN NULL
        WHEN p_regle = 'superieur' THEN ceil(p_valeur)
        WHEN p_regle = 'inferieur' THEN floor(p_valeur)
        WHEN p_regle = 'proche'    THEN round(p_valeur, 0)
        WHEN p_regle = 'dixieme'   THEN round(p_valeur, 1)
        ELSE ceil(p_valeur)
    END;
$$;

-- ---------------------------------------------------------------------------
-- Code lisible du commerce : GTFC-Z1-00042
--
-- La séquence est prise par zone. Le verrou consultatif empêche deux agents
-- qui enregistrent au même instant d'obtenir le même numéro — situation
-- courante un jour de recensement massif.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generer_code_commerce(p_commune_id uuid, p_zone_id uuid)
RETURNS TABLE (code text, numero_sequence integer)
LANGUAGE plpgsql
AS $$
DECLARE
    v_prefixe text;
    v_zone    text;
    v_seq     integer;
BEGIN
    SELECT coalesce(p.prefixe_code_commerce, c.code)
      INTO v_prefixe
      FROM app.commune c
      LEFT JOIN app.commune_parametre p ON p.commune_id = c.id
     WHERE c.id = p_commune_id;

    IF v_prefixe IS NULL THEN
        RAISE EXCEPTION 'Commune % introuvable', p_commune_id;
    END IF;

    SELECT z.code INTO v_zone FROM app.zone z WHERE z.id = p_zone_id;
    IF v_zone IS NULL THEN
        RAISE EXCEPTION 'Zone % introuvable', p_zone_id;
    END IF;

    -- Verrou consultatif portant sur le couple (commune, zone).
    -- Libéré automatiquement à la fin de la transaction.
    PERFORM pg_advisory_xact_lock(hashtext(p_commune_id::text || p_zone_id::text));

    SELECT coalesce(max(c.numero_sequence), 0) + 1
      INTO v_seq
      FROM app.commerce c
     WHERE c.commune_id = p_commune_id AND c.zone_id = p_zone_id;

    RETURN QUERY SELECT
        format('%s-%s-%s', v_prefixe, v_zone, lpad(v_seq::text, 5, '0')),
        v_seq;
END;
$$;

COMMENT ON FUNCTION app.generer_code_commerce IS
'Numérotation séquentielle par zone, protégée par un verrou : deux agents enregistrant simultanément n''obtiennent jamais le même code.';

-- ---------------------------------------------------------------------------
-- Jeton de QR code : aléatoire, non devinable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.generer_jeton_qr()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_jeton text;
    i integer := 0;
BEGIN
    LOOP
        v_jeton := app.code_aleatoire(16);
        EXIT WHEN NOT EXISTS (SELECT 1 FROM app.qr_code q WHERE q.jeton = v_jeton);
        i := i + 1;
        IF i > 20 THEN
            RAISE EXCEPTION 'Impossible de générer un jeton QR unique après 20 tentatives';
        END IF;
    END LOOP;
    RETURN v_jeton;
END;
$$;

-- ---------------------------------------------------------------------------
-- Barème applicable à une date donnée
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.bareme_applicable(
    p_commune_id   uuid,
    p_type_taxe_id uuid,
    p_date         date DEFAULT current_date
)
RETURNS app.bareme_taxe
LANGUAGE sql STABLE
AS $$
    SELECT b.*
    FROM app.bareme_taxe b
    WHERE b.commune_id   = p_commune_id
      AND b.type_taxe_id = p_type_taxe_id
      AND b.periode @> p_date
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- CŒUR DU SYSTÈME : calcul du montant d'une taxe pour un commerce
--
-- Renvoie systématiquement le détail du calcul en JSON. Quand un commerçant
-- conteste un montant au guichet, l'agent peut lui montrer exactement quel
-- barème, quelle tranche et quel arrondi ont été appliqués.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.calculer_taxe(
    p_commerce_id  uuid,
    p_type_taxe_id uuid,
    p_date         date DEFAULT current_date
)
RETURNS TABLE (
    montant          numeric,
    montant_brut     numeric,
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
    v_com      app.commerce;
    v_param    app.commune_parametre;
    v_bareme   app.bareme_taxe;
    v_ct       app.commerce_taxe;
    v_tranche  app.bareme_tranche;
    v_base     numeric;
    v_brut     numeric := 0;
    v_montant  numeric := 0;
    v_detail   jsonb;
    v_type_code text;
BEGIN
    SELECT * INTO v_com FROM app.commerce WHERE id = p_commerce_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Commerce % introuvable', p_commerce_id;
    END IF;

    SELECT * INTO v_param FROM app.commune_parametre WHERE commune_id = v_com.commune_id;
    SELECT code INTO v_type_code FROM ref.type_taxe WHERE id = p_type_taxe_id;

    -- La taxe est-elle bien due par ce commerce à cette date ?
    SELECT * INTO v_ct
      FROM app.commerce_taxe ct
     WHERE ct.commerce_id = p_commerce_id
       AND ct.type_taxe_id = p_type_taxe_id
       AND ct.actif
       AND ct.periode @> p_date;

    IF NOT FOUND THEN
        RETURN;                              -- taxe non applicable : 0 ligne
    END IF;

    -- Montant imposé manuellement : il court-circuite tout le barème,
    -- mais le motif reste tracé.
    IF v_ct.montant_force IS NOT NULL THEN
        RETURN QUERY SELECT
            v_ct.montant_force, v_ct.montant_force, NULL::uuid,
            coalesce(v_type_code, 'taxe') || ' (montant imposé)',
            'forfait'::app.mode_calcul_taxe, NULL::numeric, NULL::text, NULL::numeric,
            jsonb_build_object(
                'methode', 'montant_force',
                'motif',   v_ct.motif_montant_force);
        RETURN;
    END IF;

    v_bareme := app.bareme_applicable(v_com.commune_id, p_type_taxe_id, p_date);
    IF v_bareme.id IS NULL THEN
        RAISE EXCEPTION 'Aucun barème en vigueur au % pour la taxe % dans la commune %',
            p_date, coalesce(v_type_code, p_type_taxe_id::text), v_com.commune_id
            USING HINT = 'Renseignez un barème avec une date d''effet couvrant cette période.';
    END IF;

    -- Base de calcul : valeur saisie par l'agent, ou repli sur la fiche commerce
    v_base := coalesce(
        v_ct.parametre_valeur,
        CASE v_type_code
            WHEN 'todp'     THEN v_com.todp_surface_m2
            WHEN 'enseigne' THEN v_com.enseigne_surface_m2
            ELSE NULL
        END
    );

    CASE v_bareme.mode_calcul

        -- ------------------------------------------------------------------
        WHEN 'forfait' THEN
            v_brut := v_bareme.montant_fixe;
            v_detail := jsonb_build_object('methode', 'forfait',
                                           'montant_fixe', v_bareme.montant_fixe);

        -- ------------------------------------------------------------------
        WHEN 'par_categorie' THEN
            SELECT * INTO v_tranche
              FROM app.bareme_tranche t
             WHERE t.bareme_id = v_bareme.id
               AND t.categorie_id = v_com.categorie_id
             ORDER BY t.ordre
             LIMIT 1;

            IF NOT FOUND THEN
                -- Repli sur la ligne « toutes catégories » si elle existe
                SELECT * INTO v_tranche
                  FROM app.bareme_tranche t
                 WHERE t.bareme_id = v_bareme.id AND t.categorie_id IS NULL
                 ORDER BY t.ordre LIMIT 1;
            END IF;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Aucun tarif défini pour la catégorie % dans le barème %',
                    v_com.categorie_id, v_bareme.libelle;
            END IF;

            v_brut := v_tranche.montant;
            v_detail := jsonb_build_object('methode', 'par_categorie',
                                           'tranche_id', v_tranche.id,
                                           'tranche_libelle', v_tranche.libelle,
                                           'montant', v_tranche.montant);

        -- ------------------------------------------------------------------
        WHEN 'par_m2' THEN
            IF v_base IS NULL OR v_base <= 0 THEN
                RETURN;      -- pas de débordement mesuré : pas de TODP due
            END IF;

            -- Plancher et plafond de surface définis par la commune
            v_base := greatest(v_base, coalesce(v_param.todp_surface_minimale_m2, 0));
            IF v_param.todp_surface_maximale_m2 IS NOT NULL THEN
                v_base := least(v_base, v_param.todp_surface_maximale_m2);
            END IF;
            v_base := app.arrondir_surface(v_base, coalesce(v_param.todp_arrondi, 'superieur'));

            -- Tarif au m² éventuellement modulé par zone
            SELECT * INTO v_tranche
              FROM app.bareme_tranche t
             WHERE t.bareme_id = v_bareme.id
               AND (t.zone_id = v_com.zone_id OR t.zone_id IS NULL)
             ORDER BY (t.zone_id IS NULL), t.ordre
             LIMIT 1;

            v_brut := v_base * coalesce(v_tranche.montant_unitaire, v_bareme.montant_unitaire);

            v_detail := jsonb_build_object(
                'methode', 'par_m2',
                'surface_mesuree', v_ct.parametre_valeur,
                'surface_minimale', v_param.todp_surface_minimale_m2,
                'regle_arrondi', v_param.todp_arrondi,
                'surface_retenue', v_base,
                'tarif_m2', coalesce(v_tranche.montant_unitaire, v_bareme.montant_unitaire),
                'zone_specifique', v_tranche.zone_id IS NOT NULL);

        -- ------------------------------------------------------------------
        WHEN 'par_tranche' THEN
            IF v_base IS NULL THEN
                RAISE EXCEPTION 'La taxe % est calculée par tranche mais aucune valeur n''a été saisie pour le commerce %',
                    coalesce(v_type_code, ''), v_com.code;
            END IF;

            SELECT * INTO v_tranche
              FROM app.bareme_tranche t
             WHERE t.bareme_id = v_bareme.id
               AND (t.borne_min IS NULL OR v_base >= t.borne_min)
               AND (t.borne_max IS NULL OR v_base <  t.borne_max)
               AND (t.categorie_id IS NULL OR t.categorie_id = v_com.categorie_id)
             ORDER BY (t.categorie_id IS NULL), t.ordre
             LIMIT 1;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Aucune tranche du barème % ne couvre la valeur %',
                    v_bareme.libelle, v_base;
            END IF;

            v_brut := v_tranche.montant;
            v_detail := jsonb_build_object('methode', 'par_tranche',
                                           'valeur', v_base,
                                           'tranche', v_tranche.libelle,
                                           'borne_min', v_tranche.borne_min,
                                           'borne_max', v_tranche.borne_max,
                                           'montant', v_tranche.montant);

        -- ------------------------------------------------------------------
        WHEN 'par_jour' THEN
            IF v_base IS NULL OR v_base <= 0 THEN
                RETURN;
            END IF;

            SELECT * INTO v_tranche
              FROM app.bareme_tranche t
             WHERE t.bareme_id = v_bareme.id
               AND (t.type_emplacement_id = v_com.type_emplacement_id OR t.type_emplacement_id IS NULL)
             ORDER BY (t.type_emplacement_id IS NULL), t.ordre
             LIMIT 1;

            v_brut := v_base * coalesce(v_tranche.montant_unitaire, v_bareme.montant_unitaire);
            v_detail := jsonb_build_object('methode', 'par_jour',
                                           'nb_jours', v_base,
                                           'tarif_jour', coalesce(v_tranche.montant_unitaire, v_bareme.montant_unitaire));
    END CASE;

    -- Plancher et plafond de montant
    v_montant := v_brut;
    IF v_bareme.montant_minimum IS NOT NULL THEN
        v_montant := greatest(v_montant, v_bareme.montant_minimum);
    END IF;
    IF v_bareme.montant_maximum IS NOT NULL THEN
        v_montant := least(v_montant, v_bareme.montant_maximum);
    END IF;
    v_montant := app.arrondir_xof(v_montant);

    v_detail := v_detail || jsonb_build_object(
        'bareme_id',      v_bareme.id,
        'bareme_libelle', v_bareme.libelle,
        'delib',          v_bareme.delib_reference,
        'date_calcul',    p_date,
        'montant_brut',   app.arrondir_xof(v_brut),
        'montant_final',  v_montant);

    RETURN QUERY SELECT
        v_montant,
        app.arrondir_xof(v_brut),
        v_bareme.id,
        v_bareme.libelle,
        v_bareme.mode_calcul,
        v_base,
        coalesce(v_bareme.unite, ''),
        v_bareme.montant_unitaire,
        v_detail;
END;
$$;

COMMENT ON FUNCTION app.calculer_taxe IS
'Calcule une taxe pour un commerce à une date donnée et renvoie le détail du calcul en JSON, opposable en cas de contestation.';

-- ---------------------------------------------------------------------------
-- Exonération applicable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.exoneration_applicable(
    p_commerce_id  uuid,
    p_type_taxe_id uuid,
    p_date         date DEFAULT current_date
)
RETURNS app.exoneration
LANGUAGE sql STABLE
AS $$
    SELECT e.*
    FROM app.exoneration e
    WHERE e.commerce_id = p_commerce_id
      AND (e.type_taxe_id = p_type_taxe_id OR e.type_taxe_id IS NULL)
      AND e.revoque_le IS NULL
      AND e.periode @> p_date
    ORDER BY (e.type_taxe_id IS NULL), e.taux_pct DESC
    LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- Création d'une période fiscale mensuelle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.creer_periode_mensuelle(
    p_commune_id uuid,
    p_annee      integer,
    p_mois       integer
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    v_id     uuid;
    v_param  app.commune_parametre;
    v_debut  date;
    v_fin    date;
BEGIN
    SELECT * INTO v_param FROM app.commune_parametre WHERE commune_id = p_commune_id;

    v_debut := make_date(p_annee, p_mois, 1);
    v_fin   := (v_debut + interval '1 month - 1 day')::date;

    INSERT INTO app.periode_fiscale (
        commune_id, code, annee, mois, periodicite,
        date_debut, date_fin, date_exigibilite, date_penalite
    ) VALUES (
        p_commune_id,
        to_char(v_debut, 'YYYY-MM'),
        p_annee, p_mois, 'mensuelle',
        v_debut, v_fin,
        make_date(p_annee, p_mois, coalesce(v_param.jour_exigibilite, 10)),
        make_date(p_annee, p_mois, coalesce(v_param.jour_exigibilite, 10))
            + coalesce(v_param.delai_grace_jours, 5)
    )
    ON CONFLICT (commune_id, code) DO UPDATE SET code = EXCLUDED.code
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Génération des avis d'imposition d'une période
--
-- Appelée chaque mois par le planificateur (phase 5). Idempotente : relancée
-- deux fois, elle ne crée pas de doublon — la contrainte avis_unique_par_periode
-- s'en assure, et la fonction saute les commerces déjà facturés.
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
    v_commerce  record;
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
BEGIN
    SELECT * INTO v_periode FROM app.periode_fiscale WHERE id = p_periode_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Période fiscale % introuvable', p_periode_id;
    END IF;
    IF v_periode.close THEN
        RAISE EXCEPTION 'La période % est close : aucun avis ne peut plus y être ajouté', v_periode.code;
    END IF;

    SELECT * INTO v_param FROM app.commune_parametre WHERE commune_id = v_periode.commune_id;

    SELECT coalesce(max(substring(a.numero from '[0-9]+$')::integer), 0)
      INTO v_seq
      FROM app.avis_imposition a
     WHERE a.periode_id = p_periode_id;

    FOR v_commerce IN
        SELECT c.*
        FROM app.commerce c
        WHERE c.commune_id = v_periode.commune_id
          AND c.archive_le IS NULL
          AND c.statut IN ('actif', 'ferme_temporaire')
          -- Ne pas refacturer un commerce déjà couvert pour cette période
          AND NOT EXISTS (
              SELECT 1 FROM app.avis_imposition a
              WHERE a.commerce_id = c.id AND a.periode_id = p_periode_id
          )
        ORDER BY c.code
    LOOP
        BEGIN
            v_total := 0;
            v_ordre := 0;
            v_seq   := v_seq + 1;
            v_numero := format('%s-%s-%s',
                               coalesce(v_param.prefixe_code_commerce, 'AVIS'),
                               v_periode.code,
                               lpad(v_seq::text, 6, '0'));

            -- Report du reste dû de la période précédente
            SELECT coalesce(sum(a.montant_restant), 0)
              INTO v_report
              FROM app.avis_imposition a
             WHERE a.commerce_id = v_commerce.id
               AND a.annule_le IS NULL
               AND a.statut IN ('emis', 'partiellement_paye')
               AND a.date_exigibilite < v_periode.date_debut;

            INSERT INTO app.avis_imposition (
                commune_id, commerce_id, periode_id, numero,
                date_exigibilite, report_anterieur, statut, cree_par
            ) VALUES (
                v_periode.commune_id, v_commerce.id, p_periode_id, v_numero,
                v_periode.date_exigibilite, v_report, 'brouillon', p_cree_par
            ) RETURNING id INTO v_avis_id;

            -- Une ligne par taxe due
            FOR v_taxe IN
                SELECT ct.type_taxe_id, tt.code, tt.libelle_court, tt.ordre_affichage
                FROM app.commerce_taxe ct
                JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
                WHERE ct.commerce_id = v_commerce.id
                  AND ct.actif
                  AND ct.periode @> v_periode.date_debut
                ORDER BY tt.ordre_affichage
            LOOP
                SELECT * INTO v_calc
                  FROM app.calculer_taxe(v_commerce.id, v_taxe.type_taxe_id, v_periode.date_debut);

                CONTINUE WHEN v_calc.montant IS NULL;   -- taxe non due ce mois-ci

                v_exo := app.exoneration_applicable(v_commerce.id, v_taxe.type_taxe_id, v_periode.date_debut);
                v_exo_montant := 0;
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
                    exoneration_id, detail_calcul, ordre
                ) VALUES (
                    v_avis_id, v_taxe.type_taxe_id, v_calc.bareme_id,
                    coalesce(v_taxe.libelle_court, v_calc.libelle), v_calc.mode_calcul,
                    v_calc.base_calcul, v_calc.unite, v_calc.montant_unitaire,
                    v_calc.montant, coalesce(v_exo.taux_pct, 0), v_exo_montant, v_montant_ligne,
                    v_exo.id, v_calc.detail, v_ordre
                );

                v_total := v_total + v_montant_ligne;
                v_nb_lignes := v_nb_lignes + 1;
            END LOOP;

            UPDATE app.avis_imposition
               SET montant_taxes = v_total,
                   montant_total = v_total + v_report,
                   -- Le cast explicite est indispensable : PostgreSQL ne
                   -- convertit pas automatiquement un CASE textuel en enum.
                   statut = (CASE WHEN v_total + v_report = 0 THEN 'paye'
                                  ELSE 'brouillon' END)::app.statut_avis
             WHERE id = v_avis_id;

            v_nb_avis := v_nb_avis + 1;
            v_somme   := v_somme + v_total + v_report;

        EXCEPTION WHEN OTHERS THEN
            -- Un commerce mal configuré (barème manquant, surface aberrante)
            -- ne doit pas faire échouer la facturation des 5 442 autres.
            v_erreurs := v_erreurs + 1;
            INSERT INTO audit.journal (commune_id, action, entite, entite_id,
                                       entite_libelle, motif, commentaire)
            VALUES (v_periode.commune_id, 'creation', 'avis_imposition', v_commerce.id,
                    v_commerce.code, 'echec_generation_avis', SQLERRM);
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
'Génère les avis mensuels. Idempotente, et tolérante : un commerce en erreur est journalisé, les autres sont facturés.';

-- ---------------------------------------------------------------------------
-- Recalcul du statut fiscal d'un commerce (couleur du marqueur sur la carte)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.recalculer_statut_fiscal(p_commerce_id uuid)
RETURNS app.statut_fiscal
LANGUAGE plpgsql
AS $$
DECLARE
    v_du      numeric;
    v_paye    numeric;
    v_nb      integer;
    v_exo     boolean;
    v_statut  app.statut_fiscal;
BEGIN
    SELECT count(*), coalesce(sum(a.montant_total), 0), coalesce(sum(a.montant_paye), 0)
      INTO v_nb, v_du, v_paye
      FROM app.avis_imposition a
     WHERE a.commerce_id = p_commerce_id
       AND a.annule_le IS NULL
       AND a.statut <> 'brouillon';

    SELECT EXISTS (
        SELECT 1 FROM app.exoneration e
        WHERE e.commerce_id = p_commerce_id
          AND e.revoque_le IS NULL
          AND e.type_taxe_id IS NULL
          AND e.taux_pct = 100
          AND e.periode @> current_date
    ) INTO v_exo;

    v_statut := CASE
        WHEN v_exo            THEN 'exonere'
        WHEN v_nb = 0         THEN 'inconnu'
        WHEN v_paye >= v_du   THEN 'a_jour'
        WHEN v_paye > 0       THEN 'partiel'
        ELSE 'impaye'
    END::app.statut_fiscal;

    UPDATE app.commerce
       SET statut_fiscal = v_statut,
           statut_fiscal_calcule_le = now(),
           solde_du = greatest(v_du - v_paye, 0)
     WHERE id = p_commerce_id;

    RETURN v_statut;
END;
$$;

-- ---------------------------------------------------------------------------
-- Application des pénalités de retard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.appliquer_penalites(p_commune_id uuid, p_date date DEFAULT current_date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_param   app.commune_parametre;
    v_avis    record;
    v_pen     numeric;
    v_nb      integer := 0;
BEGIN
    SELECT * INTO v_param FROM app.commune_parametre WHERE commune_id = p_commune_id;
    IF coalesce(v_param.taux_penalite_pct, 0) = 0 THEN
        RETURN 0;
    END IF;

    FOR v_avis IN
        SELECT a.id, a.montant_taxes, a.montant_penalite, a.montant_paye, a.report_anterieur
        FROM app.avis_imposition a
        JOIN app.periode_fiscale p ON p.id = a.periode_id
        WHERE a.commune_id = p_commune_id
          AND a.annule_le IS NULL
          AND a.statut IN ('emis','partiellement_paye')
          AND p.date_penalite IS NOT NULL
          AND p_date > p.date_penalite
    LOOP
        v_pen := app.arrondir_xof(v_avis.montant_taxes * v_param.taux_penalite_pct / 100);

        -- Plafond de pénalité : la pénalité ne peut pas dépasser un
        -- pourcentage du principal, sinon la dette devient inextinguible.
        IF v_param.penalite_plafond_pct IS NOT NULL THEN
            v_pen := least(v_pen,
                app.arrondir_xof(v_avis.montant_taxes * v_param.penalite_plafond_pct / 100));
        END IF;

        CONTINUE WHEN v_pen <= v_avis.montant_penalite;

        UPDATE app.avis_imposition
           SET montant_penalite = v_pen,
               montant_total    = montant_taxes + v_pen + report_anterieur - montant_remise
         WHERE id = v_avis.id;

        v_nb := v_nb + 1;
    END LOOP;

    RETURN v_nb;
END;
$$;
