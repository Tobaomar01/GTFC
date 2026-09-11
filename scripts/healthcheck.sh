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
        # On interroge le conteneur MinIO LUI-MEME, plutot que d'en lancer un neuf
        # sur le reseau : un conteneur mc neuf depend de la resolution du nom
        # « minio » par le DNS interne de Docker ET du telechargement d'une image.
        # Deux dependances de plus pour un controle de sante, qui doit etre la
        # chose la plus simple du serveur. Sur un Docker imbrique, le resolveur de
        # mc echouait la ou les compartiments existaient bel et bien : le controle
        # annoncait un stockage casse alors qu'il allait tres bien.
        if docker exec -e "MC_HOST_g=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000" gtfc-minio mc ls "g/$b" >/dev/null 2>&1; then
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

# ---------------------------------------------------------------------------
#  Le certificat se lit DEPUIS LE CONTENEUR, pas depuis l'hôte.
#
#  CE QUI A ÉTÉ CONSTATÉ le 11/09/2026 : ce contrôle annonçait « Aucun
#  certificat » sur une installation dont le certificat Let's Encrypt était
#  parfaitement valide, et dont les trois lignes suivantes montraient HTTPS en
#  train de répondre. Une fausse alerte, donc — la pire espèce : elle apprend à
#  ne plus lire le contrôle.
#
#  La cause : certbot range ses fichiers avec des droits réservés à root. Ce
#  script tourne sous le compte applicatif, ne peut pas traverser le dossier, et
#  « [[ -f ]] » rend faux. Il ne constatait pas une absence, il constatait sa
#  propre cécité — et disait la première.
#
#  On lit donc par le conteneur certbot, qui monte ce dossier et a les droits.
# ---------------------------------------------------------------------------
CERT="infra/certbot/conf/live/${APP_DOMAIN}/fullchain.pem"
lire_certificat() {
    docker run --rm -v "$(pwd)/infra/certbot/conf:/etc/letsencrypt"         --entrypoint openssl certbot/certbot:v2.11.0 x509         -in "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" "$@" 2>/dev/null
}

if lire_certificat -noout >/dev/null; then
    exp_date=$(lire_certificat -enddate -noout | cut -d= -f2)
    exp_epoch=$(date -d "$exp_date" +%s 2>/dev/null || echo 0)
    days=$(( (exp_epoch - $(date +%s)) / 86400 ))
    emetteur=$(lire_certificat -issuer -noout | sed 's/^issuer=//' | tr -d ' ')
    sujet=$(lire_certificat -subject -noout | sed 's/^subject=//' | tr -d ' ')

    # Auto-signé : émetteur identique au sujet. C'est la marque du bouchon
    # provisoire que pose init-ssl.sh, et non une comparaison au nom de domaine
    # — un vrai certificat porte lui aussi le domaine dans son sujet.
    if [[ -n "$emetteur" && "$emetteur" == "$sujet" ]]; then
        warn "Certificat AUTO-SIGNÉ — relancez scripts/init-ssl.sh"
    elif [[ $days -lt 0 ]]; then
        ko "Certificat EXPIRÉ depuis $(( -days )) jours"
    elif [[ $days -lt 15 ]]; then
        warn "Certificat expire dans $days jours (le renouvellement automatique aurait dû s'exécuter)"
    else
        ok "Certificat valide encore $days jours"
    fi
    names=$(lire_certificat -noout -ext subjectAltName | tail -1 | tr -d ' ')
    [[ -n "$names" ]] && ok "Noms couverts : ${names//DNS:/}"
else
    ko "Aucun certificat lisible dans $CERT"
fi

for host in "$APP_DOMAIN" "api.$APP_DOMAIN" "gtfc.$APP_DOMAIN"; do
    # Pas de « || echo 000 » : curl ecrit DEJA 000 quand il echoue, et les deux
    # se concatenaient en « 000000 ». Ce code ne correspondait alors plus au
    # motif 000 du case ci-dessous, tombait dans le cas generique, et un hote
    # TOTALEMENT INJOIGNABLE etait affiche en vert. Le filet desactivait
    # exactement le controle qu'il devait garantir.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://${host}/" 2>/dev/null)
    case "$code" in
        000|"") ko  "https://${host}/ injoignable" ;;
        502|503) warn "https://${host}/ → $code (backend pas encore démarré — normal avant les phases 3 et 6)" ;;
        *)   ok  "https://${host}/ → $code" ;;
    esac
done

