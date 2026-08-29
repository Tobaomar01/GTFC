-- ===========================================================================
--  SEED 0006 — Jeu de démonstration : commerces, avis, paiements
--
--  ##########################################################################
--  ###  60 COMMERCES FICTIFS, positionnés aléatoirement dans l'emprise    ###
--  ###  approchée de la commune.                                          ###
--  ###                                                                    ###
--  ###  Objectif : vérifier de bout en bout, dès la phase 2, que          ###
--  ###    - la détection du quartier par GPS fonctionne ;                 ###
--  ###    - les codes GTFC-Z1-00001 sont générés sans collision ;         ###
--  ###    - le calcul multi-taxes produit des montants cohérents ;        ###
--  ###    - la carte affiche bien du vert, de l'orange et du rouge ;      ###
--  ###    - le journal d'audit se remplit tout seul.                      ###
--  ###                                                                    ###
--  ###  SUPPRESSION AVANT PRODUCTION :                                    ###
--  ###    SELECT app.supprimer_donnees_demo();                            ###
--  ##########################################################################
-- ===========================================================================

DO $$
DECLARE
    v_commune_id  uuid;
    v_cat         record;
    v_detect      record;
    v_code        record;
    v_commerce_id uuid;
    v_agents      uuid[];
    v_agent       uuid;
    v_periode_id  uuid;
    v_lon numeric; v_lat numeric;
    v_todp numeric; v_enseigne numeric;
    v_debut_visite timestamptz;
    lon_min constant numeric := -17.4555;
    lon_max constant numeric := -17.4385;
    lat_min constant numeric :=  14.6805;
    lat_max constant numeric :=  14.6915;
    i integer;
    v_nb_crees integer := 0;
BEGIN

SELECT id INTO v_commune_id FROM app.commune WHERE code = 'GTFC';
IF v_commune_id IS NULL THEN
    RAISE EXCEPTION 'Commune GTFC absente — lancez d''abord les seeds précédents.';
END IF;

-- Déjà peuplé : on ne recrée pas
IF EXISTS (SELECT 1 FROM app.commerce WHERE commune_id = v_commune_id AND origine = 'terrain'
                                        AND notes = 'DEMO') THEN
    RAISE NOTICE '[seed 0006] Jeu de démonstration déjà présent — rien à faire.';
    RETURN;
END IF;

-- Tirage reproductible : deux exécutions produisent le même jeu de données
PERFORM setseed(0.42);

SELECT array_agg(id) INTO v_agents
  FROM app.utilisateur
 WHERE commune_id = v_commune_id AND role = 'agent' AND archive_le IS NULL;

IF v_agents IS NULL THEN
    RAISE EXCEPTION 'Aucun agent — lancez d''abord le seed 0005.';
END IF;

