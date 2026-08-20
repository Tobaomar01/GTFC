-- ===========================================================================
--  0001 — Extensions, schémas et fonctions utilitaires
--  Plateforme de collecte des taxes locales GTFC
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ref;
CREATE SCHEMA IF NOT EXISTS audit;

COMMENT ON SCHEMA app   IS 'Données métier : communes, commerces, taxes, paiements';
COMMENT ON SCHEMA ref   IS 'Données de référence : catégories, types de taxes, rôles';
COMMENT ON SCHEMA audit IS 'Journal d''audit anti-fraude — AJOUT SEULEMENT';

-- ---------------------------------------------------------------------------
-- Recherche insensible aux accents et à la casse
-- « Ndiaye », « ndiaye » et « NDIAYÉ » doivent se retrouver mutuellement :
-- indispensable pour qu'un agent retrouve un commerce sur le terrain.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.normaliser(txt text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT lower(unaccent('unaccent', coalesce(txt, '')));
$$;

COMMENT ON FUNCTION app.normaliser IS
'Minuscules + suppression des accents. IMMUTABLE, donc utilisable dans un index.';

-- ---------------------------------------------------------------------------
-- Horodatage automatique des modifications
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.trg_maj_modifie_le()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.modifie_le := now();
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Contexte de la requête, positionné par l'API à chaque appel :
--     SET LOCAL gtfc.utilisateur_id = '...';
--     SET LOCAL gtfc.commune_id     = '...';
--     SET LOCAL gtfc.super_admin    = 'on';
--
-- Ces valeurs alimentent à la fois le journal d'audit et l'isolation
-- multi-communes (politiques RLS, migration 0014).
-- `true` en 2e argument de current_setting = ne pas échouer si non défini.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.utilisateur_courant()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT nullif(current_setting('gtfc.utilisateur_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.commune_courante()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
    SELECT nullif(current_setting('gtfc.commune_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app.est_super_admin()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT coalesce(nullif(current_setting('gtfc.super_admin', true), '') = 'on', false);
$$;

CREATE OR REPLACE FUNCTION app.ip_courante()
RETURNS inet
LANGUAGE sql STABLE
AS $$
    SELECT nullif(current_setting('gtfc.ip', true), '')::inet;
$$;

-- ---------------------------------------------------------------------------
-- Génération d'un code court lisible, utilisé pour les codes de commerce
-- et les références de paiement. Alphabet volontairement sans I, O, 0 et 1 :
-- ces caractères se confondent quand un agent recopie un code à la main.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.code_aleatoire(longueur integer DEFAULT 8)
RETURNS text
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
    alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    resultat text := '';
    i integer;
BEGIN
    FOR i IN 1..longueur LOOP
        resultat := resultat || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    RETURN resultat;
END;
$$;

-- ---------------------------------------------------------------------------
-- Arrondi monétaire XOF : le franc CFA ne se divise pas en centimes.
-- Tous les montants de la plateforme passent par cette fonction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.arrondir_xof(montant numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT round(coalesce(montant, 0), 0);
$$;
