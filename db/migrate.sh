#!/usr/bin/env bash
# ============================================================================
#  Gestionnaire de migrations SQL — Plateforme GTFC
#
#  Usage :
#      bash db/migrate.sh                 applique les migrations en attente
#      bash db/migrate.sh --status        liste l'état sans rien appliquer
#      bash db/migrate.sh --seed          applique migrations PUIS seed data
#      bash db/migrate.sh --seed-only     applique uniquement le seed data
#      bash db/migrate.sh --dry-run       montre ce qui serait appliqué
#      bash db/migrate.sh --reset         REMET LA BASE À ZÉRO (destructif)
#
#  Principes :
#    - chaque fichier est appliqué UNE SEULE FOIS, dans l'ordre du nom
#    - chaque fichier s'exécute dans UNE transaction : en cas d'erreur, rien
#      n'est appliqué de ce fichier, la base reste cohérente
#    - une empreinte SHA-256 est enregistrée : si un fichier déjà appliqué est
#      modifié plus tard, le script le signale au lieu de l'ignorer en silence
# ============================================================================
set -Eeuo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info() { echo "${GREEN}[OK]${NC}    $*"; }
step() { echo; echo "${BOLD}==> $*${NC}"; }
warn() { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail() { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

[[ -f .env ]] || fail ".env introuvable. Voir docs/PHASE-1-serveur.md, étape 5."

# ---------------------------------------------------------------------------
#  On retient la base demandee par l'APPELANT avant de lire .env.
#
#  « set -a; source .env » ecrase les variables deja posees dans
#  l'environnement. Sans cette precaution, « DB_NAME=gtfc_essai bash
#  db/migrate.sh » migre en silence la base nommee dans .env — sur un serveur,
#  la base de PRODUCTION — alors que l'operateur croit viser un bac a sable.
#
#  Le meme piege existe dans scripts/backup-minio.sh avec BACKUP_DIR. Ici il
#  est dangereux : on ne se trompe pas de base impunement.
# ---------------------------------------------------------------------------
_DB_NAME_APPELANT="${DB_NAME:-}"

# shellcheck disable=SC1091
set -a; source .env; set +a

if [[ -n "$_DB_NAME_APPELANT" && "$_DB_NAME_APPELANT" != "${DB_NAME:-}" ]]; then
    DB_NAME="$_DB_NAME_APPELANT"
    warn "Base imposee par l'environnement : ${DB_NAME} (et non celle de .env)"
fi

# Le nom du conteneur vient de docker-compose.yml, mais il doit rester
# surchargeable : sur un poste de developpement il differe souvent, et un
# script qu'on ne peut jouer que sur le serveur est un script qu'on n'eprouve
# jamais. Meme forme que scripts/backup-postgres.sh.
CONTAINER="${PG_CONTENEUR:-gtfc-postgres}"
MIG_DIR="${ROOT_DIR}/db/migrations"
SEED_DIR="${ROOT_DIR}/db/seeds"

MODE="apply"
case "${1:-}" in
    --status)    MODE="status" ;;
    --seed)      MODE="seed" ;;
    --seed-only) MODE="seed-only" ;;
    --dry-run)   MODE="dry-run" ;;
    --reset)     MODE="reset" ;;
    "")          MODE="apply" ;;
    *)           fail "Option inconnue : $1" ;;
esac

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || fail "Le conteneur ${CONTAINER} n'est pas démarré (docker compose up -d)."

# --- Helpers psql -----------------------------------------------------------
psql_q() {   # requête silencieuse, renvoie la valeur brute
    docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
        psql -tAX -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d "$DB_NAME" -c "$1"
}
psql_file() {  # exécute un fichier SQL depuis l'hôte, dans une transaction
    docker exec -i -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
        psql -v ON_ERROR_STOP=1 --single-transaction \
             -U "$DB_SUPERUSER" -d "$DB_NAME" -q < "$1"
}

# ============================================================================
# Remise à zéro
# ============================================================================
if [[ "$MODE" == "reset" ]]; then
    warn "Cette opération SUPPRIME toutes les tables et toutes les données."
    echo "  Base : ${DB_NAME}"
    read -rp "Tapez exactement 'SUPPRIMER' pour confirmer : " c
    [[ "$c" == "SUPPRIMER" ]] || { echo "Annulé."; exit 1; }

    step "Sauvegarde de sécurité avant remise à zéro"
    bash scripts/backup-postgres.sh || warn "La sauvegarde a échoué — on continue à votre demande."

    step "Suppression des schémas"
    psql_q "DROP SCHEMA IF EXISTS audit CASCADE;
            DROP SCHEMA IF EXISTS app   CASCADE;
            DROP SCHEMA IF EXISTS ref   CASCADE;
            CREATE SCHEMA app   AUTHORIZATION ${DB_SUPERUSER};
            CREATE SCHEMA ref   AUTHORIZATION ${DB_SUPERUSER};
            CREATE SCHEMA audit AUTHORIZATION ${DB_SUPERUSER};" >/dev/null
    info "Schémas app, ref et audit recréés vides"
    MODE="apply"