-- ---------------------------------------------------------------------------
-- 1. Les commerces
-- ---------------------------------------------------------------------------
FOR i IN 1..60 LOOP
    v_lon := lon_min + random() * (lon_max - lon_min);
    v_lat := lat_min + random() * (lat_max - lat_min);

    SELECT * INTO v_detect
      FROM app.detecter_quartier(v_commune_id, v_lon, v_lat) LIMIT 1;

    CONTINUE WHEN v_detect.quartier_id IS NULL;

    SELECT * INTO v_cat
      FROM ref.categorie_commerce
     WHERE commune_id = v_commune_id AND actif
     ORDER BY random() LIMIT 1;

    SELECT * INTO v_code
      FROM app.generer_code_commerce(v_commune_id, v_detect.zone_id);

    v_agent := v_agents[1 + floor(random() * array_length(v_agents, 1))::int];

    -- Un commerce sur deux déborde sur le trottoir (proportion plausible en
    -- centre-ville dense, à confirmer par les relevés terrain réels)
    v_todp := CASE WHEN v_cat.todp_probable AND random() < 0.5
                   THEN round((0.5 + random() * 9.5)::numeric, 1) END;
    v_enseigne := CASE WHEN v_cat.enseigne_probable AND random() < 0.6
                       THEN round((0.5 + random() * 4.5)::numeric, 1) END;

    INSERT INTO app.commerce (
        commune_id, zone_id, quartier_id, categorie_id,
        code, numero_sequence, enseigne,
        gerant_nom, gerant_prenom, gerant_telephone, telephone_paiement,
        point_repere, geom, precision_gps_m, quartier_detecte_auto,
        surface_locale_m2, todp_surface_m2, enseigne_surface_m2,
        statut, date_recensement, agent_recenseur_id,
        origine, notes, cree_par
    ) VALUES (
        v_commune_id, v_detect.zone_id, v_detect.quartier_id, v_cat.id,
        v_code.code, v_code.numero_sequence,
        format('DEMO — Commerce %s', lpad(i::text, 3, '0')),
        'À_REMPLACER', format('Gérant %s', i),
        format('+2217%s', lpad((1000000 + i)::text, 8, '0')),
        format('+2217%s', lpad((1000000 + i)::text, 8, '0')),
        'DEMO — point de repère fictif',
        app.point_gps(v_lon, v_lat),
        round((3 + random() * 12)::numeric, 1),
        true,
        round((6 + random() * 40)::numeric, 1),
        v_todp,
        v_enseigne,
        'actif',
        current_date - (random() * 30)::int,
        v_agent,
        'terrain', 'DEMO', v_agent
    ) RETURNING id INTO v_commerce_id;

    v_nb_crees := v_nb_crees + 1;

    -- -----------------------------------------------------------------------
    -- 2. Taxes CONDITIONNELLES dues par ce commerce
    --
    --    Les taxes inconditionnelles — la patente en tête — ne sont PAS
    --    reprises ici : depuis la migration 0051, un déclencheur les rattache
    --    à l'insertion du commerce, parce qu'un oubli de patente ne se voit
    --    pas, il se lit seulement dans un total plus faible que prévu.
    --
    --    Les insérer une seconde fois violait la contrainte d'exclusion
    --    « commerce_taxe_pas_de_doublon » et faisait échouer ce seed sur toute
    --    installation NEUVE. Sur la base de recette le défaut restait invisible :
    --    les seeds y avaient été joués AVANT que le déclencheur n'existe.
    --
    --    Une taxe, un endroit qui la rattache. Le déclencheur pour les
    --    inconditionnelles, ce bloc pour les conditionnelles, que seul le
    --    terrain peut constater et mesurer.
    --
    --    date_debut au 1er du mois : sans cela, la génération des avis de la
    --    période courante ne trouverait aucune taxe active à sa date de début.
    -- -----------------------------------------------------------------------
    INSERT INTO app.commerce_taxe (
        commune_id, commerce_id, type_taxe_id, parametre_valeur,
        parametre_source, date_debut, actif, cree_par
    )
    SELECT v_commune_id, v_commerce_id, ct.type_taxe_id,
           CASE tt.code
               WHEN 'todp'     THEN v_todp
               WHEN 'enseigne' THEN v_enseigne
               ELSE NULL
           END,
           'categorie',
           date_trunc('month', current_date)::date,
           true, v_agent
    FROM ref.categorie_taxe ct
    JOIN ref.type_taxe tt ON tt.id = ct.type_taxe_id
    WHERE ct.categorie_id = v_cat.id
      -- Les inconditionnelles sont déjà posées par le déclencheur (0051)
      AND tt.conditionnelle
      -- On n'attache TODP et enseignes que si l'agent a effectivement mesuré
      AND (tt.code <> 'todp'     OR v_todp     IS NOT NULL)
      AND (tt.code <> 'enseigne' OR v_enseigne IS NOT NULL)
      -- Aucun de ces commerces de démonstration n'est sur un marché
      AND tt.code <> 'droit_place';

    -- -----------------------------------------------------------------------
    -- 3. QR code
    -- -----------------------------------------------------------------------
    INSERT INTO app.qr_code (commune_id, commerce_id, jeton, url, genere_par)
    SELECT v_commune_id, v_commerce_id, j,
           format('https://gtfc.example.sn/c/%s', j),
           v_agent
    FROM app.generer_jeton_qr() AS j;

    -- -----------------------------------------------------------------------
    -- 4. Visite de recensement
    -- -----------------------------------------------------------------------
    -- Un seul tirage pour la date : deux appels à random() donneraient une
    -- fin de visite antérieure à son début (contrainte visite_dates).
    v_debut_visite := now() - (random() * 30 || ' days')::interval;

    INSERT INTO app.visite (
        commune_id, commerce_id, agent_id, resultat, geom, precision_gps_m,
        quartier_id, debute_le, termine_le, hors_ligne
    ) VALUES (
        v_commune_id, v_commerce_id, v_agent, 'enregistrement',
        -- Léger décalage : l'agent est devant la boutique, pas dedans.
        -- Le cast en numeric est nécessaire : random() renvoie un double.
        app.point_gps((v_lon + (random() - 0.5) * 0.0002)::numeric,
                      (v_lat + (random() - 0.5) * 0.0002)::numeric),
        round((3 + random() * 10)::numeric, 1),
        v_detect.quartier_id,
        v_debut_visite,
        v_debut_visite + interval '6 minutes',
        random() < 0.3
    );
END LOOP;

RAISE NOTICE '[seed 0006] % commerces de démonstration créés', v_nb_crees;

-- ---------------------------------------------------------------------------
-- 5. Période fiscale du mois en cours + génération des avis
-- ---------------------------------------------------------------------------
v_periode_id := app.creer_periode_mensuelle(
    v_commune_id,
    EXTRACT(YEAR  FROM current_date)::integer,
    EXTRACT(MONTH FROM current_date)::integer
);

