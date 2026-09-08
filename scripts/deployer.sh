#!/usr/bin/env bash
# ============================================================================
#  Déploiement complet de la plateforme GTFC
#
#  Enchaîne les 6 phases, avec une vérification avant ET après chaque étape.
#
#  Usage :
#      bash scripts/deployer.sh                  déploiement complet
#      bash scripts/deployer.sh --etat           où en est-on ?
#      bash scripts/deployer.sh --depuis 6       reprendre à l'étape 6
#      bash scripts/deployer.sh --jusqua 5       s'arrêter après l'étape 5
#      bash scripts/deployer.sh --sans-seed      sans les données de démonstration
#      bash scripts/deployer.sh --simulation     n'exécute rien, montre le plan
#
#  ─────────────────────────────────────────────────────────────────────────
#  DEUX PROPRIÉTÉS À CONNAÎTRE
#
#  1. IDEMPOTENT. Chaque étape commence par vérifier si elle est déjà faite.
#     Relancer le script après une coupure de courant reprend là où il en
#     était, sans rien casser ni rien refaire inutilement.
#
#  2. IL S'ARRÊTE À LA PREMIÈRE ERREUR, et dit quoi faire. Il ne continue
#     jamais « en espérant » : une étape ratée qu'on ignore se paie dix
#     étapes plus loin, avec un symptôme incompréhensible.
#  ─────────────────────────────────────────────────────────────────────────
# ============================================================================
set -Eeuo pipefail

cd "$(dirname "$0")/.."
RACINE="$(pwd)"

# --- Affichage --------------------------------------------------------------
GRAS=$'\033[1m'; VERT=$'\033[0;32m'; JAUNE=$'\033[0;33m'
ROUGE=$'\033[0;31m'; BLEU=$'\033[0;36m'; GRIS=$'\033[0;90m'; NC=$'\033[0m'

ok()      { echo "    ${VERT}✓${NC} $*"; }
info()    { echo "    ${GRIS}·${NC} $*"; }
avertir() { echo "    ${JAUNE}!${NC} $*"; }
echec()   { echo "    ${ROUGE}✗${NC} $*"; }

titre() {
  echo
  echo "${GRAS}${BLEU}━━━ Étape $1/$TOTAL — $2${NC}"
}

# Arrêt propre, avec le contexte : sans cela on cherche l'erreur à l'aveugle.
ETAPE_COURANTE="initialisation"
trap 'echo; echec "Échec pendant : ${ETAPE_COURANTE} (ligne $LINENO)"; \
      echo "  Corrigez, puis relancez :  bash scripts/deployer.sh"; exit 1' ERR

abandonner() {
  echo
  echec "$1"
  [[ -n "${2:-}" ]] && { echo; echo "  ${GRAS}Que faire :${NC}"; echo "$2" | sed 's/^/    /'; }
  echo
  exit 1
}

# --- État -------------------------------------------------------------------
FICHIER_ETAT="${RACINE}/.deploiement-etat"
touch "$FICHIER_ETAT"

deja_fait()   { grep -qx "$1" "$FICHIER_ETAT" 2>/dev/null; }
marquer_fait() { deja_fait "$1" || echo "$1" >> "$FICHIER_ETAT"; }

# --- Options ----------------------------------------------------------------
DEPUIS=1
JUSQUA=12
AVEC_SEED=1
SIMULATION=0
TOTAL=12

while [[ $# -gt 0 ]]; do
  case "$1" in
    --depuis)     DEPUIS="$2"; shift 2 ;;
    --jusqua)     JUSQUA="$2"; shift 2 ;;
    --sans-seed)  AVEC_SEED=0; shift ;;
    --simulation) SIMULATION=1; shift ;;
    --etat)       DEPUIS=99; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) abandonner "Option inconnue : $1" "bash scripts/deployer.sh --help" ;;
  esac
done

ETAPES=(
  "Prérequis système (Docker, Node, PM2, pare-feu)"
  "Fichier .env complet et cohérent"
  "DNS et ports ouverts"
  "Certificats HTTPS"
  "Infrastructure Docker (PostgreSQL, MinIO, Nginx)"
  "Schéma de base de données"
  "Dépendances de l'API"
  "Premier compte super-administrateur"
  "Compilation du tableau de bord"
  "Démarrage des services PM2"
  "Sauvegardes automatiques"
  "Recette finale"
)

