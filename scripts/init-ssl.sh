#!/usr/bin/env bash
# ============================================================================
#  Émission INITIALE des certificats Let's Encrypt
#  Plateforme GTFC
#
#  Usage :   bash scripts/init-ssl.sh
#
#  PRÉREQUIS ABSOLUS — à vérifier AVANT de lancer ce script :
#    1. Le .env est rempli (APP_DOMAIN, LETSENCRYPT_EMAIL)
#    2. Les enregistrements DNS suivants pointent vers l'IP publique du serveur
#         VOTRE-DOMAINE          A   <IP statique Sonatel>
#         www.VOTRE-DOMAINE      A   <IP statique Sonatel>
#         api.VOTRE-DOMAINE      A   <IP statique Sonatel>
#         s3.VOTRE-DOMAINE       A   <IP statique Sonatel>
#         console.VOTRE-DOMAINE  A   <IP statique Sonatel>
#         portail.VOTRE-DOMAINE  A   <IP statique Sonatel>
#         gtfc.VOTRE-DOMAINE     A   <IP statique Sonatel>
#    3. Le port 80 est joignable depuis Internet (box/routeur Sonatel : NAT)
#
#  Let's Encrypt limite à 5 échecs par heure et par domaine. Mettez
#  LETSENCRYPT_STAGING=1 dans le .env pour répéter des essais sans risque.
# ============================================================================
set -Eeuo pipefail

