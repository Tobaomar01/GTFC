-- ===========================================================================
--  Sept objets etaient illisibles par le role applicatif
--
--  CE QUI A ETE CONSTATE le 09/09/2026, sur une base reconstruite par
--  db/migrate.sh — le chemin employe en production :
--
--      app.decision_derogatoire       (TABLE)
--      app.v_exoneration_opposable
--      app.v_montant_force_opposable
--      app.v_objets_sans_redevable
--      app.v_performance_rue
--      app.v_regularite_prorata
--      app.v_tables_exigeant_commerce
--
--  Six tests tombaient : « le maire voit la recette de sa commune », « le chef
--  de projet accede au registre des derogations », « valider une derogation
--  reste ouvert au maire »… avec pour message
--
--      permission denied for view v_objets_sans_redevable
--
--  Et le plus grave n'est pas une vue : app.decision_derogatoire est la TABLE
--  des derogations. Sur une base neuve, la fonctionnalite entiere etait
--  inaccessible a l'application.
--
--  LA CAUSE, ET ELLE EST STRUCTURELLE.
--
--  Les droits sont accordes UNE FOIS, en migration 0016, par
--
--      GRANT ... ON ALL TABLES IN SCHEMA app, ref TO gtfc_app
--
--  « ALL TABLES » ne vaut que pour ce qui existe A CET INSTANT. Tout objet cree
--  par une migration ULTERIEURE — et il y en a soixante-cinq depuis — n'est
--  jamais couvert, sauf si sa propre migration pense a le faire. Sept ne l'ont
--  pas fait.
--
--  Rien ne le signalait : la base de travail, construite au fil des mois, avait
--  recu ces droits d'une facon ou d'une autre. Seule une base RECONSTRUITE
--  montre le manque — et c'est exactement celle qu'on deploiera.
--
--  CE QUE FAIT CETTE MIGRATION. Elle rattrape l'existant, et pose le controle
--  qui empeche le manque de revenir : ajouter une vue sans y penser est banal,
--  s'en apercevoir six mois plus tard ne l'est pas.
-- ===========================================================================

DO $droits$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        RAISE NOTICE 'Le role gtfc_app n''existe pas — rattrapage ignore.';
        RETURN;
    END IF;

    EXECUTE 'GRANT USAGE ON SCHEMA app, ref, audit, public TO gtfc_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, ref TO gtfc_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, ref TO gtfc_app';

    -- Le journal reste en ajout seul : lire et ecrire, jamais modifier ni
    -- effacer. C'est la regle de 0016, reprise a l'identique.
    EXECUTE 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO gtfc_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA audit FROM gtfc_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO gtfc_app';

    RAISE NOTICE 'Droits applicatifs rattrapes sur tous les objets existants.';
END
$droits$;

-- ---------------------------------------------------------------------------
--  Le controle qui empeche le manque de revenir.
--
--  Toute table ou vue de app, ref ou audit que le role applicatif ne peut pas
--  lire est nommee ici. La vue DOIT rester vide, et un test le verifie : c'est
--  la seule facon de s'apercevoir d'un oubli le jour meme, et non le jour du
--  deploiement.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW app.v_controle_droits_applicatifs AS
SELECT n.nspname                          AS schema,
       c.relname                          AS objet,
       CASE c.relkind WHEN 'v' THEN 'vue' WHEN 'p' THEN 'table partitionnee'
                      ELSE 'table' END    AS nature,
       'Le rôle applicatif ne peut pas lire cet objet : toute page ou route qui '
       's''en sert répondra « permission denied ».'::text AS consequence
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('app', 'ref', 'audit')
   AND c.relkind IN ('r', 'v', 'p')
   AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app')
   AND NOT has_table_privilege('gtfc_app', c.oid, 'SELECT');

COMMENT ON VIEW app.v_controle_droits_applicatifs IS
    'DOIT rester vide. Chaque ligne est un objet que l''application ne peut pas '
    'lire, et donc une page qui repondra « permission denied » en production.';

ALTER VIEW app.v_controle_droits_applicatifs SET (security_invoker = true);
GRANT SELECT ON app.v_controle_droits_applicatifs TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Verification immediate.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_restants text;
BEGIN
    SELECT string_agg(schema || '.' || objet, ', ') INTO v_restants
      FROM app.v_controle_droits_applicatifs;

    IF v_restants IS NOT NULL THEN
        RAISE EXCEPTION 'Objets encore illisibles par gtfc_app : %', v_restants;
    END IF;

    RAISE NOTICE 'Tous les objets de app, ref et audit sont lisibles par gtfc_app.';
END
$verif$;
