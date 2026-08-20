-- ===========================================================================
--  0016 — Droits applicatifs et finalisation
--
--  Les privilèges par défaut posés à la phase 1 (init/02-app-role.sh)
--  couvrent déjà les objets créés par les migrations. On les réaffirme ici
--  pour que la base soit correcte même après une restauration effectuée avec
--  --no-privileges, et pour que les fonctions soient bien exécutables.
-- ===========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_app') THEN
        RAISE NOTICE 'Le rôle gtfc_app n''existe pas — droits applicatifs ignorés.';
        RETURN;
    END IF;

    -- Schémas
    EXECUTE 'GRANT USAGE ON SCHEMA app, ref, audit, public TO gtfc_app';

    -- Données métier : lecture/écriture
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, ref TO gtfc_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, ref TO gtfc_app';

    -- Journal d'audit : ajout seulement, jamais de modification ni de purge
    EXECUTE 'GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO gtfc_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA audit FROM gtfc_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit TO gtfc_app';

    -- Le suivi des migrations appartient à l'exploitation, pas à l'application.
    -- La table est créée par db/migrate.sh : elle peut être absente si l'on
    -- rejoue les fichiers SQL à la main.
    IF to_regclass('app.schema_migration') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON app.schema_migration FROM gtfc_app';
        EXECUTE 'GRANT SELECT ON app.schema_migration TO gtfc_app';
    END IF;

    -- Fonctions métier
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app, ref, audit TO gtfc_app';

    -- Les barèmes engagent juridiquement la commune : ils se modifient depuis
    -- le dashboard super-admin, hors du chemin applicatif courant.
    EXECUTE 'REVOKE DELETE ON app.bareme_taxe, app.bareme_tranche FROM gtfc_app';
END
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_readonly') THEN
        EXECUTE 'GRANT USAGE  ON SCHEMA app, ref, audit TO gtfc_readonly';
        EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA app, ref, audit TO gtfc_readonly';
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO gtfc_readonly';
    END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Statistiques du planificateur
--
-- Le planificateur suppose par défaut que deux colonnes sont indépendantes.
-- Ici elles ne le sont pas du tout : un quartier appartient à une seule zone.
-- Sans cette déclaration, PostgreSQL sous-estime massivement le nombre de
-- lignes des requêtes filtrant sur les deux, et choisit de mauvais plans.
-- ---------------------------------------------------------------------------
DROP STATISTICS IF EXISTS app.stat_commerce_territoire;
CREATE STATISTICS app.stat_commerce_territoire (dependencies, ndistinct)
    ON commune_id, zone_id, quartier_id FROM app.commerce;

DROP STATISTICS IF EXISTS app.stat_commerce_statut;
CREATE STATISTICS app.stat_commerce_statut (dependencies)
    ON commune_id, statut, statut_fiscal FROM app.commerce;

DROP STATISTICS IF EXISTS app.stat_avis;
CREATE STATISTICS app.stat_avis (dependencies)
    ON commune_id, periode_id, statut FROM app.avis_imposition;

ANALYZE app.commerce;
ANALYZE app.avis_imposition;

-- ---------------------------------------------------------------------------
-- Contrôle de cohérence, à lancer après toute reprise de données
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.verifier_coherence(p_commune_id uuid DEFAULT NULL)
RETURNS TABLE (gravite text, controle text, nb bigint, detail text)
LANGUAGE sql STABLE
AS $$
    -- Commerces sans coordonnées : invisibles sur la carte
    SELECT 'avertissement', 'commerces sans position GPS', count(*),
           'Ces commerces n''apparaissent pas sur la carte du dashboard'
    FROM app.commerce c
    WHERE c.archive_le IS NULL AND c.geom IS NULL
      AND (p_commune_id IS NULL OR c.commune_id = p_commune_id)
    HAVING count(*) > 0

UNION ALL
    -- Commerces hors des limites communales
    SELECT 'erreur', 'commerces hors commune', count(*),
           'Coordonnées relevées en dehors du territoire — probable inversion latitude/longitude'
    FROM app.commerce c
    JOIN app.commune m ON m.id = c.commune_id
    WHERE c.archive_le IS NULL AND c.geom IS NOT NULL AND m.geom IS NOT NULL
      AND NOT ST_DWithin(m.geom::geography, c.geom::geography, 500)
      AND (p_commune_id IS NULL OR c.commune_id = p_commune_id)
    HAVING count(*) > 0

UNION ALL
    -- Commerces sans aucune taxe : ils ne seront jamais facturés
    SELECT 'erreur', 'commerces sans taxe active', count(*),
           'Aucun avis d''imposition ne sera généré pour ces commerces'
    FROM app.commerce c
    WHERE c.archive_le IS NULL AND c.statut = 'actif'
      AND NOT EXISTS (SELECT 1 FROM app.commerce_taxe ct
                      WHERE ct.commerce_id = c.id AND ct.actif)
      AND (p_commune_id IS NULL OR c.commune_id = p_commune_id)
    HAVING count(*) > 0

UNION ALL
    -- Taxes actives sans barème en vigueur : la facturation échouera
    SELECT 'erreur', 'taxes sans barème en vigueur', count(DISTINCT ct.type_taxe_id),
           'La génération des avis échouera pour les commerces concernés'
    FROM app.commerce_taxe ct
    WHERE ct.actif
      AND NOT EXISTS (SELECT 1 FROM app.bareme_taxe b
                      WHERE b.commune_id = ct.commune_id
                        AND b.type_taxe_id = ct.type_taxe_id
                        AND b.periode @> current_date)
      AND (p_commune_id IS NULL OR ct.commune_id = p_commune_id)
    HAVING count(*) > 0

UNION ALL
    -- Commerces sans QR code actif : impossible d'apposer un sticker
    SELECT 'avertissement', 'commerces sans QR code actif', count(*),
           'Aucun sticker imprimable pour ces commerces'
    FROM app.commerce c
    WHERE c.archive_le IS NULL AND c.statut = 'actif'
      AND NOT EXISTS (SELECT 1 FROM app.qr_code q WHERE q.commerce_id = c.id AND q.actif)
      AND (p_commune_id IS NULL OR c.commune_id = p_commune_id)
    HAVING count(*) > 0

UNION ALL
    -- Espèces encaissées et non versées depuis plus de 3 jours
    SELECT 'erreur', 'espèces non versées depuis plus de 3 jours', count(*),
           'À rapprocher d''urgence avec la caisse de la mairie'
    FROM app.paiement p
    WHERE p.moyen = 'especes' AND p.verse_en_caisse_le IS NULL AND p.annule_le IS NULL
      AND p.paye_le < now() - interval '3 days'
      AND (p_commune_id IS NULL OR p.commune_id = p_commune_id)
    HAVING count(*) > 0

UNION ALL
    -- Données factices encore présentes
    SELECT 'avertissement', 'données provisoires (seed) restantes', count(*),
           'Remplacer par les données officielles de la mairie avant la production'
    FROM app.v_donnees_a_remplacer d
    WHERE (p_commune_id IS NULL OR d.commune_id = p_commune_id)
    HAVING count(*) > 0;
$$;

COMMENT ON FUNCTION app.verifier_coherence IS
'Contrôles de cohérence métier. À lancer après chaque import et avant chaque génération mensuelle d''avis.';
