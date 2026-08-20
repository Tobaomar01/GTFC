-- ===========================================================================
--  0014 — Isolation multi-communes (Row Level Security)
--
--  « Chaque commune dispose d'un espace isolé — ses agents, ses commerces,
--    ses taxes et ses paiements ne se mélangent jamais avec une autre. »
--
--  Cette garantie est posée dans la BASE et non dans l'API. Un oubli de
--  clause WHERE dans un endpoint ne peut donc pas exposer les données d'une
--  autre mairie : PostgreSQL filtre avant que la requête ne remonte.
--
--  L'API positionne à chaque requête, après vérification du JWT :
--      SET LOCAL gtfc.commune_id     = '<uuid de la commune de l'utilisateur>';
--      SET LOCAL gtfc.utilisateur_id = '<uuid de l'utilisateur>';
--      SET LOCAL gtfc.super_admin    = 'on';   -- uniquement pour ce rôle
--
--  SET LOCAL : le réglage disparaît à la fin de la transaction. Une connexion
--  reprise du pool ne conserve donc jamais le contexte de la requête d'avant.
--
--  ATTENTION : sans gtfc.commune_id positionné, le rôle applicatif ne voit
--  AUCUNE ligne. C'est délibéré — un défaut de configuration doit se traduire
--  par « rien », jamais par « tout ».
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Activation sur toutes les tables portant une colonne commune_id
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname AS table_name, n.nspname AS schema_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname IN ('app', 'ref')
          AND c.relkind IN ('r', 'p')            -- table ordinaire ou partitionnée
          AND a.attname = 'commune_id'
          AND NOT a.attisdropped
          AND c.relname <> 'commune'             -- traitée à part (clé = id)
        ORDER BY 1
    LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;',
                       r.schema_name, r.table_name);

        EXECUTE format('DROP POLICY IF EXISTS pol_isolation_commune ON %I.%I;',
                       r.schema_name, r.table_name);

        EXECUTE format($pol$
            CREATE POLICY pol_isolation_commune ON %I.%I
            FOR ALL
            USING       (app.est_super_admin() OR commune_id = app.commune_courante())
            WITH CHECK  (app.est_super_admin() OR commune_id = app.commune_courante());
        $pol$, r.schema_name, r.table_name);
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- app.commune : la clé de rattachement est `id`, pas `commune_id`
-- ---------------------------------------------------------------------------
ALTER TABLE app.commune ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.commune;
CREATE POLICY pol_isolation_commune ON app.commune
    FOR ALL
    USING      (app.est_super_admin() OR id = app.commune_courante())
    WITH CHECK (app.est_super_admin());          -- seul le super-admin crée une commune

-- ---------------------------------------------------------------------------
-- app.utilisateur : commune_id est NULL pour les super-admins.
-- Une mairie ne doit voir ni les super-admins, ni les agents d'ailleurs.
-- ---------------------------------------------------------------------------
ALTER TABLE app.utilisateur ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.utilisateur;
CREATE POLICY pol_isolation_commune ON app.utilisateur
    FOR ALL
    USING (
        app.est_super_admin()
        OR commune_id = app.commune_courante()
        -- Un utilisateur se voit toujours lui-même (page « mon profil »)
        OR id = app.utilisateur_courant()
    )
    WITH CHECK (
        app.est_super_admin()
        OR commune_id = app.commune_courante()
    );

-- ---------------------------------------------------------------------------
-- Tables reliées à la commune par une jointure, sans colonne commune_id
-- ---------------------------------------------------------------------------

-- Lignes d'avis : rattachées via l'avis
ALTER TABLE app.avis_ligne ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.avis_ligne;
CREATE POLICY pol_isolation_commune ON app.avis_ligne
    FOR ALL
    USING (app.est_super_admin() OR EXISTS (
        SELECT 1 FROM app.avis_imposition a
        WHERE a.id = avis_ligne.avis_id AND a.commune_id = app.commune_courante()))
    WITH CHECK (app.est_super_admin() OR EXISTS (
        SELECT 1 FROM app.avis_imposition a
        WHERE a.id = avis_ligne.avis_id AND a.commune_id = app.commune_courante()));

-- Tranches de barème : rattachées via le barème
ALTER TABLE app.bareme_tranche ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.bareme_tranche;
CREATE POLICY pol_isolation_commune ON app.bareme_tranche
    FOR ALL
    USING (app.est_super_admin() OR EXISTS (
        SELECT 1 FROM app.bareme_taxe b
        WHERE b.id = bareme_tranche.bareme_id AND b.commune_id = app.commune_courante()))
    WITH CHECK (app.est_super_admin() OR EXISTS (
        SELECT 1 FROM app.bareme_taxe b
        WHERE b.id = bareme_tranche.bareme_id AND b.commune_id = app.commune_courante()));

