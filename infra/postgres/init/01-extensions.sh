#!/bin/bash
# ============================================================================
#  Init PostgreSQL — étape 1 : extensions
#  Exécuté UNE SEULE FOIS, à la toute première création du volume postgres-data.
#  Pour le rejouer : docker compose down -v  (ATTENTION : efface les données)
# ============================================================================
set -euo pipefail

echo "[init 01] Installation des extensions dans la base ${POSTGRES_DB}..."

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-'EOSQL'
    -- Géospatial : indispensable pour la détection automatique du quartier
    -- à partir des coordonnées GPS relevées par l'agent terrain.
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS postgis_topology;

    -- Identifiants et hachage (mots de passe agents, tokens QR)
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Recherche de commerces par nom, tolérante aux fautes de frappe
    -- et aux accents (« Boutique Ndiaye » vs « boutique ndiaye »).
    CREATE EXTENSION IF NOT EXISTS unaccent;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    -- Contraintes d'exclusion sur périodes (une seule taxe active par
    -- commerce et par période fiscale).
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    -- Diagnostic des requêtes lentes
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EOSQL

echo "[init 01] Extensions installées :"
psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
     -c "SELECT extname, extversion FROM pg_extension ORDER BY extname;"

echo "[init 01] Version PostGIS : $(psql -tAX --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" -c 'SELECT PostGIS_Full_Version();')"
echo "[init 01] OK"
