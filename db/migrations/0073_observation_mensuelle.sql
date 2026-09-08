-- ===========================================================================
--  La memoire mensuelle des situations
--  Exigences FR-086 a FR-088 (specification, session 2026-09-08)
--
--  POURQUOI UNE TABLE, alors que 0064 defendait une VUE.
--
--  L'argument de 0064 tient toujours pour la situation COURANTE : elle se
--  deduit des avis et des paiements, et la figer creerait une seconde source
--  de verite qui mentirait un jour.
--
--  Le passe, lui, ne se deduit pas. Un avis annule disparait ; un versement
--  annule aussi ; une exoneration accordee apres coup change retroactivement
--  ce qui etait du. La meme question posee deux fois sur le meme mois
--  recevrait deux reponses differentes, sans que rien ne le dise. Un
--  classement qui bouge tout seul entre deux consultations n'est pas un
--  classement : c'est un tirage.
--
--  POURQUOI LE MOIS, ET NON LA PERIODE FISCALE.
--
--  Le pilote emet des avis ANNUELS, fondes sur des baremes mensuels. Une
--  observation par cloture de periode donnerait UNE observation par an :
--  l'indicateur resterait « indetermine » pendant deux ans, c'est-a-dire
--  pendant toute la phase ou l'on en a besoin. Le mois calendaire est la
--  cadence qui rend la regularite de paiement lisible — et c'est elle que la
--  question posait : « en fonction de leur frequence de paiement ».
--
--  TOUT EST DATE A LA FIN DU MOIS OBSERVE, jamais a aujourd'hui. Un mois
--  rattrape apres coup doit donner le meme resultat que s'il avait ete arrete
--  a l'heure : sinon la memoire depend de la date a laquelle on la constitue.
--
--  Une correction ne se fait pas en place : c'est une nouvelle observation qui
--  remplace la precedente, laquelle reste lisible. La regle du journal
--  d'audit, appliquee a la memoire metier.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS app.observation_mensuelle (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id             uuid NOT NULL REFERENCES app.commune(id),
    commerce_id            uuid NOT NULL REFERENCES app.commerce(id),
    -- Premier jour du mois observe. Un mois, pas une periode fiscale.
    mois                   date NOT NULL,

    arretee_le             timestamptz NOT NULL DEFAULT now(),

    -- --- Cumule a la fin du mois ------------------------------------------
    nb_avis                integer       NOT NULL,
    montant_du_cumule      numeric(14,2) NOT NULL,
    montant_regle_cumule   numeric(14,2) NOT NULL,
    montant_restant        numeric(14,2) NOT NULL,

    -- --- Ce qui s'est passe DANS le mois ----------------------------------
    montant_regle_mois     numeric(14,2) NOT NULL,
    nb_paiements_mois      integer       NOT NULL,

    -- --- Le temps ----------------------------------------------------------
    -- Un avis exigible et non solde a la fin du mois. Pas « en retard
    -- aujourd'hui » : en retard CE MOIS-LA.
    echeance_depassee      boolean NOT NULL,
    dernier_reglement_le   date,
    jours_depuis_reglement integer,
    -- Compte les avis DEJA relances a cette date, et non le compteur courant :
    -- sinon un mois rattrape porterait les relances des mois suivants.
    nb_avis_relances       integer NOT NULL,

    -- --- Ce qui neutralise un impaye ---------------------------------------
    contestation_ouverte   boolean NOT NULL,
    exoneration_en_vigueur boolean NOT NULL,

    -- --- Le contexte -------------------------------------------------------
    nb_visites_mois        integer NOT NULL,
    commerce_archive       boolean NOT NULL,

    -- --- Le remplacement (FR-087) ------------------------------------------
    -- Pas de pointeur vers l'observation remplacante : il faudrait l'inserer
    -- AVANT de retirer l'ancienne du champ, ce que l'index partiel refuse.
    -- L'ordre par arretee_le sur (commerce_id, mois) dit la succession sans
    -- ambiguite, et une contrainte de moins vaut mieux qu'une contrainte
    -- qu'on doit desactiver pour ecrire.
    remplacee_le           timestamptz,
    motif_remplacement     text,

    CONSTRAINT ck_observation_mois_premier_jour
        CHECK (mois = date_trunc('month', mois)::date)
);

COMMENT ON TABLE app.observation_mensuelle IS
    'Photographie datee et figee de la situation d''un commerce a la fin d''un '
    'mois. Immuable : une correction se fait par remplacement (FR-087).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_observation_en_vigueur
    ON app.observation_mensuelle (commerce_id, mois)
 WHERE remplacee_le IS NULL;

