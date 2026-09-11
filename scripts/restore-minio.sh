#!/usr/bin/env bash
# ============================================================================
#  Restauration des objets MinIO — photos, documents, QR codes
#  Plateforme GTFC
#
#  CONTREPARTIE DE backup-minio.sh, QUI N'EN AVAIT AUCUNE.
#
#  Le magasin d'objets était sauvegardé toutes les nuits à 3h45 et n'avait
#  jamais été restauré une seule fois. La constitution dit pourtant « une
#  sauvegarde jamais restaurée n'est pas une sauvegarde », et cette règle ne
#  parle pas que de PostgreSQL. Elle était tenue pour la base — sauvegarde
#  vérifiée chaque dimanche, exercice de restauration dédié — et pas du tout
#  pour les objets.
#
#  L'asymétrie n'est pas théorique. Restaurer la base sans le magasin laisse
#  toutes les lignes intactes et tous les fichiers absents : chaque quittance,
#  chaque photo de devanture, chaque QR pointe alors sur du vide, et la base
#  affirme le contraire.
#
#  Usage :
#      bash scripts/restore-minio.sh --je-confirme
#      bash scripts/restore-minio.sh --je-confirme --depuis /chemin/sauvegarde
#      bash scripts/restore-minio.sh --je-confirme --suffixe-cible -temoin
#
#      --je-confirme        OBLIGATOIRE. Écrire dans le magasin de production
#                           n'est pas un geste anodin ; on ne le fait pas par
#                           inadvertance en recopiant une ligne de commande.
#      --depuis <dossier>   sauvegarde à restaurer (défaut : $BACKUP_DIR/minio)
#      --suffixe-cible <s>  restaure dans « <bucket><s> » plutôt que dans
#                           « <bucket> ». C'est ainsi que l'exercice de
#                           restauration travaille sans toucher aux originaux,
#                           comme exercice-restauration.sh restaure la base
#                           dans un témoin plutôt que par-dessus.
#      --bucket <nom>       ne restaurer que celui-ci (répétable)
#      --exact              supprime aussi du magasin ce que la sauvegarde
#                           n'a pas. Rend le magasin identique au jour de la
#                           sauvegarde — donc DESTRUCTEUR pour tout objet
#                           arrivé depuis. À réserver au sinistre.
# ============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."

CONFIRME=0
DEPUIS=""
SUFFIXE=""
EXACT=0
BUCKETS_DEMANDES=()

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

# Les options sont lues AVANT de sourcer .env, et l'emportent sur lui.
#
# backup-minio.sh fait l'inverse : il source .env avec « set -a », si bien que
# BACKUP_DIR défini dans .env écrase la valeur passée par l'appelant. Sa ligne
# « ${BACKUP_DIR:-/var/backups/gtfc} » laisse croire à un réglage négociable
# alors qu'il ne l'est plus. On ne peut donc jouer ce script nulle part
# ailleurs que sur le serveur — et un script qu'on ne peut pas jouer ailleurs
# est un script qu'on n'éprouve jamais.
while [[ $# -gt 0 ]]; do
    case "$1" in
        --je-confirme)    CONFIRME=1 ;;
        --depuis)         DEPUIS="${2:?--depuis attend un dossier}"; shift ;;
        --suffixe-cible)  SUFFIXE="${2:?--suffixe-cible attend un suffixe}"; shift ;;
        --bucket)         BUCKETS_DEMANDES+=("${2:?--bucket attend un nom}"); shift ;;
        --exact)          EXACT=1 ;;
        -h|--help)        usage; exit 0 ;;
        *) echo "Option inconnue : $1" >&2; echo "Voir --help." >&2; exit 2 ;;
    esac
    shift
done

