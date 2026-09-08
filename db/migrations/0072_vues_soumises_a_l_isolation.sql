-- ===========================================================================
--  Les vues echappaient a l'isolation par commune
--  Principe II de la constitution (NON NEGOCIABLE)
--
--  CE QUI A ETE CONSTATE. Avec un contexte pointant une commune inexistante :
--
--      SET gtfc.commune_id = '00000000-0000-0000-0000-000000000000';
--      SELECT count(*) FROM app.commerce;           -->  0 lignes
--      SELECT count(*) FROM app.v_commerce_carte;   --> 69 lignes
--
--  La table est protegee, la vue ne l'est pas. Toutes les vues appartiennent a
--  « postgres », qui porte BYPASSRLS ; et une vue s'execute par defaut avec les
--  droits de son PROPRIETAIRE, pas de son appelant. La securite au niveau des
--  lignes ne s'applique donc jamais aux tables lues au travers d'une vue.
--
--  POURQUOI PERSONNE NE L'A VU. Il n'y a qu'une commune. Chaque page du
--  tableau de bord affiche exactement ce qu'elle devrait afficher, et le
--  controle d'isolation existant (app.v_controle_isolation) verifie que les
--  TABLES portent bien leur politique — ce qui est vrai. Le trou n'est pas
--  dans les politiques : il est dans le chemin qui les contourne.
--
--  Le jour de la deuxieme commune, chaque page alimentee par une vue aurait
--  montre les donnees de l'autre. C'est le genre de defaut qui ne se decouvre
--  pas en relisant : il faut poser la question a la base, avec un contexte
--  faux, et regarder ce qu'elle repond.
--
--  LE CORRECTIF. security_invoker = true : la vue s'execute alors avec les
--  droits de celui qui l'interroge, et les politiques de ligne s'appliquent.
--  Applique aux vues qui lisent, directement ou non, une table protegee. Les
--  vues qui ne lisent que les catalogues systeme (controles de schema) sont
--  laissees telles quelles : les y soumettre changerait ce qu'elles mesurent.
-- ===========================================================================

DO $isolation$
DECLARE
    v_vue  record;
    v_nb   integer := 0;
BEGIN
    FOR v_vue IN
        -- Une vue peut lire une table protegee au travers d'une autre vue :
        -- la dependance se remonte donc de proche en proche.
        WITH RECURSIVE dependance AS (
            SELECT v.oid AS vue, d.refobjid AS lu
              FROM pg_class v
              JOIN pg_namespace n ON n.oid = v.relnamespace AND n.nspname = 'app'
              JOIN pg_rewrite r  ON r.ev_class = v.oid
              JOIN pg_depend d   ON d.objid = r.oid
                                AND d.classid = 'pg_rewrite'::regclass
                                AND d.refobjid <> v.oid
             WHERE v.relkind = 'v'
            UNION
            SELECT dep.vue, d.refobjid
              FROM dependance dep
              JOIN pg_rewrite r ON r.ev_class = dep.lu
              JOIN pg_depend d  ON d.objid = r.oid
                               AND d.classid = 'pg_rewrite'::regclass
                               AND d.refobjid <> dep.lu
        )
        SELECT DISTINCT c.relname
          FROM dependance dep
          JOIN pg_class c ON c.oid = dep.vue
          JOIN pg_class t ON t.oid = dep.lu
         WHERE t.relkind IN ('r', 'p')
           AND t.relrowsecurity
         ORDER BY c.relname
    LOOP
        EXECUTE format('ALTER VIEW app.%I SET (security_invoker = true)', v_vue.relname);
        v_nb := v_nb + 1;
    END LOOP;

    RAISE NOTICE 'Vues soumises a l''isolation : %', v_nb;

    IF v_nb = 0 THEN
        RAISE EXCEPTION
            'Aucune vue traitee : la detection des dependances n''a rien trouve, '
            'ce qui est impossible sur ce schema. Migration interrompue.';
    END IF;
END
$isolation$;

-- ===========================================================================
--  Le controle qui empeche le trou de revenir.
--
--  Ajouter une vue est banal ; se souvenir de security_invoker ne l'est pas.
--  Cette vue nomme toute vue qui lit une table protegee sans s'y soumettre.
--  Elle DOIT rester vide, et un test le verifie.
-- ===========================================================================
CREATE OR REPLACE VIEW app.v_controle_vues_isolees AS
WITH RECURSIVE dependance AS (
    SELECT v.oid AS vue, d.refobjid AS lu
      FROM pg_class v
      JOIN pg_namespace n ON n.oid = v.relnamespace AND n.nspname = 'app'
      JOIN pg_rewrite r  ON r.ev_class = v.oid
      JOIN pg_depend d   ON d.objid = r.oid
                        AND d.classid = 'pg_rewrite'::regclass
                        AND d.refobjid <> v.oid
     WHERE v.relkind = 'v'
    UNION
    SELECT dep.vue, d.refobjid
      FROM dependance dep
      JOIN pg_rewrite r ON r.ev_class = dep.lu
      JOIN pg_depend d  ON d.objid = r.oid
                       AND d.classid = 'pg_rewrite'::regclass
                       AND d.refobjid <> dep.lu
)
SELECT DISTINCT
       c.relname AS vue,
       t.relname AS table_protegee,
       'Cette vue lit une table soumise a la RLS sans security_invoker : '
       'elle contourne l''isolation par commune.'::text AS consequence
  FROM dependance dep
  JOIN pg_class c ON c.oid = dep.vue
  JOIN pg_class t ON t.oid = dep.lu
 WHERE t.relkind IN ('r', 'p')
   AND t.relrowsecurity
   AND NOT coalesce(
         (SELECT option_value::boolean
            FROM pg_options_to_table(c.reloptions)
           WHERE option_name = 'security_invoker'), false);

COMMENT ON VIEW app.v_controle_vues_isolees IS
    'DOIT rester vide. Toute ligne est une vue par laquelle on lit les donnees '
    'd''une autre commune.';

GRANT SELECT ON app.v_controle_vues_isolees TO gtfc_app;

-- ---------------------------------------------------------------------------
--  Verification de la migration : le controle doit etre vide immediatement.
-- ---------------------------------------------------------------------------
DO $verif$
DECLARE
    v_restantes text;
BEGIN
    SELECT string_agg(DISTINCT vue, ', ') INTO v_restantes
      FROM app.v_controle_vues_isolees;

    IF v_restantes IS NOT NULL THEN
        RAISE EXCEPTION 'Vues encore hors isolation apres migration : %', v_restantes;
    END IF;
END
$verif$;