fi

# ============================================================================
# Table de suivi des migrations (amorçage)
# ============================================================================
psql_q "
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app.schema_migration (
    version      text        PRIMARY KEY,
    nom_fichier  text        NOT NULL,
    empreinte    text        NOT NULL,
    applique_le  timestamptz NOT NULL DEFAULT now(),
    duree_ms     integer,
    type_fichier text        NOT NULL DEFAULT 'migration'
);" >/dev/null

# --- Liste des fichiers à traiter ------------------------------------------
collect() {  # $1 = dossier, $2 = type
    local dir="$1"
    [[ -d "$dir" ]] || return 0
    find "$dir" -maxdepth 1 -name '*.sql' -type f | sort
}

appliquer_fichier() {
    local file="$1" type="$2"
    local base version empreinte deja debut duree
    base="$(basename "$file")"
    version="${type}:${base%%_*}"
    empreinte="$(sha256sum "$file" | cut -c1-16)"

    deja="$(psql_q "SELECT empreinte FROM app.schema_migration WHERE version = '${version}';" || true)"

    if [[ -n "$deja" ]]; then
        if [[ "$deja" != "$empreinte" ]]; then
            warn "${base} a déjà été appliqué mais son contenu a CHANGÉ depuis."
            echo "        Une migration appliquée ne doit jamais être modifiée :"
            echo "        créez un nouveau fichier correctif à la suite."
        else
            [[ "$MODE" == "status" ]] && printf "  %-46s %s\n" "$base" "${GREEN}appliqué${NC}"
        fi
        return 0
    fi

    if [[ "$MODE" == "status" || "$MODE" == "dry-run" ]]; then
        printf "  %-46s %s\n" "$base" "${YELLOW}en attente${NC}"
        return 0
    fi

    echo -n "  ${BLUE}▸${NC} ${base} ... "
    debut=$(date +%s%3N)
    if psql_file "$file"; then
        duree=$(( $(date +%s%3N) - debut ))
        psql_q "INSERT INTO app.schema_migration (version, nom_fichier, empreinte, duree_ms, type_fichier)
                VALUES ('${version}', '${base}', '${empreinte}', ${duree}, '${type}');" >/dev/null
        echo "${GREEN}OK${NC} (${duree} ms)"
    else
        echo "${RED}ÉCHEC${NC}"
        fail "La migration ${base} a échoué. Aucune de ses instructions n'a été conservée."
    fi
}

# ============================================================================
# Exécution
# ============================================================================
echo "${BOLD}=============================================================${NC}"
echo "${BOLD}  Migrations — base ${DB_NAME}${NC}"
echo "${BOLD}=============================================================${NC}"

if [[ "$MODE" != "seed-only" ]]; then
    step "Migrations de schéma"
    while IFS= read -r f; do
        [[ -n "$f" ]] && appliquer_fichier "$f" "migration"
    done < <(collect "$MIG_DIR")
fi

if [[ "$MODE" == "seed" || "$MODE" == "seed-only" ]]; then
    step "Données initiales (seed)"
    warn "Le seed contient des valeurs factices marquées À_REMPLACER."
    while IFS= read -r f; do
        [[ -n "$f" ]] && appliquer_fichier "$f" "seed"
    done < <(collect "$SEED_DIR")
fi

# ============================================================================
# Récapitulatif
# ============================================================================
if [[ "$MODE" == "apply" || "$MODE" == "seed" || "$MODE" == "seed-only" ]]; then
    step "État de la base"
    docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
        psql -X -U "$DB_SUPERUSER" -d "$DB_NAME" -c "
        SELECT table_schema AS schema, count(*) AS tables
        FROM information_schema.tables
        WHERE table_schema IN ('app','ref','audit') AND table_type = 'BASE TABLE'
        GROUP BY table_schema ORDER BY table_schema;"

    NB_ATTENTION="$(psql_q "SELECT count(*) FROM (
        SELECT 1 FROM ref.categorie_commerce WHERE libelle LIKE '%À_REMPLACER%'
        UNION ALL SELECT 1 FROM app.quartier WHERE nom LIKE '%À_REMPLACER%'
        UNION ALL SELECT 1 FROM app.bareme_taxe WHERE a_remplacer
    ) x;" 2>/dev/null || echo 0)"
    if [[ "${NB_ATTENTION:-0}" -gt 0 ]]; then
        echo
        warn "${NB_ATTENTION} enregistrements sont encore des valeurs FACTICES."
        echo "        Liste complète :  bash db/migrate.sh --status  puis"
        echo "        SELECT * FROM app.v_donnees_a_remplacer;"
    fi
fi

echo
info "Terminé"
