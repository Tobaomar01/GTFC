#!/usr/bin/env bash
# ============================================================================
#  Démonstration locale — voir la plateforme tourner sans serveur
#
#  Usage (Git Bash sous Windows, ou un terminal Linux) :
#      bash scripts/demo-locale.sh demarrer
#      bash scripts/demo-locale.sh arreter
#      bash scripts/demo-locale.sh etat
#      bash scripts/demo-locale.sh remettre-a-zero
#
#  ─────────────────────────────────────────────────────────────────────────
#  À QUOI ÇA SERT
#
#  Montrer le résultat à la mairie — ou le regarder soi-même — avant d'avoir
#  acheté le Mini PC. Tout tourne sur votre poste : PostgreSQL et MinIO dans
#  Docker, l'API et le tableau de bord en local.
#
#  CE QUE CETTE DÉMO N'EST PAS : un environnement de production. Pas de HTTPS,
#  des secrets connus de tous, des données inventées. Ne l'utilisez jamais
#  avec de vraies données de commerçants.
#  ─────────────────────────────────────────────────────────────────────────
# ============================================================================
set -Eeuo pipefail

cd "$(dirname "$0")/.."
RACINE="$(pwd)"

GRAS=$'\033[1m'; VERT=$'\033[0;32m'; JAUNE=$'\033[0;33m'
ROUGE=$'\033[0;31m'; GRIS=$'\033[0;90m'; NC=$'\033[0m'
ok()   { echo "  ${VERT}✓${NC} $*"; }
info() { echo "  ${GRIS}·${NC} $*"; }
warn() { echo "  ${JAUNE}!${NC} $*"; }
err()  { echo "  ${ROUGE}✗${NC} $*"; }

DEMO_ENV="${RACINE}/.env.demo"
JOURNAUX="${RACINE}/.demo-logs"
PORT_API=4000
PORT_DASH=3000
PORT_DB=55432
PORT_MINIO=9000

mkdir -p "$JOURNAUX"

# ---------------------------------------------------------------------------
ecrire_env() {
  cat > "$DEMO_ENV" <<'ENVEOF'
# Configuration de la DÉMONSTRATION LOCALE — secrets volontairement connus.
# Ne jamais réutiliser sur un serveur réel.
NODE_ENV=development
TZ=Africa/Dakar
APP_DOMAIN=localhost

DB_HOST=127.0.0.1
DB_PORT=55432
DB_NAME=gtfc_demo
DB_USER=gtfc_app
DB_PASSWORD=MotDePasseDemo2026
DB_SUPERUSER=postgres
DB_SUPERUSER_PASSWORD=demo

API_PORT=4000
API_HOST=127.0.0.1
JWT_SECRET=demo_locale_secret_jwt_de_48_octets_minimum_pour_la_demonstration_2026
CORS_ORIGINS=http://localhost:3000

DASHBOARD_PORT=3000
DASHBOARD_HOST=127.0.0.1

MINIO_ENDPOINT=127.0.0.1
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=cle_demo
MINIO_SECRET_KEY=secret_demo_minio
MINIO_BUCKET_PHOTOS=gtfc-photos
MINIO_BUCKET_DOCUMENTS=gtfc-documents
MINIO_BUCKET_QRCODES=gtfc-qrcodes

WAVE_ACTIF=false
WAVE_SIMULER=true
WAVE_WEBHOOK_SECRET=secret_webhook_demo_locale
WAVE_ENVIRONMENT=sandbox

LOG_LEVEL=warn
ENVEOF
}

charger_env() { set -a; . "$DEMO_ENV"; set +a; }

# Arrêt d'un processus par le port : `pkill` ne suffit pas sous Windows,
# où Node tourne comme un processus natif hors du shell.
tuer_port() {
  local port="$1"
  node -e "
    const {execSync}=require('child_process');
    try{
      const o=execSync('netstat -ano | findstr :$port',{shell:'cmd.exe'}).toString();
      const pids=[...new Set(o.split('\n').map(l=>l.trim().split(/\s+/).pop()).filter(p=>/^[0-9]+\$/.test(p)))];
      pids.forEach(p=>{try{execSync('taskkill /F /PID '+p,{shell:'cmd.exe',stdio:'ignore'})}catch(e){}});
    }catch(e){}
  " 2>/dev/null || {
    # Repli Linux
    local pid; pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
    [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null || true
  }
}