-- Catégories : rattachées à la commune, mais dans le schéma ref
-- (déjà couvertes par la boucle ci-dessus grâce à leur colonne commune_id)

-- Affectations d'agents : rattachées via l'utilisateur
ALTER TABLE app.affectation_agent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.affectation_agent;
CREATE POLICY pol_isolation_commune ON app.affectation_agent
    FOR ALL
    USING (app.est_super_admin() OR EXISTS (
        SELECT 1 FROM app.utilisateur u
        WHERE u.id = affectation_agent.utilisateur_id AND u.commune_id = app.commune_courante()))
    WITH CHECK (app.est_super_admin() OR EXISTS (
        SELECT 1 FROM app.utilisateur u
        WHERE u.id = affectation_agent.utilisateur_id AND u.commune_id = app.commune_courante()));

-- Sessions : un utilisateur ne voit que les siennes
ALTER TABLE app.session ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_session_proprietaire ON app.session;
CREATE POLICY pol_session_proprietaire ON app.session
    FOR ALL
    USING (app.est_super_admin() OR utilisateur_id = app.utilisateur_courant()
           OR EXISTS (SELECT 1 FROM app.utilisateur u
                      WHERE u.id = session.utilisateur_id
                        AND u.commune_id = app.commune_courante()))
    WITH CHECK (true);   -- l'API crée une session avant que le contexte ne soit posé

-- ---------------------------------------------------------------------------
-- Journal d'audit : lecture filtrée par commune, écriture toujours permise.
-- Écrire dans le journal ne doit JAMAIS échouer, sinon une action métier
-- pourrait passer sans laisser de trace — exactement ce qu'on veut éviter.
-- ---------------------------------------------------------------------------
ALTER TABLE audit.journal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_audit_lecture  ON audit.journal;
DROP POLICY IF EXISTS pol_audit_ecriture ON audit.journal;

CREATE POLICY pol_audit_lecture ON audit.journal
    FOR SELECT
    USING (app.est_super_admin() OR commune_id = app.commune_courante());

CREATE POLICY pol_audit_ecriture ON audit.journal
    FOR INSERT
    WITH CHECK (true);

ALTER TABLE audit.connexion ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_connexion_lecture  ON audit.connexion;
DROP POLICY IF EXISTS pol_connexion_ecriture ON audit.connexion;
CREATE POLICY pol_connexion_lecture ON audit.connexion
    FOR SELECT USING (app.est_super_admin() OR commune_id = app.commune_courante());
CREATE POLICY pol_connexion_ecriture ON audit.connexion
    FOR INSERT WITH CHECK (true);

ALTER TABLE audit.export ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_export_lecture  ON audit.export;
DROP POLICY IF EXISTS pol_export_ecriture ON audit.export;
CREATE POLICY pol_export_lecture ON audit.export
    FOR SELECT USING (app.est_super_admin() OR commune_id = app.commune_courante());
CREATE POLICY pol_export_ecriture ON audit.export
    FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- ref.type_taxe est un référentiel GLOBAL : lisible par toutes les communes,
-- modifiable par le seul super-admin.
-- ---------------------------------------------------------------------------
ALTER TABLE ref.type_taxe ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_type_taxe_lecture ON ref.type_taxe;
DROP POLICY IF EXISTS pol_type_taxe_ecriture ON ref.type_taxe;
CREATE POLICY pol_type_taxe_lecture  ON ref.type_taxe FOR SELECT USING (true);
CREATE POLICY pol_type_taxe_ecriture ON ref.type_taxe FOR ALL
    USING (app.est_super_admin()) WITH CHECK (app.est_super_admin());

-- ---------------------------------------------------------------------------
-- Vérification : lister ce qui est protégé et ce qui ne l'est pas
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_controle_isolation AS
SELECT
    n.nspname                                    AS schema,
    c.relname                                    AS table_name,
    c.relrowsecurity                             AS rls_active,
    count(p.polname)                             AS nb_politiques,
    CASE
        WHEN c.relrowsecurity THEN 'protégée'
        WHEN EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'commune_id'
                       AND NOT a.attisdropped) THEN 'À VÉRIFIER — colonne commune_id sans RLS'
        ELSE 'référentiel global'
    END                                          AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname IN ('app', 'ref', 'audit')
  AND c.relkind IN ('r', 'p')
  AND c.relname NOT LIKE 'journal_%'
  AND c.relname NOT LIKE 'position_agent_%'
GROUP BY n.nspname, c.relname, c.relrowsecurity, c.oid
ORDER BY 1, 2;

COMMENT ON VIEW app.v_controle_isolation IS
'Tableau de bord de l''isolation multi-communes. Toute ligne « À VÉRIFIER » est une fuite potentielle entre communes.';
