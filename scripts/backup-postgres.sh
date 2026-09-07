#!/usr/bin/env bash

# Nom du conteneur PostgreSQL. Variable plutôt que figé : la démonstration
# locale utilise gtfc-demo-db, et un serveur peut en héberger plusieurs.
PG_CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"
# ============================================================================
#  Sauvegarde quotidienne de PostgreSQL avec rotation
#  Plateforme GTFC
#
#  Usage :
#      bash scripts/backup-postgres.sh            # sauvegarde quotidienne
#      bash scripts/backup-postgres.sh --verify   # + test de restauration
#
#  Installé en tâche cron par scripts/install-cron.sh (03h15, heure de Dakar).
#
#  Rotation (paramétrable dans .env) :
#      daily/    14 dernières sauvegardes
#      weekly/   8 dernières (copie du dimanche)
#      monthly/  12 dernières (copie du 1er du mois)
#
#  Format : pg_dump --format=custom, compressé. Restauration sélective
#  possible table par table avec pg_restore.
# ============================================================================
set -Eeuo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

[[ -f .env ]] || { echo "[ERREUR] .env introuvable" >&2; exit 1; }
# shellcheck disable=SC1091

# ---------------------------------------------------------------------------
#  L'environnement de l'APPELANT prime sur .env.
#
#  « set -a; source .env » ecrase les variables deja posees. Sans cette
#  precaution, DB_NAME et BACKUP_DIR passent en
#  ligne de commande sont ignores en
#  silence, et le script travaille ailleurs que la ou on le croit. Un script
#  qu'on ne peut pas diriger vers un bac a sable est un script qu'on n'eprouve
#  jamais — et, ici, une operation qui peut se tromper de cible.
# ---------------------------------------------------------------------------
_APPELANT_DB_NAME="${DB_NAME:-}"
_APPELANT_BACKUP_DIR="${BACKUP_DIR:-}"
set -a; source .env; set +a
[[ -n "$_APPELANT_DB_NAME" ]] && DB_NAME="$_APPELANT_DB_NAME"
[[ -n "$_APPELANT_BACKUP_DIR" ]] && BACKUP_DIR="$_APPELANT_BACKUP_DIR"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/gtfc}"
RET_DAILY="${BACKUP_RETENTION_DAILY:-14}"
RET_WEEKLY="${BACKUP_RETENTION_WEEKLY:-8}"
RET_MONTHLY="${BACKUP_RETENTION_MONTHLY:-12}"
# Le journal suit le dossier de sauvegarde s'il est detourne, et se laisse
# imposer par LOG_FILE. Fige sur /var/log/gtfc, il faisait echouer le script
# des la premiere ligne sur tout poste qui n'est pas le serveur — « mkdir:
# cannot create directory '/var': Permission denied » — alors meme que
# BACKUP_DIR avait ete correctement detourne.
LOG_FILE="${LOG_FILE:-${BACKUP_DIR%/}/backup-postgres.log}"
CONTAINER="$PG_CONTENEUR"

TIMESTAMP="$(date +%Y-%m-%d_%Hh%M)"
DAY_OF_WEEK="$(date +%u)"     # 7 = dimanche
DAY_OF_MONTH="$(date +%d)"
DUMP_NAME="gtfc_${DB_NAME}_${TIMESTAMP}.dump"

mkdir -p "${BACKUP_DIR}"/{daily,weekly,monthly} "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERREUR : $*"; exit 1; }

trap 'fail "Interruption à la ligne $LINENO"' ERR

log "===== Début de la sauvegarde ====="

# --- 1. Le conteneur est-il vivant ? ---------------------------------------
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || fail "Le conteneur ${CONTAINER} n'est pas démarré."

# --- 2. Espace disque disponible -------------------------------------------
AVAIL_MB=$(df -Pm "$BACKUP_DIR" | awk 'NR==2{print $4}')
DB_SIZE_MB=$(docker exec "$CONTAINER" psql -tAX -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -c "SELECT pg_database_size('${DB_NAME}')/1024/1024;" 2>/dev/null || echo 0)
log "Taille de la base : ${DB_SIZE_MB} Mo — espace libre : ${AVAIL_MB} Mo"
if [[ "$AVAIL_MB" -lt $((DB_SIZE_MB * 2 + 500)) ]]; then
    fail "Espace disque insuffisant sur ${BACKUP_DIR} (il faut au moins $((DB_SIZE_MB * 2 + 500)) Mo)."
fi

# --- 3. Dump ----------------------------------------------------------------
TARGET="${BACKUP_DIR}/daily/${DUMP_NAME}"
log "Dump vers ${TARGET}"

# Une sauvegarde interrompue laisse un fichier sur le disque. Il porte un nom
# de sauvegarde, il est daté, il figure dans le dossier — et il est vide ou
# tronqué. C'est le pire cas de tous : on croit avoir une sauvegarde. On
# l'efface donc avant de renoncer, plutôt que de la laisser rassurer.
nettoyer_partiel() { rm -f "$TARGET"; }

docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    pg_dump -U "$DB_SUPERUSER" -d "$DB_NAME" \
        --format=custom --compress=6 --verbose --no-owner --no-privileges \
    > "$TARGET" 2>>"$LOG_FILE" \
    || { nettoyer_partiel; fail "pg_dump a échoué."; }

SIZE_MB=$(du -m "$TARGET" | cut -f1)
[[ "$SIZE_MB" -gt 0 ]] || { nettoyer_partiel; fail "Le fichier de sauvegarde est vide."; }
log "Dump terminé — ${SIZE_MB} Mo"

# --- 4. Contrôle d'intégrité ------------------------------------------------
# pg_restore --list échoue si l'archive est tronquée ou corrompue.
# On utilise le client installé sur l'hôte (paquet postgresql-client-16).
pg_restore --list "$TARGET" > /dev/null 2>>"$LOG_FILE" \
    || fail "L'archive produite est illisible (pg_restore --list a échoué)."
log "Intégrité de l'archive vérifiée"

sha256sum "$TARGET" > "${TARGET}.sha256"
chmod 640 "$TARGET" "${TARGET}.sha256"

# --- 5. Copies hebdomadaire et mensuelle -----------------------------------
if [[ "$DAY_OF_WEEK" == "7" ]]; then
    cp -p "$TARGET" "${TARGET}.sha256" "${BACKUP_DIR}/weekly/"
    log "Copie hebdomadaire créée"
fi
if [[ "$DAY_OF_MONTH" == "01" ]]; then
    cp -p "$TARGET" "${TARGET}.sha256" "${BACKUP_DIR}/monthly/"
    log "Copie mensuelle créée"
fi

# --- 6. Rotation ------------------------------------------------------------
rotate() {
    local dir="$1" keep="$2" label="$3"
    local count
    count=$(find "$dir" -maxdepth 1 -name '*.dump' -type f | wc -l)
    if [[ "$count" -gt "$keep" ]]; then
        find "$dir" -maxdepth 1 -name '*.dump' -type f -printf '%T@ %p\n' \
            | sort -n | head -n $((count - keep)) | cut -d' ' -f2- \
            | while read -r old; do
                  rm -f "$old" "${old}.sha256"
                  log "Rotation ${label} : suppression de $(basename "$old")"
              done
    fi
}
rotate "${BACKUP_DIR}/daily"   "$RET_DAILY"   "quotidienne"
rotate "${BACKUP_DIR}/weekly"  "$RET_WEEKLY"  "hebdomadaire"
rotate "${BACKUP_DIR}/monthly" "$RET_MONTHLY" "mensuelle"

# --- 7. Copie sur le disque externe ----------------------------------------
if [[ -n "${BACKUP_MIRROR_DIR:-}" ]]; then
    MIRROR_MOUNT="$(dirname "$BACKUP_MIRROR_DIR")"
    if mountpoint -q "$MIRROR_MOUNT" 2>/dev/null || [[ -d "$BACKUP_MIRROR_DIR" ]]; then
        mkdir -p "$BACKUP_MIRROR_DIR"
        rsync -a --delete "${BACKUP_DIR}/" "${BACKUP_MIRROR_DIR}/" >>"$LOG_FILE" 2>&1 \
            && log "Miroir mis à jour sur ${BACKUP_MIRROR_DIR}" \
            || log "AVERTISSEMENT : la copie vers le disque externe a échoué"
    else
        log "AVERTISSEMENT : disque externe non monté (${MIRROR_MOUNT}) — copie ignorée"
    fi
fi

# --- 8. Test de restauration (option --verify) -----------------------------
# Restaure le dump dans une base jetable pour prouver qu'il est exploitable.
# Long : à ne lancer qu'une fois par semaine (voir install-cron.sh).
if [[ "${1:-}" == "--verify" ]]; then
    log "Test de restauration dans une base temporaire..."
    TEST_DB="gtfc_verify_$(date +%s)"
    docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
        createdb -U "$DB_SUPERUSER" "$TEST_DB"
    if docker exec -i -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
        pg_restore -U "$DB_SUPERUSER" -d "$TEST_DB" --no-owner --no-privileges \
        < "$TARGET" >>"$LOG_FILE" 2>&1; then
        NB=$(docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
            psql -tAX -U "$DB_SUPERUSER" -d "$TEST_DB" \
            -c "SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('app','ref','audit');")
        log "Test de restauration RÉUSSI — ${NB} tables restaurées"
    else
        log "AVERTISSEMENT : le test de restauration a signalé des erreurs (voir le log)"
    fi
    docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
        dropdb -U "$DB_SUPERUSER" --if-exists "$TEST_DB"
fi

# --- 9. Récapitulatif -------------------------------------------------------
log "Sauvegardes présentes : $(find "$BACKUP_DIR" -name '*.dump' | wc -l) fichiers, $(du -sh "$BACKUP_DIR" | cut -f1) au total"
log "===== Sauvegarde terminée avec succès ====="
