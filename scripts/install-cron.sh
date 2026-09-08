#!/usr/bin/env bash
# ============================================================================
#  Installation des tâches planifiées
#  Plateforme GTFC
#
#  Usage :  bash scripts/install-cron.sh
#
#  Tâches installées (heure de Dakar) :
#    03h15  tous les jours   Sauvegarde PostgreSQL + rotation
#    03h45  tous les jours   Sauvegarde des photos MinIO
#    04h30  dimanche         Sauvegarde + test de restauration complet
#    07h00  tous les jours   Contrôle de santé, journalisé
#    02h00  1er du mois      VACUUM ANALYZE complet
# ============================================================================
set -Eeuo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
info() { echo "${GREEN}[OK]${NC}    $*"; }
warn() { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail() { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

[[ -f .env ]] || fail ".env introuvable"

# ---------------------------------------------------------------------------
#  .env est CHARGE, pas seulement constate.
#
#  Le script se contentait de verifier que le fichier existe. Les variables
#  restaient donc vides au moment ou le bloc cron est ecrit, et la ligne du
#  VACUUM mensuel partait avec ses valeurs par defaut :
#
#      docker exec gtfc-postgres psql -U postgres -d gtfc_taxes -c 'VACUUM ANALYZE;'
#
#  « gtfc_taxes » n'existe pas — la base s'appelle autrement. L'entretien
#  mensuel echouait donc chaque mois, en silence, dans cron.log : un fichier
#  que personne ne lit tant que rien ne va mal.
# ---------------------------------------------------------------------------
# shellcheck disable=SC1091
set -a; source .env; set +a
[[ -d /var/log/gtfc ]] || sudo mkdir -p /var/log/gtfc

MARKER_START="# >>> GTFC — tâches planifiées (généré, ne pas éditer à la main) >>>"
MARKER_END="# <<< GTFC — fin des tâches planifiées <<<"

CRON_BLOCK=$(cat <<CRON
${MARKER_START}
CRON_TZ=Africa/Dakar
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Sauvegarde quotidienne de la base
15 3 * * *  cd ${ROOT_DIR} && bash scripts/backup-postgres.sh >> /var/log/gtfc/cron.log 2>&1

# Sauvegarde quotidienne des photos et documents
45 3 * * *  cd ${ROOT_DIR} && bash scripts/backup-minio.sh >> /var/log/gtfc/cron.log 2>&1

# Le dimanche : sauvegarde avec test de restauration réel
30 4 * * 0  cd ${ROOT_DIR} && bash scripts/backup-postgres.sh --verify >> /var/log/gtfc/cron.log 2>&1

# Contrôle de santé quotidien avant l'arrivée des agents
0 7 * * *   cd ${ROOT_DIR} && bash scripts/healthcheck.sh >> /var/log/gtfc/healthcheck.log 2>&1

# Entretien mensuel de la base
0 2 1 * *   docker exec ${PG_CONTENEUR:-gtfc-postgres} psql -U ${DB_SUPERUSER:-postgres} -d ${DB_NAME:?DB_NAME absent de .env} -c 'VACUUM ANALYZE;' >> /var/log/gtfc/cron.log 2>&1
${MARKER_END}
CRON
)

# --- Installation idempotente ----------------------------------------------
CURRENT="$(crontab -l 2>/dev/null || true)"

if grep -qF "$MARKER_START" <<<"$CURRENT"; then
    warn "Un bloc GTFC existe déjà dans la crontab — il va être remplacé."
    CURRENT="$(sed "/${MARKER_START}/,/${MARKER_END}/d" <<<"$CURRENT")"
fi

printf '%s\n%s\n' "$CURRENT" "$CRON_BLOCK" | sed '/^$/N;/^\n$/D' | crontab -
info "Tâches planifiées installées pour l'utilisateur $(whoami)"

echo
echo "${BOLD}Crontab actuelle :${NC}"
crontab -l | sed -n "/${MARKER_START}/,/${MARKER_END}/p"

# --- Première exécution immédiate pour valider ------------------------------
echo
# CE SCRIPT EST APPELE SANS TERMINAL par scripts/deployer.sh, avec </dev/null.
# « read » y rencontrait une fin de fichier, rendait un code non nul, et set -e
# arretait tout APRES l'installation de la crontab mais AVANT de l'annoncer :
# l'appelant voyait un echec alors que le travail etait fait, et l'etape 11 du
# deploiement echouait sur une installation reussie.
if [[ -t 0 ]]; then
    read -rp "Lancer une première sauvegarde tout de suite pour vérifier ? [O/n] " r || r=""
else
    r="n"
    info "Entrée non interactive : la sauvegarde de contrôle est laissée à l'appelant."
fi
if [[ ! "$r" =~ ^[nN]$ ]]; then
    bash "${ROOT_DIR}/scripts/backup-postgres.sh"
    info "Première sauvegarde effectuée"
fi

echo
info "TERMINÉ"
echo "  Journaux : /var/log/gtfc/cron.log et /var/log/gtfc/healthcheck.log"
echo "  Pour désinstaller : crontab -e puis supprimer le bloc GTFC"
