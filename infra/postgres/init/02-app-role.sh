#!/bin/bash
# ============================================================================
#  Init PostgreSQL — étape 2 : rôle applicatif et schémas
#
#  Principe de moindre privilège :
#    - postgres  (superuser) : migrations, extensions, sauvegardes
#    - gtfc_app             : compte utilisé par l'API Node.js — peut lire et
#                             écrire les données, mais ne peut PAS supprimer
#                             de table ni modifier le schéma.
#    - gtfc_readonly        : compte lecture seule (exports, audit externe)
# ============================================================================
set -euo pipefail

echo "[init 02] Création du rôle applicatif ${APP_DB_USER}..."

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<-EOSQL
    -- ---------------------------------------------------------------------
    -- Rôle applicatif utilisé par l'API Node.js
    -- ---------------------------------------------------------------------
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
            CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';
        ELSE
            ALTER ROLE ${APP_DB_USER} WITH LOGIN PASSWORD '${APP_DB_PASSWORD}';
        END IF;
    END
    \$\$;

    -- ---------------------------------------------------------------------
    -- Rôle lecture seule (exports Excel/PDF, contrôle externe)
    -- Mot de passe volontairement absent : compte désactivé tant que le
    -- développeur ne lui en attribue pas un via ALTER ROLE.
    -- ---------------------------------------------------------------------
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gtfc_readonly') THEN
            CREATE ROLE gtfc_readonly NOLOGIN;
        END IF;
    END
    \$\$;

    -- ---------------------------------------------------------------------
    -- Schémas
    --   app   : tables métier (communes, commerces, taxes, paiements...)
    --   audit : journal d'audit anti-fraude, en écriture seule pour l'app
    --   ref   : données de référence (catégories, barèmes, types de taxes)
    -- ---------------------------------------------------------------------
    CREATE SCHEMA IF NOT EXISTS app   AUTHORIZATION ${POSTGRES_USER};
    CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION ${POSTGRES_USER};
    CREATE SCHEMA IF NOT EXISTS ref   AUTHORIZATION ${POSTGRES_USER};

    -- ---------------------------------------------------------------------
    -- Droits : l'application n'est PAS propriétaire des objets. Elle ne peut
    -- donc ni DROP ni ALTER une table, même si sa connexion est compromise.
    -- ---------------------------------------------------------------------
    REVOKE ALL ON DATABASE ${APP_DB_NAME} FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${APP_DB_NAME} TO ${APP_DB_USER}, gtfc_readonly;

    GRANT USAGE ON SCHEMA app, ref, audit, public TO ${APP_DB_USER}, gtfc_readonly;

    -- Droits sur les objets existants
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA app, ref TO ${APP_DB_USER};
    GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA app, ref TO ${APP_DB_USER};
    -- Le journal d'audit est en AJOUT SEULEMENT : aucune ligne ne peut être
    -- modifiée ni supprimée par l'application. C'est la garantie anti-fraude.
    GRANT SELECT, INSERT                 ON ALL TABLES    IN SCHEMA audit TO ${APP_DB_USER};
    GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA audit TO ${APP_DB_USER};

    GRANT SELECT ON ALL TABLES IN SCHEMA app, ref, audit TO gtfc_readonly;

    -- Droits appliqués automatiquement aux futures tables créées par postgres
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA app, ref
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_DB_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA app, ref
        GRANT USAGE, SELECT ON SEQUENCES TO ${APP_DB_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA audit
        GRANT SELECT, INSERT ON TABLES TO ${APP_DB_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA audit
        GRANT USAGE, SELECT ON SEQUENCES TO ${APP_DB_USER};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA app, ref, audit
        GRANT SELECT ON TABLES TO gtfc_readonly;
    ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA app, ref, audit
        GRANT EXECUTE ON FUNCTIONS TO ${APP_DB_USER};

    -- Personne ne crée d'objet dans public
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;

    -- Chemin de recherche par défaut de l'application
    ALTER ROLE ${APP_DB_USER}  SET search_path = app, ref, audit, public;
    ALTER ROLE gtfc_readonly   SET search_path = app, ref, audit, public;

    -- Sécurité : pas de requête applicative interminable
    ALTER ROLE ${APP_DB_USER} SET statement_timeout = '60s';
    ALTER ROLE ${APP_DB_USER} SET idle_in_transaction_session_timeout = '2min';
EOSQL

echo "[init 02] Rôles créés :"
psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
     -c "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname LIKE 'gtfc%' OR rolname = '${APP_DB_USER}';"

echo "[init 02] OK"
