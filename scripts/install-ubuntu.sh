#!/usr/bin/env bash
# ============================================================================
#  Installation du serveur — Ubuntu Server 24.04 LTS
#  Plateforme de collecte des taxes locales GTFC
#
#  A EXÉCUTER UNE SEULE FOIS, sur un serveur fraîchement installé.
#
#  Usage :
#      sudo bash scripts/install-ubuntu.sh
#
#  Ce script installe : Docker + Compose, Node.js 20 LTS, PM2, pare-feu UFW,
#  fail2ban, mises à jour de sécurité automatiques, outils PostgreSQL client.
#  Il ne démarre AUCUN service applicatif — c'est l'objet de l'étape suivante.
# ============================================================================
set -Eeuo pipefail

# --- Utilitaires d'affichage ------------------------------------------------
BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
info()  { echo "${GREEN}[OK]${NC}    $*"; }
step()  { echo; echo "${BOLD}==> $*${NC}"; }
warn()  { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail()  { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

trap 'fail "Le script a échoué à la ligne $LINENO."' ERR

# --- Vérifications préalables -----------------------------------------------
[[ $EUID -eq 0 ]] || fail "Ce script doit être exécuté avec sudo : sudo bash $0"

if ! grep -q "Ubuntu" /etc/os-release 2>/dev/null; then
    warn "Système non identifié comme Ubuntu. Poursuite à vos risques."
    read -rp "Continuer ? [o/N] " r; [[ "$r" =~ ^[oO]$ ]] || exit 1
fi

UBUNTU_VERSION=$(. /etc/os-release && echo "$VERSION_ID")
info "Ubuntu détecté : ${UBUNTU_VERSION}"

# Utilisateur non-root qui pilotera Docker et PM2
TARGET_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"
[[ "$TARGET_USER" != "root" ]] || warn "Aucun utilisateur non-root détecté ; Docker restera réservé à root."
info "Utilisateur applicatif : ${TARGET_USER}"

# ============================================================================
step "1/10  Fuseau horaire et locales"
# ============================================================================
timedatectl set-timezone Africa/Dakar
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq locales >/dev/null
locale-gen fr_FR.UTF-8 C.UTF-8 >/dev/null
update-locale LANG=fr_FR.UTF-8 LC_ALL=C.UTF-8
info "Fuseau horaire : $(timedatectl show -p Timezone --value)"

# ============================================================================
step "2/10  Mise à jour du système"
# ============================================================================
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ca-certificates curl gnupg lsb-release apt-transport-https software-properties-common \
    git make jq unzip zip htop ncdu tree rsync \
    ufw fail2ban unattended-upgrades needrestart \
    cron \
    postgresql-client-16 || \
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-client
# cron n'est PAS garanti : les images Ubuntu minimales des hebergeurs ne le
# portent pas, et le deploiement s'arrete alors a l'etape 11 sur un
# « crontab: command not found » qui ne nomme aucun remede. Les sauvegardes
# quotidiennes en dependent : c'est au script qui prepare le serveur de le
# garantir, pas a l'operateur de le deviner.
systemctl enable --now cron >/dev/null 2>&1 || true
info "Paquets de base installés"

# ============================================================================
step "3/10  Docker Engine + Docker Compose"
# ============================================================================
if command -v docker >/dev/null 2>&1; then
    info "Docker déjà présent : $(docker --version)"
else
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    info "Docker installé : $(docker --version)"
fi

systemctl enable --now docker
[[ "$TARGET_USER" != "root" ]] && usermod -aG docker "$TARGET_USER" && \
    warn "‘${TARGET_USER}’ ajouté au groupe docker — déconnectez-vous/reconnectez-vous pour que ce soit effectif."

# Rotation des logs Docker : sans cela les logs saturent le disque en quelques mois
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "5" },
  "live-restore": true
}
JSON
systemctl restart docker
info "Rotation des logs Docker configurée"

# ============================================================================
step "4/10  Node.js 20 LTS + PM2"
# ============================================================================
if command -v node >/dev/null 2>&1 && [[ "$(node -v | cut -d. -f1 | tr -d v)" -ge 20 ]]; then
    info "Node.js déjà présent : $(node -v)"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
    info "Node.js installé : $(node -v)"
fi

npm install -g pm2@latest >/dev/null
info "PM2 installé : $(pm2 -v)"

# Redémarrage automatique de PM2 au boot du serveur (coupure de courant)
if [[ "$TARGET_USER" != "root" ]]; then
    env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$TARGET_USER" \
        --hp "/home/$TARGET_USER" >/dev/null
    info "PM2 configuré pour redémarrer au boot (utilisateur ${TARGET_USER})"
fi

