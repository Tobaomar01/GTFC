#!/usr/bin/env bash
# ============================================================================
#  Contrôle de santé de la plateforme GTFC
#
#  Usage :  bash scripts/healthcheck.sh
#
#  Vérifie : conteneurs, base de données, PostGIS, MinIO, Nginx, certificat
#  SSL, sauvegardes récentes, espace disque, services PM2.
#  Code de sortie 0 si tout est vert, 1 si au moins un point est en défaut.
# ============================================================================
set -uo pipefail

# Nom du conteneur PostgreSQL. Variable plutôt que figé : la démonstration
# locale utilise gtfc-demo-db, et un serveur peut en héberger plusieurs.
PG_CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"


BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
ERRORS=0; WARNINGS=0

ok()   { echo "  ${GREEN}✓${NC} $*"; }
ko()   { echo "  ${RED}✗${NC} $*"; ERRORS=$((ERRORS+1)); }
warn() { echo "  ${YELLOW}!${NC} $*"; WARNINGS=$((WARNINGS+1)); }
head_() { echo; echo "${BOLD}$*${NC}"; }

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "${RED}.env introuvable${NC}"; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

echo "${BOLD}=============================================================${NC}"
echo "${BOLD}  Plateforme taxes locales GTFC — contrôle de santé${NC}"
echo "${BOLD}  $(date '+%A %d %B %Y à %H:%M') — $(hostname)${NC}"
echo "${BOLD}=============================================================${NC}"

# ---------------------------------------------------------------------------
head_ "1. Conteneurs Docker"
# ---------------------------------------------------------------------------
for c in "$PG_CONTENEUR" gtfc-minio gtfc-nginx gtfc-certbot; do
    state=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "absent")
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$c" 2>/dev/null || echo "n/a")
    if [[ "$state" == "running" ]]; then
        if [[ "$health" == "unhealthy" ]]; then
            ko "$c : démarré mais en mauvaise santé"
        else
            uptime=$(docker inspect -f '{{.State.StartedAt}}' "$c" | cut -dT -f1)
            ok "$c : démarré depuis le $uptime (santé : $health)"
        fi
    else
        ko "$c : $state"
    fi
done

# ---------------------------------------------------------------------------
head_ "2. Base de données PostgreSQL"
# ---------------------------------------------------------------------------
if docker exec "$PG_CONTENEUR" pg_isready -U "$DB_SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1; then
    ok "PostgreSQL répond"
    PGX=(docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$PG_CONTENEUR"
         psql -tAX -U "$DB_SUPERUSER" -d "$DB_NAME" -c)

    ver=$("${PGX[@]}" "SHOW server_version;" 2>/dev/null)
    ok "Version : PostgreSQL $ver"

    gis=$("${PGX[@]}" "SELECT extversion FROM pg_extension WHERE extname='postgis';" 2>/dev/null)
    [[ -n "$gis" ]] && ok "PostGIS $gis installé" || ko "PostGIS ABSENT"

    size=$("${PGX[@]}" "SELECT pg_size_pretty(pg_database_size('${DB_NAME}'));" 2>/dev/null)
    ok "Taille de la base : $size"

    conns=$("${PGX[@]}" "SELECT count(*) FROM pg_stat_activity WHERE datname='${DB_NAME}';" 2>/dev/null)
    maxc=$("${PGX[@]}" "SHOW max_connections;" 2>/dev/null)
    if [[ "${conns:-0}" -gt $(( ${maxc:-200} * 80 / 100 )) ]]; then
        warn "Connexions : $conns / $maxc (seuil de 80 % dépassé)"
    else
        ok "Connexions : $conns / $maxc"
    fi

    # Le compte applicatif doit pouvoir se connecter
    if docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTENEUR" \
        psql -tAX -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
        ok "Le rôle applicatif '${DB_USER}' se connecte"
    else
        ko "Le rôle applicatif '${DB_USER}' NE PEUT PAS se connecter"
    fi
else
    ko "PostgreSQL ne répond pas"
fi

# ---------------------------------------------------------------------------
head_ "3. Stockage MinIO"
# ---------------------------------------------------------------------------
if docker exec gtfc-minio mc ready local >/dev/null 2>&1; then
    ok "MinIO répond"
    for b in "$MINIO_BUCKET_PHOTOS" "$MINIO_BUCKET_DOCUMENTS" "$MINIO_BUCKET_QRCODES"; do
        if docker run --rm --network gtfc-net \
            -e "MC_HOST_g=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
            minio/mc:RELEASE.2024-10-08T09-37-26Z ls "g/$b" >/dev/null 2>&1; then
            ok "Bucket '$b' accessible"
        else
            ko "Bucket '$b' introuvable"
        fi
    done
else
    ko "MinIO ne répond pas"
fi

# ---------------------------------------------------------------------------
head_ "4. Nginx et HTTPS"
# ---------------------------------------------------------------------------
if docker exec gtfc-nginx nginx -t >/dev/null 2>&1; then
    ok "Configuration Nginx valide"
else
    ko "Configuration Nginx INVALIDE (docker compose logs nginx)"
fi

