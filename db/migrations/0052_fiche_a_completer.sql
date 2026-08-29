-- 0052 — Fiches à reprendre au second passage
--
-- L'agent travaille en ligne et les boutiques sont ouvertes. Quand le gérant
-- est absent, la fiche doit être marquée « à refaire plus tard » : elle vaut
-- mieux que rien — la devanture est recensée, géolocalisée, taxée — mais elle
-- n'est pas exploitable en l'état.
--
-- Deux manques la rendent inexploitable, pour deux raisons différentes :
--
--   · sans NUMÉRO, le redevable est hors d'atteinte. Le pilote n'a qu'un canal
--     de recouvrement, le SMS mensuel portant le lien Wave. Une fiche sans
--     numéro ne rapportera jamais un franc, quelle que soit la qualité du
--     reste ;
--   · sans NOM de gérant, le déclencheur de rattachement désigne le redevable
--     par son enseigne. Le dossier existe et se retrouve au guichet, mais un
--     avis d'imposition adressé à une enseigne n'est pas opposable à une
--     personne.
--
-- La colonne est CALCULÉE, pas saisie. Un indicateur qu'on met à jour à la
-- main finit toujours par mentir : il resterait allumé après complétion, ou
-- éteint sur une fiche vidée par une correction. Ici il suit la donnée.

ALTER TABLE app.commerce
    ADD COLUMN IF NOT EXISTS fiche_a_completer boolean
    GENERATED ALWAYS AS (
        gerant_nom IS NULL
        OR nullif(btrim(gerant_nom), '') IS NULL
        OR coalesce(nullif(btrim(telephone_paiement), ''),
                    nullif(btrim(gerant_telephone), '')) IS NULL
    ) STORED;

COMMENT ON COLUMN app.commerce.fiche_a_completer IS
  'Vrai tant qu''il manque le nom du gérant ou un numéro de téléphone. '
  'Calculée : se rallume si une correction vide l''un des deux.';

CREATE INDEX IF NOT EXISTS idx_commerce_a_completer
    ON app.commerce (commune_id, fiche_a_completer)
    WHERE fiche_a_completer AND archive_le IS NULL;

-- La liste de travail du second passage. Triée par ancienneté : une fiche
-- laissée trois semaines est plus urgente qu'une fiche d'hier, parce que
-- l'agent se souvient encore de la boutique d'hier.
CREATE OR REPLACE VIEW app.v_fiche_a_completer AS
SELECT c.id,
       c.commune_id,
       c.code,
       c.enseigne,
       c.gerant_nom,
       coalesce(c.telephone_paiement, c.gerant_telephone) AS telephone,
       c.adresse_libelle,
       c.point_repere,
       c.date_recensement,
       (current_date - c.date_recensement)          AS jours_depuis_recensement,
       c.agent_recenseur_id,
       u.nom_complet                                 AS agent_recenseur,
       q.nom                                         AS quartier,
       r.nom                                         AS rue,
       CASE
           WHEN c.gerant_nom IS NULL
            AND coalesce(c.telephone_paiement, c.gerant_telephone) IS NULL
               THEN 'nom et numéro'
           WHEN coalesce(c.telephone_paiement, c.gerant_telephone) IS NULL
               THEN 'numéro'
           ELSE 'nom du gérant'
       END                                           AS manque,
       -- Sans numéro la fiche ne rapporte rien : c'est ce qui décide de
       -- l'ordre de reprise, avant même l'ancienneté.
       (coalesce(c.telephone_paiement, c.gerant_telephone) IS NULL) AS bloque_le_recouvrement
  FROM app.commerce c
  LEFT JOIN app.utilisateur u ON u.id = c.agent_recenseur_id
  LEFT JOIN app.quartier q    ON q.id = c.quartier_id
  LEFT JOIN app.rue r         ON r.id = c.rue_id
 WHERE c.fiche_a_completer
   AND c.archive_le IS NULL
   AND c.statut NOT IN ('archive', 'ferme_definitif');

COMMENT ON VIEW app.v_fiche_a_completer IS
  'Fiches recensées mais incomplètes, à reprendre au second passage. '
  'Doit être vidée des lignes « bloque_le_recouvrement » avant émission des avis.';

GRANT SELECT ON app.v_fiche_a_completer TO gtfc_app;
