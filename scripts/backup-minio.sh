#!/usr/bin/env bash
# ============================================================================
#  Sauvegarde des photos et documents stockés dans MinIO
#  Plateforme GTFC
#
#  Usage :  bash scripts/backup-minio.sh
#
#  Fonctionnement : miroir incrémental (mc mirror). Seuls les objets nouveaux
#  ou modifiés sont copiés — la sauvegarde quotidienne reste rapide même avec
#  plusieurs milliers de photos de devantures.
#
#  Les photos ne sont JAMAIS supprimées du miroir (pas de --remove) : une photo
#  effacée par erreur reste récupérable depuis la sauvegarde.
# ============================================================================
set -Eeuo pipefail

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "[ERREUR] .env introuvable" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

BACKUP_DIR="${BACKUP_DIR:-/var/backups/gtfc}/minio"
LOG_FILE="/var/log/gtfc/backup-minio.log"
mkdir -p "$BACKUP_DIR" "$(dirname "$LOG_FILE")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERREUR : $*"; exit 1; }

log "===== Début de la sauvegarde MinIO ====="

docker inspect -f '{{.State.Running}}' gtfc-minio 2>/dev/null | grep -q true \
    || fail "Le conteneur gtfc-minio n'est pas démarré."

MC=(docker run --rm --network gtfc-net
    -v "${BACKUP_DIR}:/backup"
    -e "MC_HOST_gtfc=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000"
    minio/mc:RELEASE.2024-10-08T09-37-26Z)

TOTAL_BEFORE=$(du -sm "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo 0)

for BUCKET in "${MINIO_BUCKET_PHOTOS}" "${MINIO_BUCKET_DOCUMENTS}" "${MINIO_BUCKET_QRCODES}"; do
    log "Miroir du bucket '${BUCKET}'..."
    "${MC[@]}" mirror --overwrite --quiet "gtfc/${BUCKET}" "/backup/${BUCKET}" \
        >>"$LOG_FILE" 2>&1 \
        || fail "Le miroir du bucket ${BUCKET} a échoué."
    NB=$(find "${BACKUP_DIR}/${BUCKET}" -type f 2>/dev/null | wc -l)
    log "  ${BUCKET} : ${NB} fichiers sauvegardés"
done

TOTAL_AFTER=$(du -sm "$BACKUP_DIR" | cut -f1)
log "Volume sauvegardé : ${TOTAL_AFTER} Mo (+$((TOTAL_AFTER - TOTAL_BEFORE)) Mo depuis la dernière fois)"

# Copie sur le disque externe si présent
if [[ -n "${BACKUP_MIRROR_DIR:-}" && -d "$(dirname "$BACKUP_MIRROR_DIR")" ]]; then
    mkdir -p "${BACKUP_MIRROR_DIR}/minio"
    rsync -a "${BACKUP_DIR}/" "${BACKUP_MIRROR_DIR}/minio/" >>"$LOG_FILE" 2>&1 \
        && log "Miroir externe mis à jour" \
        || log "AVERTISSEMENT : copie vers le disque externe impossible"
fi

log "===== Sauvegarde MinIO terminée ====="
