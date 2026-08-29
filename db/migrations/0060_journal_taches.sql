-- 0060 — Une tâche automatique qui échoue doit laisser une trace
--
-- Douze tâches tournent sans personne : partitions mensuelles, pénalités,
-- facturation, notifications, quittances, purges. Elles s'exécutent à une
-- heure du matin, à deux heures, à trois heures et demie.
--
-- Quand l'une échoue, le planificateur l'attrape et poursuit — c'est voulu,
-- une tâche fautive ne doit pas emporter les onze autres. Mais l'échec ne
-- laissait qu'UNE LIGNE DE JOURNAL, sur un serveur que personne ne lit à
-- trois heures du matin. Une tâche pouvait échouer toutes les nuits pendant
-- des mois sans que rien ne le dise.
--
-- Ce que cela coûte n'est pas théorique. Si la création des partitions
-- échoue, le journal d'audit refuse toute écriture le premier du mois suivant
-- — donc tout le système s'arrête. Si la facturation échoue, aucun avis ne
-- part et personne ne s'en aperçoit avant la fin du mois.
--
-- Chaque exécution est donc consignée : ce qui a tourné, quand, combien de
-- temps, ce qu'elle a produit, et ce qui a échoué. Une requête suffit alors à
-- répondre à « tout s'est-il bien passé cette nuit ? ».

CREATE TABLE IF NOT EXISTS app.tache_planifiee (
    id           bigserial PRIMARY KEY,
    tache        text        NOT NULL,
    debute_le    timestamptz NOT NULL DEFAULT now(),
    termine_le   timestamptz,
    duree_ms     integer,
    succes       boolean,
    resultat     jsonb,
    erreur       text,
    -- Le déclencheur : le planificateur, ou une main humaine.
    origine      text        NOT NULL DEFAULT 'planificateur'
                 CHECK (origine IN ('planificateur', 'manuel'))
);

CREATE INDEX IF NOT EXISTS idx_tache_recente
    ON app.tache_planifiee (tache, debute_le DESC);
CREATE INDEX IF NOT EXISTS idx_tache_echecs
    ON app.tache_planifiee (debute_le DESC) WHERE succes = false;

COMMENT ON TABLE app.tache_planifiee IS
  'Journal des exécutions automatiques. Sans lui, une tâche qui échoue toutes '
  'les nuits ne laisse qu''une ligne dans un fichier que personne ne lit.';

-- La dernière exécution de chaque tâche, et depuis combien de temps.
CREATE OR REPLACE VIEW app.v_sante_taches AS
SELECT DISTINCT ON (t.tache)
       t.tache,
       t.debute_le      AS derniere_execution,
       t.succes,
       t.duree_ms,
       t.erreur,
       round(EXTRACT(epoch FROM now() - t.debute_le) / 3600.0, 1) AS heures_depuis,
       (SELECT count(*) FROM app.tache_planifiee e
         WHERE e.tache = t.tache AND NOT e.succes
           AND e.debute_le > now() - interval '7 days')          AS echecs_7j
  FROM app.tache_planifiee t
 ORDER BY t.tache, t.debute_le DESC;

COMMENT ON VIEW app.v_sante_taches IS
  'Où en est chaque tâche automatique. Une tâche absente de cette vue n''a '
  'jamais tourné ; une tâche dont l''heure remonte à trop loin ne tourne plus.';

GRANT SELECT, INSERT, UPDATE ON app.tache_planifiee TO gtfc_app;
GRANT USAGE, SELECT ON SEQUENCE app.tache_planifiee_id_seq TO gtfc_app;
GRANT SELECT ON app.v_sante_taches TO gtfc_app;