# ---------------------------------------------------------------------------
head_ "5. Services applicatifs (PM2)"
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
#  La sortie de PM2 se lit avec un analyseur JSON, pas avec grep et sed.
#
#  CE QUI A ÉTÉ CONSTATÉ le 11/09/2026 : cette section n'affichait RIEN. Ni
#  service, ni avertissement, ni erreur — une rubrique vide, sur une machine où
#  six processus PM2 tournaient.
#
#  La cause : le motif « "name":"…","pm2_env":{…"status":"…" » supposait un
#  ordre et un voisinage de champs que PM2 7 ne produit plus. Le premier grep,
#  lui, trouvait « "name" » et faisait entrer dans la branche ; le second ne
#  correspondait à rien, la boucle ne s'exécutait pas, et personne ne l'apprenait.
#
#  Un contrôle qui ne contrôle rien EN SILENCE est pire qu'un contrôle absent :
#  l'absence se remarque, le silence se prend pour un succès.
#
#  Node est installé sur ce serveur — c'est une dépendance de la plateforme.
#  Autant s'en servir pour lire du JSON.
# ---------------------------------------------------------------------------
if command -v pm2 >/dev/null 2>&1; then
    services=$(pm2 jlist 2>/dev/null | node -e '
        let d = "";
        process.stdin.on("data", (c) => { d += c; })
          .on("end", () => {
            let liste = [];
            try { liste = JSON.parse(d); } catch { process.exit(2); }
            for (const p of liste) {
              console.log(`${p.name} ${p.pm2_env?.status ?? "inconnu"}`);
            }
          });' 2>/dev/null) || services=""

    if [[ -n "$services" ]]; then
        while read -r name status; do
            [[ -z "$name" ]] && continue
            [[ "$status" == "online" ]] && ok "$name : $status" || ko "$name : $status"
        done <<<"$services"
    elif pm2 jlist >/dev/null 2>&1; then
        warn "Aucun service PM2 (normal tant que les phases 3 et 6 ne sont pas déployées)"
    else
        ko "PM2 ne répond pas — impossible de savoir si les services tournent"
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
#  UNE MESURE QUI N'A PAS PU ETRE PRISE N'EST PAS UN SUCCES.
#
#  Ces trois controles affichaient une coche verte sur du vide des que l'outil
#  manquait — « Memoire :  % utilisee ( disponibles) », « Uptime : » — ou un
#  chiffre absurde quand df repondait autrement qu'attendu : « Disque occupe a
#  325298264 % ». Un controle de sante qui verdit sans donnee ne surveille
#  rien ; il rassure.
# ---------------------------------------------------------------------------
mesure_chiffre() { [[ "$1" =~ ^[0-9]+$ ]]; }

# On compte les colonnes DEPUIS LA DROITE : « Capacity » est l'avant-derniere,
# juste avant le point de montage. Compter depuis la gauche suppose que le nom
# du systeme de fichiers ne contient pas d'espace — faux ici, ou df annonce
# « C:/Program Files/Git » : awk tombait alors sur « Available » et le controle
# affichait « Disque occupe a 325296200 % ».
disk_used=$(df -P / 2>/dev/null | awk 'NR==2{print $(NF-1)}' | tr -d '%')

# Un pourcentage hors de 0-100 n'est pas une mesure, c'est une lecture ratee.
if mesure_chiffre "${disk_used:-}" && [[ "$disk_used" -le 100 ]]; then
    if [[ "$disk_used" -gt 85 ]]; then
        ko "Disque / occupé à ${disk_used} %"
    else
        ok "Disque / : ${disk_used} % occupé ($(df -h / 2>/dev/null | awk 'NR==2{print $4}') libres)"
    fi
else
    warn "Occupation du disque indéterminable (df a répondu « ${disk_used:-rien} »)"
fi

if command -v free >/dev/null 2>&1; then
    mem_used=$(free | awk '/^Mem:/{printf "%.0f", $3/$2*100}')
    if mesure_chiffre "${mem_used:-}"; then
        if [[ "$mem_used" -gt 90 ]]; then
            warn "Mémoire utilisée à ${mem_used} %"
        else
            ok "Mémoire : ${mem_used} % utilisée ($(free -h | awk '/^Mem:/{print $7}') disponibles)"
        fi
    else
        warn "Occupation mémoire indéterminable"
    fi
else
    warn "Mémoire non mesurée : la commande « free » est absente"
fi

if [[ -r /proc/loadavg ]] && command -v nproc >/dev/null 2>&1; then
    ok "Charge : $(awk '{print $1}' /proc/loadavg) (sur $(nproc) cœurs)"
else
    warn "Charge non mesurée : /proc/loadavg ou nproc absent"
fi

if command -v uptime >/dev/null 2>&1; then
    ok "Uptime : $(uptime -p 2>/dev/null || uptime)"
else
    warn "Uptime non mesuré : la commande « uptime » est absente"
fi

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
