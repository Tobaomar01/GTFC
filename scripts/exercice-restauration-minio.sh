#!/usr/bin/env bash
# ============================================================================
#  Exercice de restauration du magasin d'objets
#  Plateforme GTFC
#
#  « Une sauvegarde jamais restaurée n'est pas une sauvegarde. » La règle vaut
#  pour le magasin d'objets comme pour la base : une quittance, une photo de
#  devanture ou un QR ne se recalculent pas depuis PostgreSQL.
#
#  Ce script en fait la preuve, et la refait à volonté :
#      1. il relève l'état des buckets d'origine ;
#      2. il en prend une sauvegarde, comme backup-minio.sh ;
#      3. il la restaure dans des buckets TÉMOINS, jamais par-dessus ;
#      4. il compare le témoin à l'original, objet par objet ;
#      5. il efface les témoins.
#
#  Il ne touche JAMAIS aux buckets d'origine — même esprit que
#  exercice-restauration.sh, qui restaure la base dans « <base>_restauration »
#  plutôt que par-dessus l'originale.
#
#  POURQUOI UN SCRIPT SÉPARÉ. exercice-restauration.sh s'adresse à PostgreSQL
#  et ne tourne que là où pg_dump et pg_restore sont installés à la bonne
#  version majeure. Le magasin, lui, s'éprouve partout où Docker tourne.
#  Les fondre aurait rendu la preuve du magasin dépendante d'outils qui n'ont
#  rien à voir avec lui — et une preuve qu'on ne peut pas jouer est une preuve
#  qu'on ne joue pas.
#
#  Usage :
#      bash scripts/exercice-restauration-minio.sh
#      bash scripts/exercice-restauration-minio.sh --dossier /chemin/de/travail
#      bash scripts/exercice-restauration-minio.sh --garder    # laisse les témoins
# ============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."

DOSSIER=""
GARDER=0
SUFFIXE="-restauration"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dossier) DOSSIER="${2:?--dossier attend un chemin}"; shift ;;
        --garder)  GARDER=1 ;;
        -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Option inconnue : $1" >&2; exit 2 ;;
    esac
    shift
done

[[ -f .env ]] || { echo "[ERREUR] .env introuvable" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

DOSSIER="${DOSSIER:-${TMPDIR:-/tmp}/gtfc-exercice-minio-$$}"
mkdir -p "$DOSSIER"

docker inspect -f '{{.State.Running}}' gtfc-minio 2>/dev/null | grep -q true \
    || { echo "Le conteneur gtfc-minio n'est pas démarré." >&2; exit 1; }

MC=(docker run --rm --network gtfc-net
    -v "${DOSSIER}:/backup"
    -e "MC_HOST_gtfc=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000"
    quay.io/minio/mc:RELEASE.2024-10-08T09-37-26Z)

BUCKETS=("$MINIO_BUCKET_PHOTOS" "$MINIO_BUCKET_DOCUMENTS" "$MINIO_BUCKET_QRCODES")
ECHECS=0

nettoyer() {
    [[ $GARDER -eq 1 ]] && { echo "==> Témoins conservés, ainsi que $DOSSIER"; return; }
    echo "==> Effacement des témoins"
    for B in "${BUCKETS[@]}"; do
        "${MC[@]}" rb --force "gtfc/${B}${SUFFIXE}" >/dev/null 2>&1 || true
    done
    rm -rf "$DOSSIER"
}
trap nettoyer EXIT

echo "==> État des buckets d'origine"
declare -A AVANT
for B in "${BUCKETS[@]}"; do
    AVANT[$B]=$("${MC[@]}" ls --recursive "gtfc/$B" 2>/dev/null | wc -l | tr -d ' ')
    echo "    $B : ${AVANT[$B]} objets"
done

echo "==> Sauvegarde vers $DOSSIER"
for B in "${BUCKETS[@]}"; do
    "${MC[@]}" mirror --overwrite --quiet "gtfc/$B" "/backup/$B" >/dev/null 2>&1 || true
    # « find » sort en erreur quand le dossier n'existe pas — cas nominal
    # d'un bucket vide, dont mc mirror ne crée aucun dossier. Avec pipefail,
    # cette erreur remonte et arrête le script avant même le premier contrôle.
    N=$({ find "${DOSSIER}/$B" -type f 2>/dev/null || true; } | wc -l | tr -d ' ')
    echo "    $B : $N fichiers"
    if [[ "$N" -ne "${AVANT[$B]}" ]]; then
        echo "    ÉCHEC — la sauvegarde ne contient pas tout : $N pour ${AVANT[$B]} objets"
        ECHECS=$((ECHECS + 1))
    fi
done

echo "==> Restauration dans les témoins « <bucket>${SUFFIXE} »"
if ! bash scripts/restore-minio.sh --je-confirme --depuis "$DOSSIER" --suffixe-cible "$SUFFIXE"; then
    echo "    ÉCHEC — la restauration a signalé un écart"
    ECHECS=$((ECHECS + 1))
fi

# ---------------------------------------------------------------------------
#  La preuve qui compte.
#
#  restore-minio.sh compare déjà le témoin à la SAUVEGARDE. Ici on compare le
#  témoin à l'ORIGINAL : c'est le seul contrôle qui ferme la boucle et prouve
#  que l'aller-retour n'a rien perdu en route. Comparer une copie à elle-même
#  passerait toujours.
# ---------------------------------------------------------------------------
echo "==> Comparaison témoin / original"
for B in "${BUCKETS[@]}"; do
    if [[ "${AVANT[$B]}" -eq 0 ]]; then
        echo "    $B : vide à l'origine, rien à comparer"
        continue
    fi
    ECART=$("${MC[@]}" diff "gtfc/$B" "gtfc/${B}${SUFFIXE}" 2>/dev/null | head -20 || true)
    if [[ -n "$ECART" ]]; then
        echo "    ÉCHEC — $B diffère de son témoin :"
        echo "$ECART" | sed 's/^/        /'
        ECHECS=$((ECHECS + 1))
    else
        echo "    $B : ${AVANT[$B]} objets, identiques au témoin"
    fi
done

if [[ $ECHECS -gt 0 ]]; then
    echo
    echo "EXERCICE ÉCHOUÉ — $ECHECS anomalie(s). La sauvegarde du magasin n'est pas fiable."
    exit 1
fi

echo
echo "EXERCICE RÉUSSI — le magasin d'objets se sauvegarde et se restaure à l'identique."