# ============================================================================
step "5/10  Pare-feu UFW"
# ============================================================================
ufw --force reset >/dev/null
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp  comment 'SSH'   >/dev/null
# ufw REFUSE toute apostrophe dans un commentaire : « Let's Encrypt » faisait
# echouer la regle, et avec elle l'installation entiere a l'etape 5 sur 10.
# Le message, « ERROR: Invalid syntax », ne designe ni le caractere ni la ligne.
ufw allow 80/tcp  comment 'HTTP — validation du certificat et redirection' >/dev/null
ufw allow 443/tcp comment 'HTTPS' >/dev/null
ufw --force enable >/dev/null
info "Pare-feu actif — ports ouverts : 22, 80, 443"
warn "PostgreSQL (5432) et MinIO (9000/9001) ne sont PAS exposés : c'est voulu."

# ============================================================================
step "6/10  fail2ban (protection SSH)"
# ============================================================================
cat > /etc/fail2ban/jail.local <<'INI'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
INI
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban
info "fail2ban actif"

# ============================================================================
step "7/10  Mises à jour de sécurité automatiques"
# ============================================================================
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
cat > /etc/apt/apt.conf.d/51gtfc-unattended <<'CONF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
systemctl enable --now unattended-upgrades >/dev/null
info "Mises à jour de sécurité automatiques activées (sans redémarrage auto)"

# ============================================================================
step "8/10  Réglages noyau"
# ============================================================================
cat > /etc/sysctl.d/99-gtfc.conf <<'CONF'
# Mémoire partagée : PostgreSQL avec shared_buffers élevé
kernel.shmmax = 68719476736
kernel.shmall = 16777216

# Le SGBD ne doit pas être poussé au swap
vm.swappiness = 10
# On laisse vm.overcommit_memory à la valeur par défaut (0) : le réglage « 2 »
# recommandé pour un serveur PostgreSQL dédié fait échouer les compilations
# Next.js et les builds Docker sur une machine de 16 Go.
vm.dirty_background_ratio = 5
vm.dirty_ratio = 15

# Réseau : file d'attente suffisante pour les synchronisations en rafale
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300

# Nombre de fichiers ouverts (Nginx + Node + Postgres)
fs.file-max = 2097152
CONF
sysctl --system >/dev/null
info "Paramètres noyau appliqués"

cat > /etc/security/limits.d/99-gtfc.conf <<'CONF'
*    soft nofile 65535
*    hard nofile 65535
root soft nofile 65535
root hard nofile 65535
CONF

# ============================================================================
step "9/10  Arborescence des données et sauvegardes"
# ============================================================================
mkdir -p /var/backups/gtfc/{daily,weekly,monthly,minio}
mkdir -p /var/log/gtfc
chmod 750 /var/backups/gtfc
if [[ "$TARGET_USER" != "root" ]]; then
    chown -R "$TARGET_USER":"$TARGET_USER" /var/backups/gtfc /var/log/gtfc
fi
info "Dossiers créés : /var/backups/gtfc, /var/log/gtfc"

# Rotation des logs applicatifs
cat > /etc/logrotate.d/gtfc <<'CONF'
/var/log/gtfc/*.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
CONF
info "Rotation des logs applicatifs configurée"

# ============================================================================
step "10/10  Vérification finale"
# ============================================================================
echo
echo "${BOLD}--------------------------------------------------------------${NC}"
printf "  %-22s %s\n" "Docker"          "$(docker --version 2>/dev/null || echo 'ABSENT')"
printf "  %-22s %s\n" "Docker Compose"  "$(docker compose version --short 2>/dev/null || echo 'ABSENT')"
printf "  %-22s %s\n" "Node.js"         "$(node -v 2>/dev/null || echo 'ABSENT')"
printf "  %-22s %s\n" "npm"             "$(npm -v 2>/dev/null || echo 'ABSENT')"
printf "  %-22s %s\n" "PM2"             "$(pm2 -v 2>/dev/null || echo 'ABSENT')"
printf "  %-22s %s\n" "psql"            "$(psql --version 2>/dev/null | awk '{print $3}' || echo 'ABSENT')"
printf "  %-22s %s\n" "Pare-feu"        "$(ufw status | head -1)"
printf "  %-22s %s\n" "Fuseau horaire"  "$(timedatectl show -p Timezone --value)"
printf "  %-22s %s\n" "RAM"             "$(free -h | awk '/^Mem:/{print $2}')"
printf "  %-22s %s\n" "Disque /"        "$(df -h / | awk 'NR==2{print $4" libres sur "$2}')"
echo "${BOLD}--------------------------------------------------------------${NC}"
echo
info "INSTALLATION DU SERVEUR TERMINÉE"
echo
echo "${BOLD}Étapes suivantes :${NC}"
echo "  1. Déconnectez-vous puis reconnectez-vous (prise en compte du groupe docker)"
echo "  2. cp .env.template .env  &&  nano .env      # remplir toutes les valeurs A_REMPLIR"
echo "  3. chmod 600 .env"
echo "  4. Vérifiez que le DNS pointe vers ce serveur :"
echo "       dig +short VOTRE-DOMAINE   →  doit renvoyer l'IP publique de ce serveur"
echo "  5. bash scripts/init-ssl.sh                  # certificats Let's Encrypt"
echo "  6. docker compose up -d                      # démarrage de l'infrastructure"
echo "  7. bash scripts/install-cron.sh              # sauvegardes quotidiennes"
echo
