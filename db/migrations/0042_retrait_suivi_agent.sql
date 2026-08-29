-- 0042 — Retrait du suivi de position des agents (FR-051a, FR-051b, SC-029)
--
-- Géolocaliser des employés en continu relève de la loi 2008-12 sur la
-- protection des données à caractère personnel : cela exige une
-- justification, une proportionnalité et l'information des intéressés.
-- Le commanditaire a écarté ce suivi.
--
-- Seules subsistent les positions rattachées à une fiche recensée ou à une
-- visite — celles-là servent à situer une devanture, pas à surveiller
-- quelqu'un.

DROP TABLE    IF EXISTS app.position_agent CASCADE;
DROP FUNCTION IF EXISTS app.creer_partitions_position(integer, integer);

-- Filet : si une table de suivi réapparaissait, la vue échouerait à la
-- création et le rappellerait au développeur.
CREATE OR REPLACE VIEW app.v_conformite_vie_privee AS
    SELECT 'aucun suivi de position d''agent'::text AS controle,
           NOT EXISTS (
               SELECT 1 FROM information_schema.tables
                WHERE table_schema = 'app'
                  AND table_name ~ '^(position_agent|trace_agent|suivi_agent)$'
           ) AS conforme;

COMMENT ON VIEW app.v_conformite_vie_privee IS
'Contrôle de conformité : doit renvoyer conforme = true (FR-051a, SC-029).';