# ============================================================================
#  État courant
# ============================================================================
if [[ "$DEPUIS" == "99" ]]; then
  echo
  echo "${GRAS}État du déploiement${NC}"
  echo
  for i in "${!ETAPES[@]}"; do
    n=$((i + 1))
    if deja_fait "etape-$n"; then
      printf "  ${VERT}✓${NC} %2d. %s\n" "$n" "${ETAPES[$i]}"
    else
      printf "  ${GRIS}○${NC} %2d. %s\n" "$n" "${ETAPES[$i]}"
    fi
  done
  echo
  # awk plutôt que `grep -c` : grep sort en code 1 quand il ne trouve rien,
  # et le `|| echo 0` de secours ajoutait alors un second zéro à la sortie.
  faites=$(awk '/^etape-/ { n++ } END { print n + 0 }' "$FICHIER_ETAT")
  echo "  ${faites}/${TOTAL} étapes faites"
  [[ "$faites" -lt "$TOTAL" ]] && echo "  Reprendre : bash scripts/deployer.sh"
  echo
  exit 0
fi

# ============================================================================
#  Aides communes
# ============================================================================
charger_env() {
  [[ -f "${RACINE}/.env" ]] || abandonner \
    "Le fichier .env est absent." \
    "cp .env.template .env
nano .env        # remplir toutes les valeurs A_REMPLIR
chmod 600 .env"
  # shellcheck disable=SC1091
  set -a; source "${RACINE}/.env"; set +a
}

psql_admin() {
  docker exec -e PGPASSWORD="${DB_SUPERUSER_PASSWORD}" gtfc-postgres \
    psql -tAX -v ON_ERROR_STOP=1 -U "${DB_SUPERUSER}" -d "${DB_NAME}" "$@"
}

executer() {
  if [[ "$SIMULATION" == "1" ]]; then
    echo "    ${GRIS}[simulation]${NC} $*"
    return 0
  fi
  "$@"
}

# ============================================================================
echo
echo "${GRAS}Déploiement — plateforme de collecte des taxes locales${NC}"
echo "${GRIS}$(hostname) · $(date '+%d/%m/%Y %H:%M')${NC}"
[[ "$SIMULATION" == "1" ]] && avertir "MODE SIMULATION — rien ne sera exécuté"
[[ "$AVEC_SEED" == "0" ]] && info "Sans données de démonstration"

