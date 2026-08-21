#!/usr/bin/env bash

# Nom du conteneur PostgreSQL. Variable plutôt que figé : la démonstration
# locale utilise gtfc-demo-db, et un serveur peut en héberger plusieurs.
PG_CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"
# ============================================================================
#  Restauration de la base PostgreSQL à partir d'une sauvegarde
#  Plateforme GTFC
#
#  Usage :
#      bash scripts/restore-postgres.sh                       # menu interactif
#      bash scripts/restore-postgres.sh /chemin/vers/x.dump    # fichier précis
#
#  OPÉRATION DESTRUCTIVE : la base courante est renommée puis remplacée.
#  L'ancienne base est conservée sous le nom <base>_avant_restauration_<date>
#  et n'est PAS supprimée automatiquement — à vous de la supprimer une fois
#  la restauration validée.
# ============================================================================
set -Eeuo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
info() { echo "${GREEN}[OK]${NC}    $*"; }
step() { echo; echo "${BOLD}==> $*${NC}"; }
warn() { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail() { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
[[ -f .env ]] || fail ".env introuvable"
# shellcheck disable=SC1091
set -a; source .env; set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/gtfc}"
CONTAINER="$PG_CONTENEUR"

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || fail "Le conteneur ${CONTAINER} n'est pas démarré."

# --- Choix du fichier -------------------------------------------------------
if [[ $# -ge 1 ]]; then
    DUMP_FILE="$1"
else
    step "Sauvegardes disponibles"
    mapfile -t FILES < <(find "$BACKUP_DIR" -name '*.dump' -type f -printf '%T@ %p\n' \
                          | sort -rn | cut -d' ' -f2-)
    [[ ${#FILES[@]} -gt 0 ]] || fail "Aucune sauvegarde trouvée dans ${BACKUP_DIR}"
    for i in "${!FILES[@]}"; do
        printf "  %2d) %-60s %8s  %s\n" "$((i+1))" \
            "$(basename "${FILES[$i]}")" \
            "$(du -h "${FILES[$i]}" | cut -f1)" \
            "$(date -r "${FILES[$i]}" '+%d/%m/%Y %H:%M')"
    done
    echo
    read -rp "Numéro de la sauvegarde à restaurer : " n
    [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 && "$n" -le ${#FILES[@]} ]] || fail "Choix invalide."
    DUMP_FILE="${FILES[$((n-1))]}"
fi

[[ -f "$DUMP_FILE" ]] || fail "Fichier introuvable : ${DUMP_FILE}"

# --- Vérifications ----------------------------------------------------------
step "Vérification de l'archive"
if [[ -f "${DUMP_FILE}.sha256" ]]; then
    (cd "$(dirname "$DUMP_FILE")" && sha256sum -c "$(basename "$DUMP_FILE").sha256" >/dev/null) \
        && info "Somme de contrôle SHA-256 valide" \
        || fail "Somme de contrôle INVALIDE — l'archive est corrompue."
else
    warn "Pas de fichier .sha256 associé — intégrité non vérifiable."
fi
pg_restore --list "$DUMP_FILE" > /dev/null || fail "Archive illisible."
NB_OBJETS=$(pg_restore --list "$DUMP_FILE" | grep -cv '^;' || true)
info "Archive lisible — ${NB_OBJETS} objets"

# --- Confirmation -----------------------------------------------------------
echo
warn "La base '${DB_NAME}' va être REMPLACÉE par le contenu de :"
echo "      $(basename "$DUMP_FILE")  ($(date -r "$DUMP_FILE" '+%d/%m/%Y %H:%M'))"
echo
read -rp "Tapez exactement le nom de la base pour confirmer (${DB_NAME}) : " confirm
[[ "$confirm" == "$DB_NAME" ]] || { echo "Annulé."; exit 1; }

# --- Arrêt des services applicatifs ----------------------------------------
step "1/5  Arrêt de l'API et du dashboard"
pm2 stop all >/dev/null 2>&1 && info "Services PM2 arrêtés" \
    || warn "PM2 : aucun service à arrêter (normal avant la phase 3)"

# --- Mise à l'écart de la base courante ------------------------------------
step "2/5  Mise de côté de la base actuelle"
OLD_DB="${DB_NAME}_avant_restauration_$(date +%Y%m%d_%H%M)"
PSQL=(docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER"
      psql -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d postgres)

"${PSQL[@]}" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null
"${PSQL[@]}" -c "ALTER DATABASE \"${DB_NAME}\" RENAME TO \"${OLD_DB}\";"
info "Base actuelle renommée en ${OLD_DB}"

# --- Création de la nouvelle base ------------------------------------------
step "3/5  Création d'une base vierge"
"${PSQL[@]}" -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_SUPERUSER}\";"
docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -c "CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE EXTENSION IF NOT EXISTS postgis_topology;
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";
        CREATE EXTENSION IF NOT EXISTS unaccent;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null
info "Base ${DB_NAME} recréée avec ses extensions"

# --- Restauration -----------------------------------------------------------
step "4/5  Restauration des données"
# La restauration parallèle (--jobs) exige un fichier accessible en accès
# direct : on passe donc par le volume partagé ./infra/postgres/dumps -> /dumps
# plutôt que par l'entrée standard.
mkdir -p ./infra/postgres/dumps
cp "$DUMP_FILE" ./infra/postgres/dumps/_restore.dump
trap 'rm -f ./infra/postgres/dumps/_restore.dump' EXIT

docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    pg_restore -U "$DB_SUPERUSER" -d "$DB_NAME" \
        --no-owner --no-privileges --jobs=4 /dumps/_restore.dump \
    || warn "pg_restore a signalé des erreurs — vérifiez le résultat ci-dessus."

# Les droits du rôle applicatif ne sont pas dans le dump (--no-privileges)
docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d "$DB_NAME" <<SQL >/dev/null
    GRANT USAGE ON SCHEMA app, ref, audit, public TO ${DB_USER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA app, ref TO ${DB_USER};
    GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA app, ref TO ${DB_USER};
    GRANT SELECT, INSERT                 ON ALL TABLES    IN SCHEMA audit  TO ${DB_USER};
    GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA audit  TO ${DB_USER};
SQL
info "Droits du rôle ${DB_USER} réappliqués"

# --- Contrôle ---------------------------------------------------------------
step "5/5  Contrôle"
docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -c "SELECT table_schema, count(*) AS tables
        FROM information_schema.tables
        WHERE table_schema IN ('app','ref','audit')
        GROUP BY table_schema ORDER BY table_schema;"

echo
info "RESTAURATION TERMINÉE"
echo
echo "  Ancienne base conservée sous : ${BOLD}${OLD_DB}${NC}"
echo "  Une fois la restauration validée, supprimez-la :"
echo "      docker exec -it ${CONTAINER} psql -U ${DB_SUPERUSER} -c 'DROP DATABASE \"${OLD_DB}\";'"
echo
echo "  Redémarrez ensuite les services :"
echo "      pm2 restart all"
echo