[[ -f .env ]] || { echo "[ERREUR] .env introuvable" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

DEPUIS="${DEPUIS:-${BACKUP_DIR:-/var/backups/gtfc}/minio}"
LOG_FILE="${LOG_FILE:-/var/log/gtfc/restore-minio.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || LOG_FILE=/dev/null

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERREUR : $*"; exit 1; }

if [[ $CONFIRME -ne 1 ]]; then
    cat >&2 <<'AVERTISSEMENT'
Ce script ÉCRIT dans le magasin d'objets. Relancez-le avec --je-confirme.

  bash scripts/restore-minio.sh --je-confirme

Pour l'essayer sans toucher aux buckets d'origine, restaurez dans des témoins :

  bash scripts/restore-minio.sh --je-confirme --suffixe-cible -temoin
AVERTISSEMENT
    exit 2
fi

[[ -d "$DEPUIS" ]] || fail "Sauvegarde introuvable : $DEPUIS"

docker inspect -f '{{.State.Running}}' gtfc-minio 2>/dev/null | grep -q true \
    || fail "Le conteneur gtfc-minio n'est pas démarré."

MC=(docker run --rm --network gtfc-net
    -v "${DEPUIS}:/backup"
    -e "MC_HOST_gtfc=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000"
    quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z)

if [[ ${#BUCKETS_DEMANDES[@]} -gt 0 ]]; then
    BUCKETS=("${BUCKETS_DEMANDES[@]}")
else
    BUCKETS=("$MINIO_BUCKET_PHOTOS" "$MINIO_BUCKET_DOCUMENTS" "$MINIO_BUCKET_QRCODES")
fi

log "===== Début de la restauration MinIO ====="
log "Sauvegarde : $DEPUIS"
[[ -n "$SUFFIXE" ]] && log "Cibles suffixées par « $SUFFIXE » — les buckets d'origine ne sont pas touchés"
[[ $EXACT -eq 1 ]] && log "Mode --exact : ce que la sauvegarde n'a pas sera SUPPRIMÉ du magasin"

ECHECS=0

for BUCKET in "${BUCKETS[@]}"; do
    CIBLE="${BUCKET}${SUFFIXE}"
    SOURCE="/backup/${BUCKET}"

    if [[ ! -d "${DEPUIS}/${BUCKET}" ]]; then
        log "  ${BUCKET} : absent de la sauvegarde — ignoré"
        continue
    fi

    ATTENDU=$(find "${DEPUIS}/${BUCKET}" -type f | wc -l | tr -d ' ')
    log "Restauration de « ${BUCKET} » vers « ${CIBLE} » (${ATTENDU} fichiers attendus)"

    "${MC[@]}" mb --ignore-existing "gtfc/${CIBLE}" >>"$LOG_FILE" 2>&1 \
        || fail "Création du bucket ${CIBLE} impossible."

    MIROIR=(mirror --overwrite --quiet)
    [[ $EXACT -eq 1 ]] && MIROIR+=(--remove)

    "${MC[@]}" "${MIROIR[@]}" "$SOURCE" "gtfc/${CIBLE}" >>"$LOG_FILE" 2>&1 \
        || fail "La restauration du bucket ${CIBLE} a échoué."

    # ---------------------------------------------------------------------
    #  On ne se contente pas du code de retour du miroir.
    #
    #  « mc mirror » peut réussir en n'ayant rien copié — c'est même son cas
    #  nominal quand la cible est déjà à jour. Compter les objets prouve que
    #  quelque chose est arrivé ; « mc diff » prouve que c'est bien la même
    #  chose, taille par taille. Sans cette vérification, un script de
    #  restauration annonce un succès qu'il n'a pas constaté — exactement le
    #  contrôle vrai par vacuité que ce projet a déjà rencontré.
    # ---------------------------------------------------------------------
    OBTENU=$("${MC[@]}" ls --recursive "gtfc/${CIBLE}" 2>/dev/null | wc -l | tr -d ' ')
    ECART=$("${MC[@]}" diff "$SOURCE" "gtfc/${CIBLE}" 2>/dev/null | head -20 || true)

    if [[ -n "$ECART" ]]; then
        log "  ÉCHEC — ${CIBLE} : la sauvegarde et le magasin diffèrent"
        echo "$ECART" | while IFS= read -r l; do log "      $l"; done
        ECHECS=$((ECHECS + 1))
    elif [[ "$OBTENU" -ne "$ATTENDU" ]]; then
        log "  ÉCHEC — ${CIBLE} : ${OBTENU} objets restaurés pour ${ATTENDU} attendus"
        ECHECS=$((ECHECS + 1))
    else
        log "  ${CIBLE} : ${OBTENU} objets, aucun écart avec la sauvegarde"
    fi
done

if [[ $ECHECS -gt 0 ]]; then
    log "===== Restauration TERMINÉE AVEC ${ECHECS} ÉCHEC(S) ====="
    exit 1
fi

log "===== Restauration MinIO terminée, sans écart ====="