# ============================================================================
#  1. Prérequis système
# ============================================================================
etape_1() {
  local manquants=()
  command -v docker >/dev/null 2>&1 || manquants+=("docker")
  docker compose version >/dev/null 2>&1 || manquants+=("docker compose")
  command -v node >/dev/null 2>&1 || manquants+=("node")
  command -v pm2 >/dev/null 2>&1 || manquants+=("pm2")

  if [[ ${#manquants[@]} -gt 0 ]]; then
    avertir "Manquant : ${manquants[*]}"
    if [[ "$SIMULATION" == "1" ]]; then
      info "[simulation] sudo bash scripts/install-ubuntu.sh"
      return 0
    fi
    abandonner \
      "Les prérequis système ne sont pas installés." \
      "sudo bash scripts/install-ubuntu.sh
puis DÉCONNECTEZ-VOUS ET RECONNECTEZ-VOUS (groupe docker),
et relancez : bash scripts/deployer.sh"
  fi

  # Docker sans sudo : sinon toutes les étapes suivantes échoueront
  docker ps >/dev/null 2>&1 || abandonner \
    "Docker n'est pas accessible sans sudo." \
    "Déconnectez-vous et reconnectez-vous pour que le groupe docker
soit pris en compte, puis relancez le script."

  local versionNode
  versionNode=$(node -v | tr -d 'v' | cut -d. -f1)
  [[ "$versionNode" -ge 20 ]] || abandonner \
    "Node.js $versionNode est trop ancien (20 minimum)." \
    "sudo bash scripts/install-ubuntu.sh"

  ok "Docker $(docker --version | awk '{print $3}' | tr -d ,)"
  ok "Node.js $(node -v)  ·  PM2 $(pm2 -v)"
  ok "Docker utilisable sans sudo"
}

# ============================================================================
#  2. Fichier .env
# ============================================================================
etape_2() {
  charger_env

  local restants
  # Les lignes de COMMENTAIRE sont exclues : le gabarit porte lui-meme, en
  # tete, « remplir TOUTES les valeurs marquees A_REMPLIR ». Sans cette
  # exclusion, un .env parfaitement rempli comptait quand meme une occurrence,
  # et le deploiement s'arretait a l'etape 2 en reclamant de remplir une ligne
  # de documentation. Aucun serveur ne pouvait franchir cette etape.
  restants=$(grep -c '^[^#]*A_REMPLIR' "${RACINE}/.env" || true)
  if [[ "$restants" -gt 0 ]]; then
    echo
    grep -n '^[^#]*A_REMPLIR' "${RACINE}/.env" | sed 's/^/      /' | head -12
    echo
    abandonner \
      "$restants valeur(s) encore à remplir dans le .env." \
      "nano .env
Générer un secret :  openssl rand -base64 48"
  fi

  # Les secrets courts sont la faille la plus banale et la plus grave.
  [[ ${#JWT_SECRET} -ge 32 ]] || abandonner \
    "JWT_SECRET fait ${#JWT_SECRET} caractères (32 minimum)." \
    "openssl rand -base64 48"
  [[ ${#DB_PASSWORD} -ge 12 ]] || abandonner \
    "DB_PASSWORD est trop court (12 caractères minimum)." "openssl rand -base64 32"
  [[ ${#MINIO_ROOT_PASSWORD} -ge 8 ]] || abandonner \
    "MINIO_ROOT_PASSWORD fait moins de 8 caractères — MinIO refusera de démarrer." \
    "openssl rand -base64 32"
  [[ -n "${WAVE_WEBHOOK_SECRET:-}" ]] || abandonner \
    "WAVE_WEBHOOK_SECRET est vide." \
    "Même en simulation, ce secret protège le webhook : sans lui,
n'importe qui pourrait déclarer un paiement.
openssl rand -base64 32"

  # Les permissions : le .env contient tous les secrets de la plateforme
  local perms
  perms=$(stat -c '%a' "${RACINE}/.env")
  if [[ "$perms" != "600" ]]; then
    avertir "Permissions du .env : $perms — correction en 600"
    executer chmod 600 "${RACINE}/.env"
  fi

  ok "Domaine : ${APP_DOMAIN}"
  ok "Secrets présents et de longueur suffisante"
  if [[ -z "${WAVE_API_KEY:-}" ]]; then
    info "Wave en SIMULATION (WAVE_API_KEY vide) — c'est volontaire tant que"
    info "le compte Wave Business n'est pas ouvert"
  else
    ok "Wave configuré (${WAVE_ENVIRONMENT:-sandbox})"
  fi
}

# ============================================================================
#  3. DNS et ports
# ============================================================================
etape_3() {
  charger_env

  local ipPublique
  ipPublique=$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')
  [[ -n "$ipPublique" ]] && ok "IP publique du serveur : $ipPublique" \
    || avertir "IP publique indéterminée (pas de connexion sortante ?)"

  local noms=("${APP_DOMAIN}" "api.${APP_DOMAIN}" "gtfc.${APP_DOMAIN}"
              "s3.${APP_DOMAIN}" "console.${APP_DOMAIN}" "www.${APP_DOMAIN}")
  local kos=0
  for n in "${noms[@]}"; do
    local resolu
    resolu=$(getent hosts "$n" 2>/dev/null | awk '{print $1}' | head -1)
    if [[ -z "$resolu" ]]; then
      echec "$n — ne résout pas"; kos=$((kos + 1))
    elif [[ -n "$ipPublique" && "$resolu" != "$ipPublique" ]]; then
      avertir "$n → $resolu (attendu $ipPublique)"; kos=$((kos + 1))
    else
      ok "$n → $resolu"
    fi
  done

  [[ $kos -eq 0 ]] || abandonner \
    "$kos enregistrement(s) DNS incorrect(s). Let's Encrypt échouera." \
    "Créez les enregistrements A vers ${ipPublique:-<IP statique>} chez votre
registrar, attendez la propagation (jusqu'à 24 h), puis relancez.
Vérifier :  dig +short api.${APP_DOMAIN}"

  # Le port 80 doit être joignable de l'extérieur pour le défi Let's Encrypt
  if ! ss -tlnp 2>/dev/null | grep -q ':80 ' && ! docker ps --format '{{.Ports}}' | grep -q ':80->'; then
    info "Port 80 pas encore écouté — normal avant le démarrage de Nginx"
  fi
}

# ============================================================================
#  4. Certificats HTTPS
# ============================================================================
etape_4() {
  charger_env
  local cert="${RACINE}/infra/certbot/conf/live/${APP_DOMAIN}/fullchain.pem"

  if [[ -f "$cert" ]]; then
    local emetteur jours
    emetteur=$(openssl x509 -issuer -noout -in "$cert" 2>/dev/null || echo '')
    jours=$(( ( $(date -d "$(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2)" +%s) \
                - $(date +%s) ) / 86400 ))

    if [[ "$emetteur" == *"${APP_DOMAIN}"* ]]; then
      avertir "Certificat auto-signé — Let's Encrypt n'a pas encore abouti"
    elif [[ $jours -lt 15 ]]; then
      avertir "Certificat valable encore $jours jours seulement"
    else
      ok "Certificat valide encore $jours jours"
      return 0
    fi
  fi

  info "Obtention des certificats Let's Encrypt…"
  executer bash "${RACINE}/scripts/init-ssl.sh" </dev/null || abandonner \
    "L'obtention des certificats a échoué." \
    "Causes fréquentes :
  · port 80 non redirigé sur la box Sonatel
  · DNS non propagé
Détail : tail -50 infra/certbot/log/letsencrypt.log
Pour tester sans consommer le quota : LETSENCRYPT_STAGING=1 dans le .env"
  ok "Certificats obtenus"
}

# ============================================================================
#  5. Infrastructure Docker
# ============================================================================
etape_5() {
  charger_env

  info "Démarrage des conteneurs…"
  executer docker compose up -d

  [[ "$SIMULATION" == "1" ]] && return 0

  # On attend la SANTÉ, pas le simple démarrage : un PostgreSQL « up » qui
  # n'accepte pas encore de connexion ferait échouer les migrations.
  local attente=0
  while [[ $attente -lt 120 ]]; do
    local sains=0
    for c in gtfc-postgres gtfc-minio gtfc-nginx; do
      local etat
      etat=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
             "$c" 2>/dev/null || echo absent)
      [[ "$etat" == "healthy" || "$etat" == "running" ]] && sains=$((sains + 1))
    done
    [[ $sains -eq 3 ]] && break
    sleep 5; attente=$((attente + 5))
    printf "\r    ${GRIS}·${NC} attente des conteneurs… %ds" "$attente"
  done
  echo

  for c in gtfc-postgres gtfc-minio gtfc-nginx; do
    docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -q true \
      || abandonner "Le conteneur $c n'est pas démarré." \
        "docker compose logs $c"
    ok "$c démarré"
  done

  # minio-init est éphémère : son code de sortie dit si les buckets sont créés
  local sortieInit
  sortieInit=$(docker inspect -f '{{.State.ExitCode}}' gtfc-minio-init 2>/dev/null || echo '?')
  if [[ "$sortieInit" == "0" ]]; then
    ok "Buckets MinIO créés"
  else
    avertir "minio-init a terminé avec le code $sortieInit"
    info "Relancer : docker compose run --rm minio-init"
  fi

  psql_admin -c "SELECT 1" >/dev/null 2>&1 \
    || abandonner "PostgreSQL n'accepte pas les connexions." "docker compose logs postgres"
  ok "PostgreSQL répond"
}

# ============================================================================
#  6. Schéma de base de données
# ============================================================================
etape_6() {
  charger_env

  local nbTables
  nbTables=$(psql_admin -c "SELECT count(*) FROM information_schema.tables
    WHERE table_schema IN ('app','ref','audit') AND table_type='BASE TABLE'" 2>/dev/null || echo 0)

  if [[ "${nbTables:-0}" -ge 50 ]]; then
    ok "Schéma déjà en place ($nbTables tables)"
  else
    info "Application des migrations…"
    if [[ "$AVEC_SEED" == "1" ]]; then
      executer bash "${RACINE}/db/migrate.sh" --seed
    else
      executer bash "${RACINE}/db/migrate.sh"
    fi
  fi

  [[ "$SIMULATION" == "1" ]] && return 0

  nbTables=$(psql_admin -c "SELECT count(*) FROM information_schema.tables
    WHERE table_schema IN ('app','ref','audit') AND table_type='BASE TABLE'")
  [[ "$nbTables" -ge 50 ]] || abandonner \
    "Seulement $nbTables tables créées (50 attendues au minimum)." \
    "bash db/migrate.sh --status"
  ok "$nbTables tables"

  # PostGIS : sans lui, la détection du quartier par GPS ne marche pas
  psql_admin -c "SELECT 1 FROM pg_extension WHERE extname='postgis'" | grep -q 1 \
    || abandonner "PostGIS n'est pas installé." "docker compose logs postgres"
  ok "PostGIS actif"

  # Le rôle applicatif doit pouvoir se connecter : c'est lui que l'API utilise
  docker exec -e PGPASSWORD="${DB_PASSWORD}" gtfc-postgres \
    psql -tAX -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1" >/dev/null 2>&1 \
    || abandonner "Le rôle applicatif ${DB_USER} ne peut pas se connecter." \
      "Vérifiez DB_PASSWORD dans le .env, puis :
docker exec -it gtfc-postgres psql -U ${DB_SUPERUSER} -d ${DB_NAME} \\
  -c \"ALTER ROLE ${DB_USER} WITH PASSWORD '<le mot de passe du .env>';\""
  ok "Rôle applicatif ${DB_USER} opérationnel"

  local provisoires
  provisoires=$(psql_admin -c "SELECT count(*) FROM app.v_donnees_a_remplacer" 2>/dev/null || echo 0)
  if [[ "${provisoires:-0}" -gt 0 ]]; then
    avertir "$provisoires données encore PROVISOIRES (barèmes inventés)"
    info "Aucun avis ne doit être émis avant de les remplacer :"
    info "  SELECT * FROM app.v_donnees_a_remplacer;"
  fi
}

# ============================================================================
#  7. Dépendances de l'API
# ============================================================================
etape_7() {
  cd "${RACINE}/apps/api"

  if [[ -d node_modules && -f node_modules/.package-lock.json ]]; then
    ok "Dépendances déjà installées"
  else
    info "npm ci (quelques minutes sur une connexion lente)…"
    executer npm ci --omit=dev --no-audit --no-fund
  fi

  [[ "$SIMULATION" == "1" ]] && { cd "$RACINE"; return 0; }

  node -e "require('./src/config/env')" >/dev/null 2>&1 || abandonner \
    "La configuration de l'API est invalide." \
    "cd apps/api && node -e \"require('./src/config/env')\"
Le message d'erreur indique précisément la variable en cause."
  ok "Configuration de l'API validée"
  cd "$RACINE"
}

# ============================================================================
#  8. Premier compte
# ============================================================================
etape_8() {
  charger_env

  local nbSuperAdmins
  nbSuperAdmins=$(psql_admin -c "SELECT count(*) FROM app.utilisateur
    WHERE role='super_admin' AND archive_le IS NULL AND matricule NOT LIKE 'DEMO-%'" 2>/dev/null || echo 0)

  if [[ "${nbSuperAdmins:-0}" -gt 0 ]]; then
    ok "Un super-administrateur existe déjà"
    return 0
  fi

  if [[ "$SIMULATION" == "1" ]]; then
    info "[simulation] création du compte super-administrateur"
    return 0
  fi

  echo
  echo "  ${GRAS}Aucun super-administrateur : créons-le maintenant.${NC}"
  echo "  ${GRIS}C'est le compte qui vous permettra de créer tous les autres.${NC}"
  echo
  cd "${RACINE}/apps/api"
  node scripts/creer-utilisateur.js --role super_admin || abandonner \
    "La création du compte a échoué." \
    "cd apps/api && node scripts/creer-utilisateur.js --help"
  cd "$RACINE"
  ok "Compte super-administrateur créé"
  avertir "Notez le mot de passe MAINTENANT — il ne sera plus affiché"
}

# ============================================================================
#  9. Compilation du tableau de bord
# ============================================================================
etape_9() {
  cd "${RACINE}/apps/dashboard"

  # « node_modules existe » ne suffit pas. Une installation faite sous
  # NODE_ENV=production laisse le dossier en place SANS les devDependencies :
  # la compilation echoue ensuite sur un outil manquant, et relancer l'etape
  # ne repare rien puisque le dossier, lui, est bien la. On verifie donc ce
  # dont la compilation a besoin, pas la presence d'un repertoire.
  outillage_complet=1
  for outil in tailwindcss postcss autoprefixer cross-env next; do
    [[ -e "node_modules/${outil}" ]] || outillage_complet=0
  done
  if [[ ! -d node_modules || "$outillage_complet" == "0" ]]; then
    info "npm ci du tableau de bord…"
    # --include=dev EST INDISPENSABLE. Le .env pose NODE_ENV=production, et npm
    # ignore alors les devDependencies MEME sans --omit=dev. Or la compilation du
    # tableau de bord en a besoin : tailwindcss, postcss et autoprefixer y sont,
    # et sans eux « next build » ne produit aucune feuille de style. Le
    # deploiement echouait ici sur un serveur neuf, quelle que soit la machine.
    executer npm ci --include=dev --no-audit --no-fund
  else
    ok "Dépendances déjà installées"
  fi

  # Le build est OBLIGATOIRE : PM2 lance `next start`, qui refuse de démarrer
  # sans build de production. C'est l'oubli le plus fréquent.
  if [[ -f .next/BUILD_ID ]] && [[ .next/BUILD_ID -nt package.json ]]; then
    ok "Build déjà à jour"
  else
    info "Compilation (2 à 5 minutes)…"
    executer env NEXT_TELEMETRY_DISABLED=1 npm run build
  fi

  [[ "$SIMULATION" == "1" ]] && { cd "$RACINE"; return 0; }

  [[ -f .next/BUILD_ID ]] || abandonner \
    "La compilation du tableau de bord n'a pas produit de build." \
    "cd apps/dashboard && npm run build"
  ok "Tableau de bord compilé"
  cd "$RACINE"
}

# ============================================================================
#  10. Services PM2
# ============================================================================
etape_10() {
  charger_env

  info "Démarrage des services…"
  # startOrRestart, PAS start.
  #
  # `pm2 start` sur une application déjà lancée répond « already launched » et
  # ne fait rien : après une mise à jour, les processus continueraient de
  # servir le code précédent. Le déploiement s'afficherait en vert, la recette
  # passerait — sur l'ancienne version — et la correction resterait invisible.
  executer pm2 startOrRestart "${RACINE}/ecosystem.config.js" --update-env
  executer pm2 save

  # Un redémarrage qui échoue laisse l'ancien processus en place, et donc
  # l'ancien code. On s'assure que les deux applications ont bien redémarré
  # à l'instant, plutôt que de le supposer.
  for app in gtfc-api gtfc-dashboard; do
    secondes=$(pm2 jlist 2>/dev/null | node -e "
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        try{const a=JSON.parse(d).find(x=>x.name==='$app');
          console.log(a?Math.round((Date.now()-a.pm2_env.pm_uptime)/1000):9999);}
        catch(e){console.log(9999);}});" 2>/dev/null || echo 9999)
    if [[ "$secondes" -gt 120 ]]; then
      avertir "$app tourne depuis ${secondes}s — il n'a pas redémarré"
      info "pm2 restart $app --update-env"
    fi
  done

  [[ "$SIMULATION" == "1" ]] && return 0

  sleep 8
  local kos=0
  for s in gtfc-api gtfc-dashboard gtfc-scheduler; do
    local etat
    etat=$(pm2 jlist 2>/dev/null | node -e "
      let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
        try{const j=JSON.parse(d);const a=j.find(x=>x.name==='$s');
        console.log(a?a.pm2_env.status:'absent');}catch(e){console.log('?');}});" 2>/dev/null || echo '?')
    if [[ "$etat" == "online" ]]; then ok "$s : $etat"; else echec "$s : $etat"; kos=$((kos + 1)); fi
  done

  [[ $kos -eq 0 ]] || abandonner \
    "$kos service(s) ne démarrent pas." \
    "pm2 logs --lines 40
Cause fréquente pour gtfc-dashboard : le build manque (étape 9)."

  # Les sondes internes : un service « online » qui ne répond pas est pire
  # qu'un service arrêté, parce qu'on croit que tout va bien.
  curl -fsS --max-time 10 "http://${API_HOST:-127.0.0.1}:${API_PORT:-4000}/healthz" >/dev/null \
    || abandonner "L'API ne répond pas sur son port local." "pm2 logs gtfc-api --lines 40"
  ok "API joignable en local"

  local pret
  pret=$(curl -fsS --max-time 15 "http://${API_HOST:-127.0.0.1}:${API_PORT:-4000}/pret" 2>/dev/null || echo '')
  if echo "$pret" | grep -q '"statut":"pret"'; then
    ok "API : base et stockage opérationnels"
  else
    avertir "L'API répond mais signale un service dégradé"
    echo "$pret" | head -c 300 | sed 's/^/      /'
  fi

  curl -fsS --max-time 10 "http://${DASHBOARD_HOST:-127.0.0.1}:${DASHBOARD_PORT:-3000}/connexion" >/dev/null \
    || abandonner "Le tableau de bord ne répond pas." "pm2 logs gtfc-dashboard --lines 40"
  ok "Tableau de bord joignable en local"
}

# ============================================================================
#  11. Sauvegardes
# ============================================================================
etape_11() {
  if crontab -l 2>/dev/null | grep -q 'GTFC'; then
    ok "Tâches planifiées déjà installées"
  else
    info "Installation des sauvegardes automatiques…"
    executer bash "${RACINE}/scripts/install-cron.sh" </dev/null
  fi

  [[ "$SIMULATION" == "1" ]] && return 0

  crontab -l 2>/dev/null | grep -q 'backup-postgres' \
    || abandonner "Les sauvegardes ne sont pas planifiées." "bash scripts/install-cron.sh"
  ok "Sauvegarde quotidienne planifiée (03h15)"

  # Une sauvegarde jamais testée n'est pas une sauvegarde.
  if [[ -z "$(find "${BACKUP_DIR:-/var/backups/gtfc}" -name '*.dump' 2>/dev/null | head -1)" ]]; then
    info "Première sauvegarde de contrôle…"
    executer bash "${RACINE}/scripts/backup-postgres.sh"
  fi
  local derniere
  derniere=$(find "${BACKUP_DIR:-/var/backups/gtfc}" -name '*.dump' 2>/dev/null | head -1)
  [[ -n "$derniere" ]] || abandonner "Aucune sauvegarde produite." "bash scripts/backup-postgres.sh"
  ok "Sauvegarde vérifiée : $(basename "$derniere") ($(du -h "$derniere" | cut -f1))"
}

# ============================================================================
#  12. Recette finale
# ============================================================================
etape_12() {
  charger_env

  info "Contrôle de santé complet…"
  if [[ "$SIMULATION" == "0" ]]; then
    bash "${RACINE}/scripts/healthcheck.sh" || avertir "Le contrôle de santé signale des points à regarder"
  fi

  echo
  info "Accès publics (HTTPS) :"
  for hote in "api.${APP_DOMAIN}/healthz" "gtfc.${APP_DOMAIN}" "console.${APP_DOMAIN}"; do
    local code
    # PAS de « || echo 000 » : curl ECRIT DEJA 000 quand il ne joint rien, et
    # sort en erreur. Les deux se concatenaient en « 000000 », qui ne
    # correspondait plus au motif 000 ci-dessous : un hote TOTALEMENT
    # injoignable passait dans le cas generique, en simple avertissement.
    # Meme defaut que celui corrige dans scripts/healthcheck.sh.
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "https://${hote}" 2>/dev/null)
    case "$code" in
      200|301|302|307) ok "https://${hote} → $code" ;;
      000|"") echec "https://${hote} — injoignable depuis le serveur" ;;
      *)   avertir "https://${hote} → $code" ;;
    esac
  done

  echo
  info "Pour une recette fonctionnelle complète :"
  info "  bash scripts/recette.sh"
}

# ============================================================================
#  Exécution
# ============================================================================
# Ce qui bloquerait un deploiement reel. Compte en simulation seulement : en
# execution, abandonner() arrete tout des le premier obstacle, et c'est bien
# ce qu'on veut — on ne poursuit pas une installation sur un prerequis absent.
BLOCAGES=0
BLOQUANTES=()

for i in "${!ETAPES[@]}"; do
  n=$((i + 1))
  [[ $n -lt $DEPUIS || $n -gt $JUSQUA ]] && continue

  if deja_fait "etape-$n" && [[ $n -ne 12 ]]; then
    printf "  ${VERT}✓${NC} ${GRIS}%2d. %s — déjà fait${NC}\n" "$n" "${ETAPES[$i]}"
    continue
  fi

  titre "$n" "${ETAPES[$i]}"
  ETAPE_COURANTE="${ETAPES[$i]}"
  if [[ "$SIMULATION" == "1" ]]; then
    # « Montrer le plan » suppose de montrer AUSSI les etapes suivantes. Le
    # sous-shell borne l'abandon a l'etape en cours : sans lui, la simulation
    # s'arretait au premier prerequis manquant — le DNS, typiquement, qui
    # n'existe pas encore quand on prepare un serveur — et ne montrait jamais
    # les neuf etapes suivantes, c'est-a-dire l'essentiel du plan.
    if ! ( "etape_$n" ); then
      BLOCAGES=$((BLOCAGES + 1))
      BLOQUANTES+=("$n. ${ETAPES[$i]}")
    fi
  else
    "etape_$n"
    marquer_fait "etape-$n"
  fi
done

# ============================================================================
if [[ "$SIMULATION" == "1" && "$BLOCAGES" -gt 0 ]]; then
  echo
  echec "$BLOCAGES etape(s) bloqueraient un deploiement reel :"
  for e in "${BLOQUANTES[@]}"; do echo "    · $e"; done
  echo
  exit 1
fi

echo
echo "${GRAS}${VERT}━━━ Déploiement terminé ━━━${NC}"
echo
charger_env 2>/dev/null || true
echo "  ${GRAS}Tableau de bord${NC}   https://gtfc.${APP_DOMAIN:-VOTRE-DOMAINE}"
echo "  ${GRAS}API${NC}               https://api.${APP_DOMAIN:-VOTRE-DOMAINE}"
echo "  ${GRAS}Stockage${NC}          https://console.${APP_DOMAIN:-VOTRE-DOMAINE}"
echo
echo "  ${GRAS}Ensuite :${NC}"
echo "    bash scripts/recette.sh          recette fonctionnelle de bout en bout"
echo "    pm2 status                       état des services"
echo "    bash scripts/healthcheck.sh      contrôle de santé"
echo

if [[ "$SIMULATION" == "0" ]]; then
  provisoires=$(psql_admin -c "SELECT count(*) FROM app.v_donnees_a_remplacer" 2>/dev/null || echo 0)
  if [[ "${provisoires:-0}" -gt 0 ]]; then
    echo "  ${JAUNE}${GRAS}Avant toute émission réelle d'avis :${NC}"
    echo "    ${provisoires} données sont encore provisoires — barèmes inventés compris."
    echo "    Remplacez-les par les délibérations du conseil municipal."
    echo "    Détail : page Paramètres du tableau de bord, ou"
    echo "             SELECT * FROM app.v_donnees_a_remplacer;"
    echo
  fi
fi
