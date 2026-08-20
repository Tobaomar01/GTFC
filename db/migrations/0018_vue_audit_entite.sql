-- ===========================================================================
--  0018 — Correction de la vue du journal d'audit
--
--  La vue app.v_journal_audit (migration 0015) n'exposait pas `entite_id`.
--  Conséquence : impossible de répondre à la question la plus courante d'un
--  contrôle — « qui a touché à CETTE fiche ? » — puisqu'on ne pouvait pas
--  filtrer sur l'identifiant de l'enregistrement concerné.
--
--  Défaut détecté par les tests de bout en bout de la phase 3.
--
--  DROP + CREATE plutôt que CREATE OR REPLACE : ce dernier n'autorise pas
--  l'insertion d'une colonne ailleurs qu'à la fin de la liste.
-- ===========================================================================

DROP VIEW IF EXISTS app.v_journal_audit;

CREATE VIEW app.v_journal_audit AS
SELECT
    j.id,
    j.commune_id,
    j.horodatage,
    j.action,
    j.entite,
    j.entite_id,                       -- colonne ajoutée
    j.entite_libelle,
    coalesce(j.utilisateur_nom, 'système')  AS auteur,
    j.utilisateur_id,                  -- utile pour filtrer par agent
    j.utilisateur_role                 AS role,
    j.ip,
    j.champs_modifies,
    j.montant,
    j.reference,
    j.motif,
    ST_X(j.geom)                       AS longitude,
    ST_Y(j.geom)                       AS latitude,
    j.valeurs_avant,
    j.valeurs_apres
FROM audit.journal j;

COMMENT ON VIEW app.v_journal_audit IS
'Journal d''audit lisible. Filtrable par entite + entite_id pour reconstituer l''historique complet d''une fiche.';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        EXECUTE 'GRANT SELECT ON app.v_journal_audit TO gtfc_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_readonly') THEN
        EXECUTE 'GRANT SELECT ON app.v_journal_audit TO gtfc_readonly';
    END IF;
END
$$;
