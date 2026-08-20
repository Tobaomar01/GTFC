-- ===========================================================================
--  0030 — Isolation et droits sur les tables du modèle « redevable »
--
--  À REJOUER APRÈS TOUTE MIGRATION QUI CRÉE UNE TABLE.
--
--  Sans ce fichier, les huit tables ajoutées entre 0021 et 0029 seraient
--  dans le pire état possible :
--
--   · aucune politique d'isolation — un défaut de clause WHERE dans l'API
--     exposerait les redevables d'une autre commune ;
--   · aucun droit pour gtfc_app — l'API recevrait « permission denied »
--     sur app.redevable, c'est-à-dire sur à peu près tout.
--
--  Le premier défaut est silencieux et grave, le second est bruyant et
--  bénin. C'est le premier qui justifie que cette migration existe.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Row Level Security sur toute table portant commune_id
--    Même boucle qu'en 0014 : elle est idempotente et rattrape les nouvelles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r        record;
    v_ajouts integer := 0;
BEGIN
    FOR r IN
        SELECT c.relname AS table_name, n.nspname AS schema_name,
               c.relrowsecurity AS deja_active
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname IN ('app', 'ref')
          AND c.relkind IN ('r', 'p')
          AND a.attname = 'commune_id'
          AND NOT a.attisdropped
          AND c.relname <> 'commune'
        ORDER BY 1
    LOOP
        IF NOT r.deja_active THEN v_ajouts := v_ajouts + 1; END IF;

        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;',
                       r.schema_name, r.table_name);
        EXECUTE format('DROP POLICY IF EXISTS pol_isolation_commune ON %I.%I;',
                       r.schema_name, r.table_name);
        EXECUTE format($pol$
            CREATE POLICY pol_isolation_commune ON %I.%I
            FOR ALL
            USING      (app.est_super_admin() OR commune_id = app.commune_courante())
            WITH CHECK (app.est_super_admin() OR commune_id = app.commune_courante());
        $pol$, r.schema_name, r.table_name);
    END LOOP;

    RAISE NOTICE 'Isolation : % table(s) nouvellement protégée(s).', v_ajouts;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Table de liaison sans commune_id
--
--  app.chantier_occupation ne porte pas la commune : la dupliquer là serait
--  une troisième source de vérité, qu'un jour quelqu'un oublierait de tenir
--  à jour. L'isolation passe donc par le chantier parent.
-- ---------------------------------------------------------------------------
ALTER TABLE app.chantier_occupation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pol_isolation_commune ON app.chantier_occupation;
CREATE POLICY pol_isolation_commune ON app.chantier_occupation
    FOR ALL
    USING (
        app.est_super_admin()
        OR EXISTS (SELECT 1 FROM app.chantier ch
                    WHERE ch.id = chantier_occupation.chantier_id
                      AND ch.commune_id = app.commune_courante())
    )
    WITH CHECK (
        app.est_super_admin()
        OR EXISTS (SELECT 1 FROM app.chantier ch
                    WHERE ch.id = chantier_occupation.chantier_id
                      AND ch.commune_id = app.commune_courante())
    );

-- ---------------------------------------------------------------------------
-- 3. Droits du rôle applicatif
--
--  GRANT ... ON ALL TABLES ne vaut que pour les tables existant au moment où
--  il est exécuté : les nouvelles ne sont pas couvertes par le 0016.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, ref TO gtfc_app';
        EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, ref TO gtfc_app';
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app, ref TO gtfc_app';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_readonly') THEN
        EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA app, ref TO gtfc_readonly';
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO gtfc_readonly';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 4. Vérification : aucune table à commune_id ne doit rester sans politique
--
--  Un contrôle plutôt qu'une confiance. Si une table échappe à la boucle —
--  parce qu'elle aura été créée dans un schéma inattendu, par exemple —
--  la migration échoue ici, et non six mois plus tard sur une fuite.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_nues text;
BEGIN
    SELECT string_agg(n.nspname || '.' || c.relname, ', ' ORDER BY c.relname)
      INTO v_nues
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname IN ('app', 'ref')
       AND c.relkind IN ('r', 'p')
       AND a.attname = 'commune_id'
       AND NOT a.attisdropped
       AND c.relname <> 'commune'
       AND (NOT c.relrowsecurity
            OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));

    IF v_nues IS NOT NULL THEN
        RAISE EXCEPTION 'Tables sans isolation par commune : %', v_nues;
    END IF;
END
$$;