CREATE INDEX IF NOT EXISTS idx_observation_mois
    ON app.observation_mensuelle (commune_id, mois) WHERE remplacee_le IS NULL;

CREATE INDEX IF NOT EXISTS idx_observation_commerce
    ON app.observation_mensuelle (commerce_id, mois);

ALTER TABLE app.observation_mensuelle ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.observation_mensuelle;
CREATE POLICY pol_isolation_commune ON app.observation_mensuelle
    FOR ALL
    USING (app.est_super_admin() OR commune_id = app.commune_courante())
    WITH CHECK (app.est_super_admin() OR commune_id = app.commune_courante());

-- ---------------------------------------------------------------------------
--  L'inalterabilite, en un seul endroit.
--
--  Une regle ecrite dans le service serait contournee par la premiere requete
--  ecrite ailleurs — un script de reprise, une correction a la main un
--  vendredi soir. Ici elle tient meme pour celui qui ouvre psql.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_observation_inalterable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, public, pg_catalog
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'Une observation mensuelle ne se supprime pas : elle se remplace (FR-087).'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.remplacee_le IS NOT NULL THEN
        RAISE EXCEPTION
            'L''observation % est deja remplacee : elle ne bouge plus.', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF ROW(NEW.commune_id, NEW.commerce_id, NEW.mois, NEW.arretee_le,
           NEW.nb_avis, NEW.montant_du_cumule, NEW.montant_regle_cumule,
           NEW.montant_restant, NEW.montant_regle_mois, NEW.nb_paiements_mois,
           NEW.echeance_depassee, NEW.dernier_reglement_le,
           NEW.jours_depuis_reglement, NEW.nb_avis_relances,
           NEW.contestation_ouverte, NEW.exoneration_en_vigueur,
           NEW.nb_visites_mois, NEW.commerce_archive)
       IS DISTINCT FROM
       ROW(OLD.commune_id, OLD.commerce_id, OLD.mois, OLD.arretee_le,
           OLD.nb_avis, OLD.montant_du_cumule, OLD.montant_regle_cumule,
           OLD.montant_restant, OLD.montant_regle_mois, OLD.nb_paiements_mois,
           OLD.echeance_depassee, OLD.dernier_reglement_le,
           OLD.jours_depuis_reglement, OLD.nb_avis_relances,
           OLD.contestation_ouverte, OLD.exoneration_en_vigueur,
           OLD.nb_visites_mois, OLD.commerce_archive)
    THEN
        RAISE EXCEPTION
            'Une observation arretee ne se reecrit pas : en arreter une nouvelle, '
            'qui remplacera celle-ci (FR-087).'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_observation_inalterable ON app.observation_mensuelle;
CREATE TRIGGER trg_observation_inalterable
    BEFORE UPDATE OR DELETE ON app.observation_mensuelle
    FOR EACH ROW EXECUTE FUNCTION app.trg_observation_inalterable();

