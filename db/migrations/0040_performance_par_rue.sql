-- ===========================================================================
--  0040 — Le taux de collecte par rue
--
--  Le document décrit ce que la phase 0 débloque, et cette vue en est la
--  pièce centrale : « le taux de collecte par rue en régime établi —
--  montant encaissé sur montant dû, redevables à jour, partiels et impayés ».
--
--  POURQUOI PAR RUE, ET PAS PAR ZONE
--
--  Une zone regroupe des milliers de commerces : son taux de recouvrement
--  est une moyenne qui ne désigne personne. Une rue en compte quelques
--  dizaines, et un taux bas y désigne quelque chose de concret — un
--  quartier de marché mal couvert, une tournée jamais faite, un agent en
--  difficulté sur un secteur.
--
--  C'est aussi l'unité à laquelle on peut agir : on affecte un agent à une
--  rue, pas à un tiers de commune.
--
--  CE QUE LA VUE NE FAIT PAS
--
--  Elle ne juge pas. Une rue à 40 % peut être une rue difficile ou une rue
--  oubliée ; c'est au superviseur de le savoir. Elle donne donc AUSSI le
--  nombre de redevables et la date du dernier encaissement, sans lesquels
--  un pourcentage isolé induit en erreur : 100 % sur deux redevables ne dit
--  rien, et 60 % sur quatre-vingts dit beaucoup.
-- ===========================================================================

CREATE OR REPLACE VIEW app.v_performance_rue AS
WITH objets AS (
    -- Les redevables présents dans la rue, quel que soit l'objet qui les y
    -- rattache : un panneau de régie compte autant qu'une boutique.
    SELECT c.rue_id, c.redevable_id
      FROM app.commerce c
     WHERE c.rue_id IS NOT NULL AND c.archive_le IS NULL
    UNION
    SELECT d.rue_id, d.redevable_id
      FROM app.dispositif_affichage d
     WHERE d.rue_id IS NOT NULL AND d.archive_le IS NULL
       AND d.redevable_id IS NOT NULL
),
par_rue AS (
    SELECT o.rue_id,
           count(DISTINCT o.redevable_id) AS nb_redevables,
           count(DISTINCT o.redevable_id) FILTER (WHERE r.statut_fiscal = 'a_jour')  AS nb_a_jour,
           count(DISTINCT o.redevable_id) FILTER (WHERE r.statut_fiscal = 'partiel') AS nb_partiels,
           count(DISTINCT o.redevable_id) FILTER (WHERE r.statut_fiscal = 'impaye')  AS nb_impayes,
           coalesce(sum(DISTINCT_montant.du), 0)    AS montant_du,
           coalesce(sum(DISTINCT_montant.paye), 0)  AS montant_paye
      FROM objets o
      JOIN app.redevable r ON r.id = o.redevable_id
      -- Les montants se prennent UNE FOIS par redevable : un tailleur avec
      -- deux boutiques dans la même rue ne doit pas voir sa facture comptée
      -- deux fois.
      LEFT JOIN LATERAL (
          SELECT coalesce(sum(a.montant_total), 0) AS du,
                 coalesce(sum(a.montant_paye), 0)  AS paye
            FROM app.avis_imposition a
           WHERE a.redevable_id = r.id
             AND a.annule_le IS NULL
             AND a.statut <> 'brouillon'
      ) AS DISTINCT_montant ON true
     GROUP BY o.rue_id
)
SELECT ru.commune_id,
       ru.id            AS rue_id,
       ru.code,
       ru.nom,
       q.nom            AS quartier,
       z.nom            AS zone,
       ru.statut_couverture,
       (ru.geom IS NOT NULL) AS tracee,
       coalesce(p.nb_redevables, 0) AS nb_redevables,
       coalesce(p.nb_a_jour, 0)     AS nb_a_jour,
       coalesce(p.nb_partiels, 0)   AS nb_partiels,
       coalesce(p.nb_impayes, 0)    AS nb_impayes,
       coalesce(p.montant_du, 0)    AS montant_du,
       coalesce(p.montant_paye, 0)  AS montant_paye,
       coalesce(p.montant_du, 0) - coalesce(p.montant_paye, 0) AS montant_restant,
       -- NULL plutôt que 0 quand rien n'est dû : une rue sans facture émise
       -- n'a pas un taux de recouvrement de zéro, elle n'en a pas.
       CASE WHEN coalesce(p.montant_du, 0) > 0
            THEN round(100.0 * p.montant_paye / p.montant_du)::integer
            ELSE NULL END AS taux_recouvrement_pct
  FROM app.rue ru
  LEFT JOIN par_rue p     ON p.rue_id = ru.id
  LEFT JOIN app.quartier q ON q.id = ru.quartier_id
  LEFT JOIN app.zone z     ON z.id = ru.zone_id
 WHERE ru.archive_le IS NULL AND ru.actif;

COMMENT ON VIEW app.v_performance_rue IS
'Taux de collecte par rue — montant encaissé sur montant dû, et répartition des redevables. Le taux est NULL quand rien n''est dû : une rue sans facture n''a pas un recouvrement de 0 %.';

-- ---------------------------------------------------------------------------
-- Le tracé, pour la carte
--
--  Renvoyé séparément et en GeoJSON : les géométries pèsent lourd, et la
--  liste du tableau n'en a pas besoin. La carte, elle, ne charge que ça.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.rues_geojson(p_commune uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', coalesce(jsonb_agg(
            jsonb_build_object(
                'type', 'Feature',
                'geometry', ST_AsGeoJSON(p.geom)::jsonb,
                'properties', jsonb_build_object(
                    'rue_id', p.rue_id,
                    'code', p.code,
                    'nom', p.nom,
                    'quartier', p.quartier,
                    'statut_couverture', p.statut_couverture,
                    'nb_redevables', p.nb_redevables,
                    'nb_a_jour', p.nb_a_jour,
                    'nb_partiels', p.nb_partiels,
                    'nb_impayes', p.nb_impayes,
                    'montant_du', p.montant_du,
                    'montant_restant', p.montant_restant,
                    'taux_recouvrement_pct', p.taux_recouvrement_pct
                )
            )
        ), '[]'::jsonb)
    )
    FROM (
        SELECT v.*, ru.geom
          FROM app.v_performance_rue v
          JOIN app.rue ru ON ru.id = v.rue_id
         WHERE v.commune_id = p_commune AND ru.geom IS NOT NULL
    ) p;
$$;

COMMENT ON FUNCTION app.rues_geojson(uuid) IS
'Tracés des rues avec leur performance, en GeoJSON. Séparé de la vue tabulaire : la géométrie pèse lourd et n''intéresse que la carte.';