PERFORM app.generer_avis_periode(v_periode_id, NULL);

UPDATE app.avis_imposition
   SET statut = 'emis', date_emission = current_date
 WHERE periode_id = v_periode_id AND statut = 'brouillon' AND montant_total > 0;

-- ---------------------------------------------------------------------------
-- 6. Paiements simulés — pour que la carte affiche les trois couleurs
--      ~40 % payés intégralement  -> vert
--      ~20 % payés partiellement  -> orange
--      ~40 % impayés              -> rouge
-- ---------------------------------------------------------------------------
-- Les tirages aléatoires sont figés dans une CTE : le moyen de paiement doit
-- être connu AVANT l'insertion (contrainte historique, levée en 0041)
-- exige un agent identifié dès qu'il s'agit d'espèces.
WITH candidats AS (
    SELECT a.id AS avis_id, a.commune_id, a.commerce_id, a.numero, a.montant_total,
           c.telephone_paiement, c.agent_recenseur_id,
           random() AS tirage_moyen,
           random() AS tirage_montant,
           random() AS tirage_date
    FROM app.avis_imposition a
    JOIN app.commerce c ON c.id = a.commerce_id
    WHERE a.periode_id = v_periode_id
      AND a.statut = 'emis'
      AND a.montant_total > 0
      AND random() < 0.60
)
INSERT INTO app.paiement (
    commune_id, commerce_id, avis_id, reference, montant, moyen,
    paye_le, encaisse_par, telephone_payeur, commentaire
)
SELECT
    commune_id, commerce_id, avis_id,
    format('DEMO-PAY-%s', lpad(row_number() OVER (ORDER BY numero)::text, 6, '0')),
    CASE WHEN tirage_montant < 0.66
         THEN montant_total                                     -- règlement complet
         ELSE greatest(app.arrondir_xof(montant_total * 0.4), 1) END,
    CASE WHEN tirage_moyen < 0.8 THEN 'wave'::app.moyen_paiement
         ELSE 'wave'::app.moyen_paiement END,
    now() - (tirage_date * 10 || ' days')::interval,
    CASE WHEN tirage_moyen >= 0.8 THEN agent_recenseur_id END,
    telephone_paiement,
    'DEMO'
FROM candidats;

-- ---------------------------------------------------------------------------
-- 7. Recalcul des statuts fiscaux (couleurs de la carte)
-- ---------------------------------------------------------------------------
PERFORM app.recalculer_statut_fiscal(c.id)
FROM app.commerce c
WHERE c.commune_id = v_commune_id AND c.archive_le IS NULL;

RAISE NOTICE '[seed 0006] Période %, % avis, % paiements',
    (SELECT code FROM app.periode_fiscale WHERE id = v_periode_id),
    (SELECT count(*) FROM app.avis_imposition WHERE periode_id = v_periode_id),
    (SELECT count(*) FROM app.paiement WHERE commentaire = 'DEMO');

END
$$;

-- ===========================================================================
--  Suppression du jeu de démonstration
--  À lancer avant la mise en production, une fois les vraies données saisies.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.supprimer_donnees_demo()
RETURNS TABLE (entite text, nb_supprimes bigint)
LANGUAGE plpgsql
AS $$
DECLARE
    v_ids uuid[];
BEGIN
    SELECT array_agg(id) INTO v_ids FROM app.commerce WHERE notes = 'DEMO';
    IF v_ids IS NULL THEN
        RETURN QUERY SELECT 'aucune donnée de démonstration'::text, 0::bigint;
        RETURN;
    END IF;

    -- Ordre imposé par les clés étrangères
    RETURN QUERY WITH d AS (DELETE FROM app.quittance        WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'quittance'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.transaction_wave WHERE avis_id IN
                              (SELECT id FROM app.avis_imposition WHERE commerce_id = ANY(v_ids)) RETURNING 1)
                 SELECT 'transaction_wave'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.paiement         WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'paiement'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.avis_imposition  WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'avis_imposition'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.visite           WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'visite'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.qr_scan          WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'qr_scan'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.qr_code          WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'qr_code'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.commerce_photo   WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'commerce_photo'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.commerce_taxe    WHERE commerce_id = ANY(v_ids) RETURNING 1)
                 SELECT 'commerce_taxe'::text, count(*) FROM d;
    RETURN QUERY WITH d AS (DELETE FROM app.commerce         WHERE id = ANY(v_ids) RETURNING 1)
                 SELECT 'commerce'::text, count(*) FROM d;
END;
$$;

COMMENT ON FUNCTION app.supprimer_donnees_demo IS
'Supprime les 60 commerces de démonstration et tout ce qui en dépend. Le journal d''audit, lui, conserve la trace de leur passage.';