-- ===========================================================================
--  La situation d'une commune a la fin d'un mois donne.
--
--  Fonction et non vue : elle prend le mois en argument, et TOUT y est date a
--  la fin de ce mois. C'est ce qu'on s'apprete a figer, pas la memoire
--  elle-meme — les comparer est la seule facon de savoir qu'une correction
--  s'impose.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.situation_au_mois(
    p_commune_id uuid,
    p_mois       date
)
RETURNS TABLE (
    commune_id             uuid,
    commerce_id            uuid,
    nb_avis                integer,
    montant_du_cumule      numeric,
    montant_regle_cumule   numeric,
    montant_restant        numeric,
    montant_regle_mois     numeric,
    nb_paiements_mois      integer,
    echeance_depassee      boolean,
    dernier_reglement_le   date,
    jours_depuis_reglement integer,
    nb_avis_relances       integer,
    contestation_ouverte   boolean,
    exoneration_en_vigueur boolean,
    nb_visites_mois        integer,
    commerce_archive       boolean
)
LANGUAGE sql
STABLE
SET search_path = app, public, pg_catalog
AS $$
    WITH bornes AS (
        SELECT date_trunc('month', p_mois)::date                          AS debut,
               (date_trunc('month', p_mois) + interval '1 month - 1 day')::date AS fin
    ),
    -- Chaque avis avec ce qui avait ete verse dessus a la fin du mois.
    avis AS (
        SELECT a.commerce_id,
               a.commune_id,
               a.id,
               a.montant_total,
               a.date_exigibilite,
               (a.derniere_relance_le IS NOT NULL
                AND a.derniere_relance_le::date <= b.fin) AS relance,
               coalesce((SELECT sum(p.montant) FROM app.paiement p
                          WHERE p.avis_id = a.id
                            AND p.annule_le IS NULL
                            AND p.paye_le::date <= b.fin), 0) AS regle
          FROM app.avis_imposition a
         CROSS JOIN bornes b
         WHERE a.annule_le IS NULL
           AND a.commune_id = p_commune_id
           AND a.date_emission <= b.fin
    ),
    versements AS (
        SELECT a.commerce_id,
               sum(p.montant) FILTER (WHERE p.paye_le::date <= b.fin)          AS regle_cumule,
               sum(p.montant) FILTER (WHERE p.paye_le::date BETWEEN b.debut AND b.fin) AS regle_mois,
               count(*)       FILTER (WHERE p.paye_le::date BETWEEN b.debut AND b.fin) AS nb_mois,
               max(p.paye_le::date) FILTER (WHERE p.paye_le::date <= b.fin)    AS dernier
          FROM avis a
          JOIN app.paiement p ON p.avis_id = a.id AND p.annule_le IS NULL
         CROSS JOIN bornes b
         GROUP BY a.commerce_id
    )
    SELECT
        a.commune_id,
        a.commerce_id,
        count(*)::integer                                        AS nb_avis,
        sum(a.montant_total)                                     AS montant_du_cumule,
        coalesce(max(v.regle_cumule), 0)                         AS montant_regle_cumule,
        sum(a.montant_total) - coalesce(max(v.regle_cumule), 0)  AS montant_restant,
        coalesce(max(v.regle_mois), 0)                           AS montant_regle_mois,
        coalesce(max(v.nb_mois), 0)::integer                     AS nb_paiements_mois,
        bool_or(a.date_exigibilite <= b.fin AND a.montant_total > a.regle) AS echeance_depassee,
        max(v.dernier)                                           AS dernier_reglement_le,
        (b.fin - max(v.dernier))::integer                        AS jours_depuis_reglement,
        count(*) FILTER (WHERE a.relance)::integer                AS nb_avis_relances,

        EXISTS (
            SELECT 1 FROM app.contestation c
             WHERE c.avis_id IN (SELECT a2.id FROM avis a2 WHERE a2.commerce_id = a.commerce_id)
               AND c.cree_le::date <= b.fin
               AND (c.resolue_le IS NULL OR c.resolue_le::date > b.fin)
        ) AS contestation_ouverte,

        EXISTS (
            SELECT 1 FROM app.exoneration e
             WHERE e.commerce_id = a.commerce_id
               AND e.revoque_le IS NULL
               AND e.valide_le IS NOT NULL
               AND e.periode && daterange(b.debut, b.fin, '[]')
        ) AS exoneration_en_vigueur,

        (SELECT count(*) FROM app.visite vi
          WHERE vi.commerce_id = a.commerce_id
            AND vi.termine_le IS NOT NULL
            AND vi.termine_le::date BETWEEN b.debut AND b.fin)::integer AS nb_visites_mois,

        (SELECT co.archive_le IS NOT NULL AND co.archive_le::date <= b.fin
           FROM app.commerce co WHERE co.id = a.commerce_id) AS commerce_archive
      FROM avis a
      CROSS JOIN bornes b
      LEFT JOIN versements v ON v.commerce_id = a.commerce_id
     GROUP BY a.commune_id, a.commerce_id, b.debut, b.fin;
$$;

COMMENT ON FUNCTION app.situation_au_mois(uuid, date) IS
    'Situation de chaque commerce facture, arretee a la FIN du mois donne. '
    'Ce que app.arreter_observations() fige.';

-- ===========================================================================
--  Arreter les observations d'un mois.
--
--  Idempotente : rejouee, elle n'ajoute rien. Avec p_corriger, elle compare le
--  present a ce qui avait ete fige et REMPLACE ce qui a change — sans jamais
--  reecrire la ligne d'origine.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.arreter_observations(
    p_commune_id uuid,
    p_mois       date,
    p_corriger   boolean DEFAULT false,
    p_motif      text    DEFAULT NULL
)
RETURNS TABLE (arretees integer, corrigees integer, inchangees integer)
LANGUAGE plpgsql
SET search_path = app, public, pg_catalog
AS $$
DECLARE
    v_mois       date := date_trunc('month', p_mois)::date;
    v_arretees   integer := 0;
    v_corrigees  integer := 0;
    v_inchangees integer := 0;
    v_l          record;
