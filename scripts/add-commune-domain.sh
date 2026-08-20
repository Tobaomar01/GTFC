#!/usr/bin/env bash
# ============================================================================
#  Ajout du sous-domaine d'une nouvelle commune au certificat SSL
#  Plateforme GTFC — architecture multi-communes
#
#  Usage :   bash scripts/add-commune-domain.sh parcelles
#            → ajoute parcelles.VOTRE-DOMAINE au certificat existant
#
#  Aucune modification de la configuration Nginx n'est nécessaire : le bloc
#  serveur du dashboard capte déjà *.VOTRE-DOMAINE. Seul le certificat doit
#  être étendu, car Let's Encrypt ne délivre pas de joker en validation HTTP.
#
#  PRÉREQUIS : l'enregistrement DNS  <slug>.VOTRE-DOMAINE  A  <IP serveur>
#              doit déjà être créé et propagé.
# ============================================================================
set -Eeuo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
info() { echo "${GREEN}[OK]${NC}    $*"; }
step() { echo; echo "${BOLD}==> $*${NC}"; }
warn() { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail() { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

[[ $# -eq 1 ]] || fail "Usage : bash scripts/add-commune-domain.sh <slug-commune>
Exemple : bash scripts/add-commune-domain.sh parcelles"

SLUG="$1"
[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$ ]] \
    || fail "Slug invalide : uniquement minuscules, chiffres et tirets (ex. 'parcelles', 'saint-louis')."

[[ -f .env ]] || fail "Fichier .env introuvable."
# shellcheck disable=SC1091
set -a; source .env; set +a
[[ -n "${APP_DOMAIN:-}" ]] || fail "APP_DOMAIN absent du .env"

NEW_DOMAIN="${SLUG}.${APP_DOMAIN}"
EXTRA_FILE="${ROOT_DIR}/infra/certbot/communes.txt"
touch "$EXTRA_FILE"

# ============================================================================
step "1/4  Vérification DNS de ${NEW_DOMAIN}"
# ============================================================================
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
RESOLVED="$(getent hosts "$NEW_DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"

if [[ -z "$RESOLVED" ]]; then
    fail "${NEW_DOMAIN} ne résout pas. Créez l'enregistrement DNS puis réessayez.
    ${NEW_DOMAIN}  A  ${PUBLIC_IP:-<IP du serveur>}"
fi
if [[ -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
    warn "${NEW_DOMAIN} → ${RESOLVED}, alors que ce serveur est en ${PUBLIC_IP}"
    read -rp "Continuer quand même ? [o/N] " r; [[ "$r" =~ ^[oO]$ ]] || exit 1
else
    info "${NEW_DOMAIN} → ${RESOLVED}"
fi

# ============================================================================
step "2/4  Constitution de la liste complète des noms"
# ============================================================================
if grep -qxF "$SLUG" "$EXTRA_FILE"; then
    info "'${SLUG}' est déjà enregistré — le certificat sera simplement réémis."
else
    echo "$SLUG" >> "$EXTRA_FILE"
    info "'${SLUG}' ajouté à infra/certbot/communes.txt"
fi

DOMAINS=(
    "${APP_DOMAIN}"
    "www.${APP_DOMAIN}"
    "api.${APP_DOMAIN}"
    "s3.${APP_DOMAIN}"
    "console.${APP_DOMAIN}"
    "gtfc.${APP_DOMAIN}"
)
while read -r s; do
    [[ -z "$s" || "$s" == \#* || "$s" == "gtfc" ]] && continue
    DOMAINS+=("${s}.${APP_DOMAIN}")
done < "$EXTRA_FILE"

echo "Noms qui seront couverts :"
printf '    %s\n' "${DOMAINS[@]}"
echo
read -rp "Confirmer la réémission du certificat ? [o/N] " r
[[ "$r" =~ ^[oO]$ ]] || { echo "Annulé."; exit 1; }

# ============================================================================
step "3/4  Extension du certificat"
# ============================================================================
DOMAIN_ARGS=()
for d in "${DOMAINS[@]}"; do DOMAIN_ARGS+=(-d "$d"); done

STAGING_ARG=()
[[ "${LETSENCRYPT_STAGING:-0}" == "1" ]] && STAGING_ARG=(--staging)

docker compose run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot \
    "${STAGING_ARG[@]}" \
    "${DOMAIN_ARGS[@]}" \
    --cert-name "${APP_DOMAIN}" \
    --email "${LETSENCRYPT_EMAIL}" \
    --rsa-key-size 4096 \
    --agree-tos --no-eff-email --non-interactive \
    --expand \
    || fail "Certbot a échoué. Détails : infra/certbot/log/letsencrypt.log"

info "Certificat étendu"

# ============================================================================
step "4/4  Rechargement de Nginx"
# ============================================================================
docker compose exec -T nginx nginx -s reload
info "Nginx rechargé"

echo
info "https://${NEW_DOMAIN} est maintenant servi en HTTPS."
warn "N'oubliez pas de créer la commune correspondante dans la base (phase 2/3) :
      le sous-domaine seul ne crée aucun locataire."