attendre_url() {
  local url="$1" libelle="$2" max="${3:-60}"
  local i=0
  while [[ $i -lt $max ]]; do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && return 0
    sleep 2; i=$((i + 2))
    printf "\r  ${GRIS}·${NC} %s… %ds" "$libelle" "$i"
  done
  echo; return 1
}

# ===========================================================================
demarrer() {
  echo
  echo "${GRAS}Démonstration locale — plateforme de collecte des taxes locales${NC}"
  echo

  docker info >/dev/null 2>&1 || {
    err "Docker Desktop n'est pas démarré."
    echo "     Lancez Docker Desktop, attendez qu'il soit prêt, puis relancez."
    exit 1
  }
  ok "Docker disponible"

  [[ -f "$DEMO_ENV" ]] || ecrire_env
  charger_env

  # --- Conteneurs --------------------------------------------------------
  if docker inspect -f '{{.State.Running}}' gtfc-demo-db 2>/dev/null | grep -q true; then
    ok "PostgreSQL déjà démarré"
  else
    docker rm -f gtfc-demo-db >/dev/null 2>&1 || true
    info "Démarrage de PostgreSQL + PostGIS…"
    docker run -d --name gtfc-demo-db \
      -e POSTGRES_PASSWORD=demo -e POSTGRES_DB=gtfc_demo -e TZ=Africa/Dakar \
      -p ${PORT_DB}:5432 postgis/postgis:16-3.4 >/dev/null
    for i in $(seq 1 60); do
      docker exec gtfc-demo-db pg_isready -U postgres -d gtfc_demo >/dev/null 2>&1 && break
      sleep 2
    done
    ok "PostgreSQL démarré"
  fi

  if docker inspect -f '{{.State.Running}}' gtfc-demo-minio 2>/dev/null | grep -q true; then
    ok "MinIO déjà démarré"
  else
    docker rm -f gtfc-demo-minio >/dev/null 2>&1 || true
    info "Démarrage de MinIO…"
    docker run -d --name gtfc-demo-minio -p ${PORT_MINIO}:9000 \
      -e MINIO_ROOT_USER=cle_demo -e MINIO_ROOT_PASSWORD=secret_demo_minio \
      minio/minio:RELEASE.2024-10-13T13-34-11Z server /data >/dev/null
    for i in $(seq 1 30); do
      docker exec gtfc-demo-minio mc ready local >/dev/null 2>&1 && break; sleep 2
    done
    docker run --rm --network host \
      -e "MC_HOST_d=http://cle_demo:secret_demo_minio@127.0.0.1:${PORT_MINIO}" \
      minio/mc:RELEASE.2024-10-08T09-37-26Z \
      mb --ignore-existing d/gtfc-photos d/gtfc-documents d/gtfc-qrcodes >/dev/null 2>&1
    ok "MinIO démarré, buckets créés"
  fi

  # --- Schéma ------------------------------------------------------------
  local nbTables
  nbTables=$(docker exec -e PGPASSWORD=demo gtfc-demo-db psql -tAX -U postgres -d gtfc_demo \
    -c "SELECT count(*) FROM information_schema.tables
        WHERE table_schema IN ('app','ref','audit') AND table_type='BASE TABLE'" 2>/dev/null | tr -d ' ' || echo 0)

  if [[ "${nbTables:-0}" -lt 50 ]]; then
    info "Création du schéma et des données de démonstration…"
    docker exec -e PGPASSWORD=demo gtfc-demo-db psql -q -U postgres -d gtfc_demo -c "
      DO \$\$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gtfc_app') THEN
          CREATE ROLE gtfc_app LOGIN PASSWORD 'MotDePasseDemo2026';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gtfc_readonly') THEN
          CREATE ROLE gtfc_readonly NOLOGIN;
        END IF;
      END \$\$;
      CREATE SCHEMA IF NOT EXISTS app; CREATE SCHEMA IF NOT EXISTS ref; CREATE SCHEMA IF NOT EXISTS audit;
      GRANT CONNECT ON DATABASE gtfc_demo TO gtfc_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app, ref
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gtfc_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app, ref
        GRANT USAGE, SELECT ON SEQUENCES TO gtfc_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA audit
        GRANT SELECT, INSERT ON TABLES TO gtfc_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA audit
        GRANT USAGE, SELECT ON SEQUENCES TO gtfc_app;" >/dev/null

    for f in db/migrations/*.sql db/seeds/*.sql; do
      docker exec -i -e PGPASSWORD=demo gtfc-demo-db \
        psql -v ON_ERROR_STOP=1 --single-transaction -U postgres -d gtfc_demo -q < "$f" >/dev/null 2>&1 \
        || { err "Échec sur $(basename "$f")"; exit 1; }
    done
    ok "Schéma et données de démonstration en place"
  else
    ok "Schéma déjà en place ($nbTables tables)"
  fi

  # --- API ---------------------------------------------------------------
  [[ -d apps/api/node_modules ]] || { info "npm install de l'API…"; (cd apps/api && npm install --no-audit --no-fund >/dev/null); }
  tuer_port $PORT_API
  info "Démarrage de l'API…"
  ( set -a; . "$DEMO_ENV"; set +a; cd "${RACINE}/apps/api" && nohup node src/server.js > "${JOURNAUX}/api.log" 2>&1 & )
  attendre_url "http://127.0.0.1:${PORT_API}/healthz" "démarrage de l'API" 90 \
    || { echo; err "L'API n'a pas démarré."; tail -20 "${JOURNAUX}/api.log"; exit 1; }
  echo; ok "API prête · http://127.0.0.1:${PORT_API}"

  # --- Campagne et paiements simulés -------------------------------------
  local enAttente
  enAttente=$(docker exec -e PGPASSWORD=demo gtfc-demo-db psql -tAX -U postgres -d gtfc_demo \
    -c "SELECT count(*) FROM app.transaction_wave" 2>/dev/null | tr -d ' ' || echo 0)
  if [[ "${enAttente:-0}" == "0" ]]; then
    info "Génération d'un jeu de données réaliste…"
    ( set -a; . "$DEMO_ENV"; set +a; cd "${RACINE}/apps/api" && node -e "
      (async()=>{const B='http://127.0.0.1:${PORT_API}';
      let r=await fetch(B+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({telephone:'+221700000002',mot_de_passe:'GtfcDemo2026!'})});
      const j=(await r.json()).donnees.jeton_acces;
      const h={Authorization:'Bearer '+j,'Content-Type':'application/json'};
      r=await fetch(B+'/periodes',{headers:h});const p=(await r.json()).donnees[0];
      await fetch(B+'/periodes/'+p.id+'/emettre',{method:'POST',headers:h});
      await fetch(B+'/campagnes/'+p.id+'/lancer',{method:'POST',headers:h});})();" >/dev/null 2>&1
      node scripts/simuler-wave.js tout-payer --taux 0.58 >/dev/null 2>&1 || true )
    ok "Avis émis, paiements simulés"
  else
    ok "Jeu de données déjà en place"
  fi

  # --- Tableau de bord ----------------------------------------------------
  [[ -d apps/dashboard/node_modules ]] || { info "npm install du tableau de bord…"; (cd apps/dashboard && npm install --no-audit --no-fund >/dev/null); }
  if [[ ! -f apps/dashboard/.next/BUILD_ID ]]; then
    info "Compilation du tableau de bord (2 à 5 minutes)…"
    ( cd apps/dashboard && NEXT_TELEMETRY_DISABLED=1 API_URL="http://127.0.0.1:${PORT_API}" npm run build >/dev/null 2>&1 ) \
      || { err "La compilation a échoué."; exit 1; }
  fi
  tuer_port $PORT_DASH
  info "Démarrage du tableau de bord…"
  ( cd "${RACINE}/apps/dashboard" && API_URL="http://127.0.0.1:${PORT_API}" COOKIES_SECURE=false \
      NEXT_TELEMETRY_DISABLED=1 nohup npx next start -p ${PORT_DASH} -H 127.0.0.1 \
      > "${JOURNAUX}/dashboard.log" 2>&1 & )
  attendre_url "http://127.0.0.1:${PORT_DASH}/connexion" "démarrage du tableau de bord" 90 \
    || { echo; err "Le tableau de bord n'a pas démarré."; tail -20 "${JOURNAUX}/dashboard.log"; exit 1; }
  echo

  afficher_acces
}

# ===========================================================================
afficher_acces() {
  echo
  echo "${GRAS}${VERT}━━━ La démonstration est prête ━━━${NC}"
  echo
  echo "  ${GRAS}Tableau de bord${NC}   ${VERT}http://localhost:${PORT_DASH}${NC}"
  echo "  ${GRAS}Console MinIO${NC}     http://localhost:${PORT_MINIO}  ${GRIS}(cle_demo / secret_demo_minio)${NC}"
  echo
  echo "  ${GRAS}Comptes${NC} — mot de passe commun : ${GRAS}GtfcDemo2026!${NC}"
  echo "    +221700000002   Administrateur de la commune"
  echo "    +221700000003   Superviseur"
  echo "    +221700000011   Agent  ${GRIS}(refusé sur le dashboard : c'est voulu)${NC}"
  echo
  echo "  ${GRAS}À regarder en premier${NC}"
  echo "    · Vue d'ensemble — taux de recouvrement, situation par zone"
  echo "    · Carte — marqueurs vert/orange/rouge sur Gueule Tapée-Fass-Colobane"
  echo "    · Un commerce → « Calculer les montants dus » (le détail du calcul)"
  echo "    · Journal d'audit → cliquer un enregistrement (l'avant/après)"
  echo "    · Bouton de thème en haut à droite"
  echo
  echo "  ${GRAS}Arrêter${NC}   bash scripts/demo-locale.sh arreter"
  echo
  warn "Démonstration : pas de HTTPS, secrets connus, données inventées."
  warn "Ne jamais l'utiliser avec de vraies données de commerçants."
  echo
}

# ===========================================================================
arreter() {
  echo
  info "Arrêt des services…"
  tuer_port $PORT_API
  tuer_port $PORT_DASH
  ok "API et tableau de bord arrêtés"
  docker stop gtfc-demo-db gtfc-demo-minio >/dev/null 2>&1 || true
  ok "Conteneurs arrêtés (les données sont conservées)"
  echo
  info "Pour relancer : bash scripts/demo-locale.sh demarrer"
  info "Pour tout effacer : bash scripts/demo-locale.sh remettre-a-zero"
  echo
}

etat() {
  echo
  echo "${GRAS}État de la démonstration${NC}"
  echo
  for c in gtfc-demo-db gtfc-demo-minio; do
    local e; e=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo absent)
    [[ "$e" == "running" ]] && ok "$c : $e" || warn "$c : $e"
  done
  curl -fsS --max-time 5 "http://127.0.0.1:${PORT_API}/healthz" >/dev/null 2>&1 \
    && ok "API : en ligne" || warn "API : arrêtée"
  curl -fsS --max-time 5 "http://127.0.0.1:${PORT_DASH}/connexion" >/dev/null 2>&1 \
    && ok "Tableau de bord : en ligne  →  http://localhost:${PORT_DASH}" \
    || warn "Tableau de bord : arrêté"
  echo
}

remettre_a_zero() {
  echo
  warn "Cette opération EFFACE la base et le stockage de démonstration."
  read -rp "  Confirmer ? [o/N] " r
  [[ "$r" =~ ^[oO]$ ]] || { echo "  Annulé."; exit 0; }
  tuer_port $PORT_API; tuer_port $PORT_DASH
  docker rm -f gtfc-demo-db gtfc-demo-minio >/dev/null 2>&1 || true
  rm -rf "$JOURNAUX"
  ok "Démonstration effacée. Relancez avec : bash scripts/demo-locale.sh demarrer"
  echo
}

case "${1:-demarrer}" in
  demarrer|start)         demarrer ;;
  arreter|stop)           arreter ;;
  etat|status)            etat ;;
  remettre-a-zero|reset)  remettre_a_zero ;;
  acces)                  afficher_acces ;;
  *) echo "Usage : bash scripts/demo-locale.sh [demarrer|arreter|etat|remettre-a-zero]"; exit 1 ;;
esac
