-- ===========================================================================
--  Feuille de route quotidienne, et situations de paiement
--  Exigences FR-072 a FR-081 (specification, session 2026-09-07)
--
--  DEUX DISPOSITIFS DISTINCTS, et la distinction est opposable.
--
--  La RELANCE (FR-058 a FR-062) s'adresse aux redevables dont une echeance est
--  depassee, et FR-062 en exclut expressement ceux qui sont a jour.
--
--  L'ACCOMPAGNEMENT (FR-078 a FR-081) s'adresse a ceux qui n'ont pas compris le
--  dispositif : jamais rien regle, regle puis cesse, regle partiellement. Un
--  redevable qui paie partiellement n'est pas necessairement en retard ; les
--  confondre violerait FR-062 et changerait une explication en reclamation.
--
--  POURQUOI UNE VUE PLUTOT QU'UNE COLONNE. Le motif se deduit des avis et des
--  paiements. Le figer dans une colonne creerait une seconde source de verite,
--  a tenir a jour a chaque encaissement, et qui mentirait le jour ou on
--  oublierait.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  Le motif d'une visite, porte par la ligne de feuille de route : un agent
--  doit savoir ce qu'il vient faire AVANT d'entrer (FR-074).
-- ---------------------------------------------------------------------------
DO $motif$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                    WHERE t.typname = 'motif_visite' AND n.nspname = 'app') THEN
        CREATE TYPE app.motif_visite AS ENUM (
            'fiche_a_completer',
            'jamais_paye',
            'paiement_interrompu',
            'paiement_partiel',
            'echeance_depassee',
            'ajout_superviseur'
        );
    END IF;
END
$motif$;

-- ---------------------------------------------------------------------------
--  La situation de paiement d'une unite imposable.
--
--  « A jour » est la situation par defaut et la plus frequente : elle n'appelle
--  aucune visite, et FR-080 l'exclut des tournees d'accompagnement. Le temps
--  d'un agent vaut mieux que d'aller feliciter quelqu'un qui paie.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_situation_paiement AS
WITH avis AS (
    SELECT a.commerce_id,
           a.commune_id,
           count(*)              AS nb_avis,
           sum(a.montant_total)  AS total_du,
           sum(a.montant_paye)   AS total_paye,
           min(a.date_emission)  AS premier_avis_le
      FROM app.avis_imposition a
     WHERE a.annule_le IS NULL
     GROUP BY a.commerce_id, a.commune_id
),
regles AS (
    SELECT p.commerce_id,
           count(*)        AS nb_paiements,
           max(p.paye_le)  AS dernier_paiement_le
      FROM app.paiement p
     WHERE p.annule_le IS NULL
     GROUP BY p.commerce_id
)
SELECT
    v.commerce_id,
    v.commune_id,
    v.nb_avis,
    coalesce(r.nb_paiements, 0) AS nb_paiements,
    v.total_du,
    v.total_paye,
    v.premier_avis_le,
    r.dernier_paiement_le,
    CASE
        WHEN coalesce(r.nb_paiements, 0) = 0
            THEN 'jamais_paye'::app.motif_visite
        WHEN v.total_paye >= v.total_du
            THEN NULL
        WHEN r.dernier_paiement_le < now() - interval '60 days'
            THEN 'paiement_interrompu'::app.motif_visite
        WHEN coalesce(r.nb_paiements, 0) >= 2
            THEN 'paiement_partiel'::app.motif_visite
        ELSE NULL
    END AS motif_accompagnement
  FROM avis v
  LEFT JOIN regles r ON r.commerce_id = v.commerce_id;

-- ---------------------------------------------------------------------------
--  La feuille de route d'un agent pour un jour.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.feuille_route (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    commune_id    uuid NOT NULL REFERENCES app.commune(id),
    agent_id      uuid NOT NULL REFERENCES app.utilisateur(id),
    date_tournee  date NOT NULL,
    objectif      integer NOT NULL CHECK (objectif >= 0),
    composee_le   timestamptz NOT NULL DEFAULT now(),
    composee_par  uuid REFERENCES app.utilisateur(id),
    UNIQUE (agent_id, date_tournee)
);

-- ---------------------------------------------------------------------------
--  Les lignes. Une ligne retiree n'est pas supprimee : FR-075 exige la trace de
--  l'ajustement, et un superviseur qui retire une visite doit pouvoir en
--  repondre.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.feuille_route_ligne (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    feuille_id    uuid NOT NULL REFERENCES app.feuille_route(id) ON DELETE CASCADE,
    commerce_id   uuid NOT NULL REFERENCES app.commerce(id),
    motif         app.motif_visite NOT NULL,
    ordre         integer NOT NULL,
    ajoutee_par   uuid REFERENCES app.utilisateur(id),
    retiree_le    timestamptz,
    retiree_par   uuid REFERENCES app.utilisateur(id),
    motif_retrait text,
    visite_id     uuid REFERENCES app.visite(id),
    cree_le       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (feuille_id, commerce_id),
    CONSTRAINT retrait_coherent CHECK (
        (retiree_le IS NULL AND retiree_par IS NULL AND motif_retrait IS NULL)
        OR (retiree_le IS NOT NULL AND retiree_par IS NOT NULL AND motif_retrait IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_feuille_route_agent_date
    ON app.feuille_route (agent_id, date_tournee DESC);
CREATE INDEX IF NOT EXISTS idx_feuille_ligne_feuille
    ON app.feuille_route_ligne (feuille_id) WHERE retiree_le IS NULL;

-- ---------------------------------------------------------------------------
--  Isolation par commune.
--
--  feuille_route_ligne ne porte pas la commune : la dupliquer la serait une
--  troisieme source de verite. L'isolation passe par la feuille parente, comme
--  chantier_occupation passe par son chantier.
-- ---------------------------------------------------------------------------
ALTER TABLE app.feuille_route ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.feuille_route;
CREATE POLICY pol_isolation_commune ON app.feuille_route
    FOR ALL
    USING (app.est_super_admin() OR commune_id = app.commune_courante())
    WITH CHECK (app.est_super_admin() OR commune_id = app.commune_courante());

ALTER TABLE app.feuille_route_ligne ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.feuille_route_ligne;
CREATE POLICY pol_isolation_commune ON app.feuille_route_ligne
    FOR ALL
    USING (
        app.est_super_admin()
        OR EXISTS (SELECT 1 FROM app.feuille_route f
                    WHERE f.id = feuille_route_ligne.feuille_id
                      AND f.commune_id = app.commune_courante())
    )
    WITH CHECK (
        app.est_super_admin()
        OR EXISTS (SELECT 1 FROM app.feuille_route f
                    WHERE f.id = feuille_route_ligne.feuille_id
                      AND f.commune_id = app.commune_courante())
    );