BEGIN
    IF v_mois >= date_trunc('month', current_date)::date THEN
        RAISE EXCEPTION
            'Le mois % n''est pas termine : l''arreter figerait une situation '
            'qui va encore changer.', to_char(v_mois, 'YYYY-MM')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- JOINTURE EXTERNE COMPLETE, et non un simple parcours de la situation.
    --
    -- Un commerce dont TOUS les avis ont ete annules disparait du calcul.
    -- Parcourir la situation seule laisserait son observation figee sur des
    -- chiffres sans fondement, sans jamais la corriger ni la signaler. Le cote
    -- « deja fige » doit donc etre lu lui aussi.
    FOR v_l IN
        WITH courant AS (
            SELECT * FROM app.situation_au_mois(p_commune_id, v_mois)
        ),
        figee AS (
            SELECT * FROM app.observation_mensuelle
             WHERE commune_id = p_commune_id
               AND mois = v_mois
               AND remplacee_le IS NULL
        )
        SELECT
            f.id                                        AS ancienne_id,
            coalesce(c.commune_id, f.commune_id)        AS commune_id,
            coalesce(c.commerce_id, f.commerce_id)      AS commerce_id,
            coalesce(c.nb_avis, 0)                      AS nb_avis,
            coalesce(c.montant_du_cumule, 0)            AS montant_du_cumule,
            coalesce(c.montant_regle_cumule, 0)         AS montant_regle_cumule,
            coalesce(c.montant_restant, 0)              AS montant_restant,
            coalesce(c.montant_regle_mois, 0)           AS montant_regle_mois,
            coalesce(c.nb_paiements_mois, 0)            AS nb_paiements_mois,
            coalesce(c.echeance_depassee, false)        AS echeance_depassee,
            c.dernier_reglement_le,
            c.jours_depuis_reglement,
            coalesce(c.nb_avis_relances, 0)             AS nb_avis_relances,
            coalesce(c.contestation_ouverte, false)     AS contestation_ouverte,
            coalesce(c.exoneration_en_vigueur, false)   AS exoneration_en_vigueur,
            coalesce(c.nb_visites_mois, 0)              AS nb_visites_mois,
            coalesce(c.commerce_archive, f.commerce_archive, false) AS commerce_archive,
            ROW(f.nb_avis, f.montant_du_cumule, f.montant_regle_cumule,
                f.montant_restant, f.montant_regle_mois, f.nb_paiements_mois,
                f.echeance_depassee, f.dernier_reglement_le,
                f.jours_depuis_reglement, f.nb_avis_relances,
                f.contestation_ouverte, f.exoneration_en_vigueur,
                f.nb_visites_mois, f.commerce_archive)
            IS DISTINCT FROM
            ROW(coalesce(c.nb_avis, 0), coalesce(c.montant_du_cumule, 0),
                coalesce(c.montant_regle_cumule, 0), coalesce(c.montant_restant, 0),
                coalesce(c.montant_regle_mois, 0), coalesce(c.nb_paiements_mois, 0),
                coalesce(c.echeance_depassee, false), c.dernier_reglement_le,
                c.jours_depuis_reglement, coalesce(c.nb_avis_relances, 0),
                coalesce(c.contestation_ouverte, false),
                coalesce(c.exoneration_en_vigueur, false),
                coalesce(c.nb_visites_mois, 0),
                coalesce(c.commerce_archive, f.commerce_archive, false)) AS a_change
          FROM courant c
          FULL JOIN figee f ON f.commerce_id = c.commerce_id
    LOOP
        IF v_l.ancienne_id IS NULL THEN
            INSERT INTO app.observation_mensuelle (
                commune_id, commerce_id, mois,
                nb_avis, montant_du_cumule, montant_regle_cumule, montant_restant,
                montant_regle_mois, nb_paiements_mois,
                echeance_depassee, dernier_reglement_le, jours_depuis_reglement,
                nb_avis_relances, contestation_ouverte, exoneration_en_vigueur,
                nb_visites_mois, commerce_archive)
            VALUES (
                v_l.commune_id, v_l.commerce_id, v_mois,
                v_l.nb_avis, v_l.montant_du_cumule, v_l.montant_regle_cumule,
                v_l.montant_restant, v_l.montant_regle_mois, v_l.nb_paiements_mois,
                v_l.echeance_depassee, v_l.dernier_reglement_le,
                v_l.jours_depuis_reglement, v_l.nb_avis_relances,
                v_l.contestation_ouverte, v_l.exoneration_en_vigueur,
                v_l.nb_visites_mois, v_l.commerce_archive);
            v_arretees := v_arretees + 1;

        ELSIF p_corriger AND v_l.a_change THEN
            -- L'ancienne QUITTE le champ d'abord : l'index partiel n'accepte
            -- qu'une seule observation en vigueur par commerce et par mois.
            UPDATE app.observation_mensuelle
               SET remplacee_le       = now(),
                   motif_remplacement = coalesce(p_motif, 'correction apres arret')
             WHERE id = v_l.ancienne_id;

            INSERT INTO app.observation_mensuelle (
                commune_id, commerce_id, mois,
                nb_avis, montant_du_cumule, montant_regle_cumule, montant_restant,
                montant_regle_mois, nb_paiements_mois,
                echeance_depassee, dernier_reglement_le, jours_depuis_reglement,
                nb_avis_relances, contestation_ouverte, exoneration_en_vigueur,
                nb_visites_mois, commerce_archive)
            VALUES (
                v_l.commune_id, v_l.commerce_id, v_mois,
                v_l.nb_avis, v_l.montant_du_cumule, v_l.montant_regle_cumule,
                v_l.montant_restant, v_l.montant_regle_mois, v_l.nb_paiements_mois,
                v_l.echeance_depassee, v_l.dernier_reglement_le,
                v_l.jours_depuis_reglement, v_l.nb_avis_relances,
                v_l.contestation_ouverte, v_l.exoneration_en_vigueur,
                v_l.nb_visites_mois, v_l.commerce_archive);
            v_corrigees := v_corrigees + 1;
        ELSE
            v_inchangees := v_inchangees + 1;
        END IF;
    END LOOP;

    RETURN QUERY SELECT v_arretees, v_corrigees, v_inchangees;