# ---------------------------------------------------------------------------
#  Ce script est appele SANS TERMINAL par scripts/deployer.sh (avec </dev/null).
#  « read » y rencontre une fin de fichier et rend un code non nul : sous
#  set -e, le script mourait AU PREMIER PROMPT, silencieusement, code 1, sans
#  un mot d'explication. Meme avec un domaine et un DNS corrects, l'etape 4 du
#  deploiement ne pouvait donc JAMAIS obtenir de certificat.
#
#  Sans terminal, chaque question prend la reponse qui NE SURPREND PAS :
#   · confirmer les informations  -> oui, le deployeur les a deja verifiees ;
#   · passer outre un avertissement -> NON, on ne force pas une anomalie
#     detectee sans que quelqu'un l'ait decidee ;
#   · remplacer un certificat existant -> NON, on garde ce qui marche.
#  Dans tous les cas, la reponse retenue est ANNONCEE.
# ---------------------------------------------------------------------------
interactif() { [[ -t 0 ]]; }
demander() {  # demander <question> <reponse-sans-terminal>
    local question="$1" defaut="$2" r=""
    if interactif; then read -rp "$question" r || r=""
    else r="$defaut"; echo "${question}${r}   (sans terminal : réponse par défaut)"; fi
    [[ "$r" =~ ^[oO]$ ]]
}

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
info() { echo "${GREEN}[OK]${NC}    $*"; }
step() { echo; echo "${BOLD}==> $*${NC}"; }
warn() { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail() { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

[[ -f .env ]] || fail "Fichier .env introuvable. Faites : cp .env.template .env puis remplissez-le."

# shellcheck disable=SC1091
set -a; source .env; set +a

[[ -n "${APP_DOMAIN:-}" && "$APP_DOMAIN" != "A_REMPLIR.sn" ]] \
    || fail "APP_DOMAIN n'est pas renseigné dans .env"
[[ -n "${LETSENCRYPT_EMAIL:-}" && "$LETSENCRYPT_EMAIL" != "A_REMPLIR@example.com" ]] \
    || fail "LETSENCRYPT_EMAIL n'est pas renseigné dans .env"

# Les noms couverts par le certificat viennent de scripts/sous-domaines.sh,
# que deployer.sh lit aussi : les deux listes ne peuvent plus diverger.
# Pour ajouter une commune : scripts/add-commune-domain.sh <slug>
source "${ROOT_DIR}/scripts/sous-domaines.sh"

CERT_DIR="${ROOT_DIR}/infra/certbot/conf"
WEBROOT="${ROOT_DIR}/infra/certbot/www"
LIVE_DIR="${CERT_DIR}/live/${APP_DOMAIN}"

echo "${BOLD}Domaine racine  :${NC} ${APP_DOMAIN}"
echo "${BOLD}Email           :${NC} ${LETSENCRYPT_EMAIL}"
echo "${BOLD}Noms couverts   :${NC} ${DOMAINS[*]}"
[[ "${LETSENCRYPT_STAGING:-0}" == "1" ]] && warn "MODE TEST (staging) — les certificats obtenus ne seront PAS reconnus par les navigateurs."
echo
demander "Ces informations sont-elles correctes ? [o/N] " "o" || { echo "Annulé."; exit 1; }

# ============================================================================
step "1/6  Vérification DNS"
# ============================================================================
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
[[ -n "$PUBLIC_IP" ]] && info "IP publique du serveur : ${PUBLIC_IP}" \
                      || warn "Impossible de déterminer l'IP publique (pas de connexion sortante ?)"

DNS_KO=0
for d in "${DOMAINS[@]}"; do
    # « getent hosts » rend 2 quand le nom ne resout pas, et pipefail propage
    # ce code : sous set -e, le script mourait ICI, avant le bloc ecrit
    # precisement pour expliquer quels enregistrements manquent. Le diagnostic
    # etait inatteignable au moment exact ou il sert. Un nom qui ne resout pas
    # n'est pas une erreur du script : c'est ce qu'il vient constater.
    resolved="$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -1 || true)"
    if [[ -z "$resolved" ]]; then
        echo "  ${RED}✗${NC} ${d} — ne résout pas"
        DNS_KO=1
    elif [[ -n "$PUBLIC_IP" && "$resolved" != "$PUBLIC_IP" ]]; then
        echo "  ${YELLOW}!${NC} ${d} → ${resolved} (attendu ${PUBLIC_IP})"
        DNS_KO=1
    else
        echo "  ${GREEN}✓${NC} ${d} → ${resolved}"
    fi
done

if [[ $DNS_KO -eq 1 ]]; then
    warn "Au moins un enregistrement DNS n'est pas correct. Let's Encrypt échouera."
    demander "Continuer quand même ? [o/N] " "n" || { echo "Interrompu : une anomalie a été détectée, et personne ne peut décider de passer outre." >&2; exit 1; }
fi

# ============================================================================
step "2/6  Préparation des dossiers"
# ============================================================================
mkdir -p "${CERT_DIR}" "${WEBROOT}" "${ROOT_DIR}/infra/certbot/log"
info "Dossiers certbot prêts"

# ============================================================================
step "3/6  Certificat auto-signé temporaire"
# ============================================================================
# Nginx refuse de démarrer si le fichier de certificat référencé n'existe pas.
# On dépose donc un certificat factice, le temps que Certbot le remplace.
if [[ -f "${LIVE_DIR}/fullchain.pem" ]]; then
    info "Un certificat existe déjà dans ${LIVE_DIR} — conservé."
    EXISTING_CERT=1
else
    EXISTING_CERT=0
    mkdir -p "${LIVE_DIR}"
    docker run --rm -v "${CERT_DIR}:/etc/letsencrypt" --entrypoint openssl \
        certbot/certbot:v2.11.0 req -x509 -nodes -newkey rsa:2048 -days 1 \
        -keyout "/etc/letsencrypt/live/${APP_DOMAIN}/privkey.pem" \
        -out    "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" \
        -subj "/CN=${APP_DOMAIN}" 2>/dev/null
    info "Certificat temporaire créé (valable 1 jour, sera remplacé)"
fi

# ============================================================================
step "4/6  Démarrage de Nginx"
# ============================================================================
docker compose up -d nginx
sleep 5
docker compose exec -T nginx nginx -t \
    || fail "La configuration Nginx est invalide. Voir : docker compose logs nginx"
info "Nginx démarré et configuration valide"

# Vérification que le défi ACME est bien servi depuis l'extérieur
echo "test-acme-gtfc" > "${WEBROOT}/.test-acme"
mkdir -p "${WEBROOT}/.well-known/acme-challenge"
echo "test-acme-gtfc" > "${WEBROOT}/.well-known/acme-challenge/test-gtfc"
if curl -fsS --max-time 10 "http://${APP_DOMAIN}/.well-known/acme-challenge/test-gtfc" 2>/dev/null | grep -q "test-acme-gtfc"; then
    info "Le défi ACME est accessible depuis Internet"
else
    warn "Le fichier de défi ACME n'est PAS accessible depuis http://${APP_DOMAIN}/"
    warn "Causes fréquentes : port 80 non redirigé sur la box Sonatel, ou DNS non propagé."
    demander "Continuer quand même ? [o/N] " "n" || { echo "Interrompu : une anomalie a été détectée, et personne ne peut décider de passer outre." >&2; exit 1; }
fi
rm -f "${WEBROOT}/.well-known/acme-challenge/test-gtfc" "${WEBROOT}/.test-acme"

# ============================================================================
step "5/6  Demande du certificat à Let's Encrypt"
# ============================================================================
if [[ $EXISTING_CERT -eq 1 ]]; then
    demander "Un certificat existe déjà. Le remplacer ? [o/N] " "n" || { info "Conservation du certificat existant."; exit 0; }
fi

# Le dossier live/ doit être vide sinon certbot crée un suffixe -0001
rm -rf "${LIVE_DIR}"

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
    --agree-tos \
    --no-eff-email \
    --non-interactive \
    --keep-until-expiring \
    || fail "Certbot a échoué. Détails : infra/certbot/log/letsencrypt.log"

info "Certificat obtenu"

# ============================================================================
step "6/6  Rechargement de Nginx"
# ============================================================================
docker compose exec -T nginx nginx -s reload
sleep 2

echo
echo "${BOLD}--------------------------------------------------------------${NC}"
docker compose run --rm --entrypoint certbot certbot certificates 2>/dev/null | \
    grep -E "Certificate Name|Domains|Expiry Date" || true
echo "${BOLD}--------------------------------------------------------------${NC}"
echo
info "HTTPS OPÉRATIONNEL"
echo
echo "Vérifiez dans un navigateur :"
for d in "${DOMAINS[@]}"; do echo "    https://${d}"; done
echo
echo "Le renouvellement est automatique (service 'certbot', toutes les 12 h)."
echo "Pour ajouter le sous-domaine d'une nouvelle commune :"
echo "    bash scripts/add-commune-domain.sh <slug-commune>"
echo