CERT="infra/certbot/conf/live/${APP_DOMAIN}/fullchain.pem"
if [[ -f "$CERT" ]]; then
    exp_date=$(openssl x509 -enddate -noout -in "$CERT" 2>/dev/null | cut -d= -f2)
    exp_epoch=$(date -d "$exp_date" +%s 2>/dev/null || echo 0)
    days=$(( (exp_epoch - $(date +%s)) / 86400 ))
    issuer=$(openssl x509 -issuer -noout -in "$CERT" 2>/dev/null)
    if [[ "$issuer" == *"$APP_DOMAIN"* ]]; then
        warn "Certificat AUTO-SIGNÉ — relancez scripts/init-ssl.sh"
    elif [[ $days -lt 0 ]]; then
        ko "Certificat EXPIRÉ depuis $(( -days )) jours"
    elif [[ $days -lt 15 ]]; then
        warn "Certificat expire dans $days jours (le renouvellement automatique aurait dû s'exécuter)"
    else
        ok "Certificat valide encore $days jours"
    fi
    names=$(openssl x509 -noout -ext subjectAltName -in "$CERT" 2>/dev/null | tail -1 | tr -d ' ')
    ok "Noms couverts : ${names//DNS:/}"
else
    ko "Aucun certificat dans $CERT"
fi

for host in "$APP_DOMAIN" "api.$APP_DOMAIN" "gtfc.$APP_DOMAIN"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${host}/" 2>/dev/null || echo "000")
    case "$code" in
        000) ko  "https://${host}/ injoignable" ;;
        502|503) warn "https://${host}/ → $code (backend pas encore démarré — normal avant les phases 3 et 6)" ;;
        *)   ok  "https://${host}/ → $code" ;;
    esac
done

# ---------------------------------------------------------------------------
head_ "5. Services applicatifs (PM2)"
# ---------------------------------------------------------------------------
if command -v pm2 >/dev/null 2>&1; then
    if [[ -n "$(pm2 jlist 2>/dev/null | grep -o '"name"' || true)" ]]; then
        pm2 jlist 2>/dev/null | \
          grep -o '"name":"[^"]*","pm2_env":{[^}]*"status":"[^"]*"' | \
          sed 's/.*"name":"\([^"]*\)".*"status":"\([^"]*\)".*/\1 \2/' | \
          while read -r name status; do
              [[ "$status" == "online" ]] && ok "$name : $status" || ko "$name : $status"
          done
    else
        warn "Aucun service PM2 (normal tant que les phases 3 et 6 ne sont pas déployées)"
    fi
else
    warn "PM2 non installé"
fi

# ---------------------------------------------------------------------------
head_ "6. Sauvegardes"
# ---------------------------------------------------------------------------
BDIR="${BACKUP_DIR:-/var/backups/gtfc}"
LAST=$(find "$BDIR" -name '*.dump' -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
if [[ -n "$LAST" ]]; then
    age_h=$(( ( $(date +%s) - $(stat -c %Y "$LAST") ) / 3600 ))
    sz=$(du -h "$LAST" | cut -f1)
    if [[ $age_h -gt 30 ]]; then
        ko "Dernière sauvegarde vieille de ${age_h} h — la tâche cron ne s'exécute pas"
    else
        ok "Dernière sauvegarde : $(basename "$LAST") (${sz}, il y a ${age_h} h)"
    fi
    ok "Total : $(find "$BDIR" -name '*.dump' | wc -l) sauvegardes, $(du -sh "$BDIR" 2>/dev/null | cut -f1)"
else
    warn "Aucune sauvegarde trouvée — lancez scripts/install-cron.sh"
fi

# ---------------------------------------------------------------------------
head_ "7. Ressources du serveur"
# ---------------------------------------------------------------------------
disk_used=$(df -P / | awk 'NR==2{print $5}' | tr -d '%')
[[ $disk_used -gt 85 ]] && ko "Disque / occupé à ${disk_used} %" || ok "Disque / : ${disk_used} % occupé ($(df -h / | awk 'NR==2{print $4}') libres)"

mem_used=$(free | awk '/^Mem:/{printf "%.0f", $3/$2*100}')
[[ $mem_used -gt 90 ]] && warn "Mémoire utilisée à ${mem_used} %" || ok "Mémoire : ${mem_used} % utilisée ($(free -h | awk '/^Mem:/{print $7}') disponibles)"

load=$(awk '{print $1}' /proc/loadavg)
cores=$(nproc)
ok "Charge : ${load} (sur ${cores} cœurs)"
ok "Uptime : $(uptime -p 2>/dev/null || uptime)"

# ---------------------------------------------------------------------------
echo
echo "${BOLD}=============================================================${NC}"
if [[ $ERRORS -eq 0 && $WARNINGS -eq 0 ]]; then
    echo "  ${GREEN}${BOLD}TOUT EST OPÉRATIONNEL${NC}"
elif [[ $ERRORS -eq 0 ]]; then
    echo "  ${YELLOW}${BOLD}${WARNINGS} avertissement(s), aucune erreur${NC}"
else
    echo "  ${RED}${BOLD}${ERRORS} erreur(s) et ${WARNINGS} avertissement(s)${NC}"
fi
echo "${BOLD}=============================================================${NC}"
echo
[[ $ERRORS -eq 0 ]] && exit 0 || exit 1