END;
$$;

-- ===========================================================================
--  Rattraper tous les mois qui manquent.
--
--  Le declencheur serait ici le mauvais outil : rien ne se produit en base au
--  passage d'un mois. La tache planifiee, elle, peut ne pas tourner — serveur
--  arrete, migration en cours. Cette fonction repart donc du PREMIER avis emis
--  et arrete tout mois termine qui n'a pas encore d'observation : un oubli se
--  repare tout seul au passage suivant, et rien ne se perd.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app.arreter_observations_dues(p_commune_id uuid)
RETURNS TABLE (mois_arretes integer, observations integer)
LANGUAGE plpgsql
SET search_path = app, public, pg_catalog
AS $$
DECLARE
    v_premier date;
    v_dernier date := (date_trunc('month', current_date) - interval '1 month')::date;
    v_mois    date;
    v_res     record;
    v_mois_ok integer := 0;
    v_obs     integer := 0;
BEGIN
    SELECT date_trunc('month', min(a.date_emission))::date INTO v_premier
      FROM app.avis_imposition a
     WHERE a.commune_id = p_commune_id AND a.annule_le IS NULL;

    IF v_premier IS NULL THEN
        RETURN QUERY SELECT 0, 0;
        RETURN;
    END IF;

    v_mois := v_premier;
    WHILE v_mois <= v_dernier LOOP
        IF NOT EXISTS (SELECT 1 FROM app.observation_mensuelle o
                        WHERE o.commune_id = p_commune_id AND o.mois = v_mois) THEN
            SELECT * INTO v_res FROM app.arreter_observations(p_commune_id, v_mois);
            v_mois_ok := v_mois_ok + 1;
            v_obs := v_obs + v_res.arretees;
        END IF;
        v_mois := (v_mois + interval '1 month')::date;
    END LOOP;

    RETURN QUERY SELECT v_mois_ok, v_obs;
END;
$$;

COMMENT ON FUNCTION app.arreter_observations_dues(uuid) IS
    'Arrete tout mois termine qui n''a pas encore d''observation, depuis le '
    'premier avis emis. Idempotente : un passage manque se rattrape au suivant.';

-- ---------------------------------------------------------------------------
--  Droits.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON app.observation_mensuelle TO gtfc_app;
GRANT EXECUTE ON FUNCTION app.situation_au_mois(uuid, date) TO gtfc_app;
GRANT EXECUTE ON FUNCTION app.arreter_observations(uuid, date, boolean, text) TO gtfc_app;
GRANT EXECUTE ON FUNCTION app.arreter_observations_dues(uuid) TO gtfc_app;
