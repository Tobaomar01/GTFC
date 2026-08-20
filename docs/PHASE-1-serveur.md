# Phase 1 — Configuration du serveur

**Objectif** : disposer d'un serveur Ubuntu opérationnel, avec PostgreSQL 16 + PostGIS,
MinIO, Nginx en HTTPS et des sauvegardes automatiques — **avant** d'écrire la moindre
ligne de code applicatif.

**Durée estimée** : 2 jours, dont l'essentiel en attente (livraison du matériel,
propagation DNS, activation de l'IP statique Sonatel).

---

## Ce que j'ai généré

| Fichier | Rôle |
|---|---|
| `docker-compose.yml` | Lance PostgreSQL+PostGIS, MinIO, Nginx et Certbot en une commande |
| `.env.template` | Toutes les variables de configuration, à copier en `.env` |
| `infra/postgres/postgresql.conf` | Réglages PostgreSQL (mémoire, autovacuum, journalisation) |
| `infra/postgres/init/01-extensions.sh` | Installe PostGIS, pgcrypto, unaccent, pg_trgm… |
| `infra/postgres/init/02-app-role.sh` | Crée le rôle applicatif à droits limités + les schémas `app`, `ref`, `audit` |
| `infra/minio/init-buckets.sh` | Crée les 3 buckets, l'utilisateur applicatif et sa politique d'accès |
| `infra/nginx/nginx.conf` | Configuration Nginx principale (limitation de débit, compression, journaux) |
| `infra/nginx/templates/10-plateforme.conf.template` | Les hôtes : API, dashboard, S3, console |
| `infra/nginx/snippets/` | Réglages TLS, en-têtes proxy, en-têtes de sécurité |
| `scripts/install-ubuntu.sh` | Installe Docker, Node 20, PM2, UFW, fail2ban, réglages noyau |
| `scripts/init-ssl.sh` | Obtient les certificats Let's Encrypt |
| `scripts/add-commune-domain.sh` | Ajoute le sous-domaine d'une nouvelle commune |
| `scripts/backup-postgres.sh` | Sauvegarde quotidienne + rotation + contrôle d'intégrité |
| `scripts/backup-minio.sh` | Sauvegarde incrémentale des photos |
| `scripts/restore-postgres.sh` | Restauration guidée |
| `scripts/healthcheck.sh` | Contrôle de santé complet de la plateforme |
| `scripts/install-cron.sh` | Installe les tâches planifiées |
| `ecosystem.config.js` | Configuration PM2 pour l'API et le dashboard (phases 3 et 6) |
| `Makefile` | Raccourcis : `make up`, `make health`, `make backup`… |

**Choix d'architecture** : l'infrastructure tourne dans Docker, mais l'API Node.js et
le dashboard Next.js tourneront **directement sur l'hôte** avec PM2. C'est ce que
demande le cahier des charges (Docker *et* PM2), et cela évite de reconstruire une
image à chaque correction de code — appréciable quand la connexion est lente.

---

## Ce que vous devez faire — étape par étape

### Étape 0 — Matériel (à commander maintenant, avant tout le reste)

| Élément | Spécification minimale | Recommandé |
|---|---|---|
| Mini PC | 4 cœurs, 8 Go RAM, SSD 256 Go | 6–8 cœurs, **16 Go RAM**, **NVMe 512 Go** |
| Onduleur (UPS) | 650 VA | 1000 VA (≈ 30 min d'autonomie) |
| Disque de sauvegarde | USB 3.0, 1 To | SSD externe 1 To |

> **Pourquoi 16 Go** : PostGIS avec 5 443 commerces géolocalisés, plus MinIO qui
> stockera 2 photos par commerce (≈ 11 000 photos, 15–20 Go). 8 Go fonctionne pour
> le pilote, mais sature dès la 3ᵉ ou 4ᵉ commune.

En parallèle, lancez les démarches longues :
- **Sonatel Business** : demande d'IP statique (comptez 1 à 3 semaines)
- **Nom de domaine** : `.sn` via le NIC Sénégal, ou un `.com` chez un registrar international

---

### Étape 1 — Installer Ubuntu Server 24.04 LTS

Sur le Mini PC, avec une clé USB préparée avec Rufus ou balenaEtcher.

Pendant l'installation :
- **Nom de machine** : `gtfc-server`
- **Utilisateur** : `gtfc` (pas `root`)
- **Partitionnement** : utiliser tout le disque, LVM activé
- **Cocher « Install OpenSSH server »**
- Ne cocher aucun snap

Après le premier démarrage, notez l'adresse IP locale :

```bash
ip -4 addr show | grep inet
```

Fixez cette IP dans votre box (bail DHCP statique) — le serveur doit toujours
avoir la même adresse locale.

---

### Étape 2 — Copier le projet sur le serveur

Depuis votre poste Windows, dans PowerShell :

```powershell
# Remplacez 192.168.1.50 par l'IP locale du serveur
scp -r "C:\Users\DELL\Desktop\GTFC" gtfc@192.168.1.50:~/gtfc-platform
```

Puis connectez-vous :

```bash
ssh gtfc@192.168.1.50
cd ~/gtfc-platform
```

> **Point d'attention Windows → Linux** : si un script refuse de démarrer avec
> le message `bad interpreter: /usr/bin/env bash^M`, c'est que les fins de ligne
> sont au format Windows. Corrigez d'un coup :
> ```bash
> sudo apt install -y dos2unix && find . -name '*.sh' -exec dos2unix {} \;
> ```

---

### Étape 3 — Installer le serveur

```bash
sudo bash scripts/install-ubuntu.sh
```

Le script installe Docker, Docker Compose, Node.js 20, PM2, le pare-feu UFW,
fail2ban et les mises à jour de sécurité automatiques. Il affiche un récapitulatif
à la fin.

**Déconnectez-vous puis reconnectez-vous** (`exit` puis `ssh` à nouveau) pour que
l'appartenance au groupe `docker` soit prise en compte.

Vérifiez :

```bash
docker run --rm hello-world     # doit fonctionner SANS sudo
node -v                          # v20.x
pm2 -v
```

---

### Étape 4 — Configurer le DNS

Chez votre registrar, créez ces enregistrements **A**, tous vers l'IP publique
statique fournie par Sonatel :

| Nom | Type | Valeur |
|---|---|---|
| `@` (racine) | A | `<IP statique>` |
| `www` | A | `<IP statique>` |
| `api` | A | `<IP statique>` |
| `s3` | A | `<IP statique>` |
| `console` | A | `<IP statique>` |
| `gtfc` | A | `<IP statique>` |

Sur votre box/routeur Sonatel, redirigez les ports **80** et **443** vers l'IP
locale du serveur.

Attendez la propagation (15 min à 24 h), puis vérifiez depuis le serveur :

```bash
for s in "" www. api. s3. console. gtfc.; do
  echo -n "$s VOTRE-DOMAINE -> "; dig +short "${s}VOTRE-DOMAINE"
done
curl -s https://api.ipify.org    # doit afficher la même IP
```

---

### Étape 5 — Remplir le fichier `.env`

```bash
cd ~/gtfc-platform
cp .env.template .env

# Générez trois secrets solides et notez-les
openssl rand -base64 48   # -> JWT_SECRET
openssl rand -base64 32   # -> DB_PASSWORD
openssl rand -base64 32   # -> MINIO_SECRET_KEY

nano .env
chmod 600 .env
```

**À remplir obligatoirement pour la phase 1** (le reste viendra aux phases suivantes) :

| Variable | Valeur |
|---|---|
| `APP_DOMAIN` | votre domaine, sans `https://` ni slash |
| `LETSENCRYPT_EMAIL` | votre email réel (alertes d'expiration) |
| `DB_PASSWORD`, `DB_SUPERUSER_PASSWORD` | mots de passe générés |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | identifiants admin MinIO |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | identifiants applicatifs MinIO |
| `JWT_SECRET` | secret généré |
| `CORS_ORIGINS`, `NEXT_PUBLIC_API_URL`, `WAVE_WEBHOOK_URL` | remplacer `A_REMPLIR.sn` par votre domaine |

Ajustez aussi la mémoire PostgreSQL selon la RAM réelle :

| RAM du Mini PC | `PG_SHARED_BUFFERS` | `PG_EFFECTIVE_CACHE_SIZE` |
|---|---|---|
| 8 Go | `2GB` | `6GB` |
| 16 Go | `4GB` | `12GB` |
| 32 Go | `8GB` | `24GB` |

> **Conservez une copie du `.env` hors du serveur** (gestionnaire de mots de passe).
> Sans ces valeurs, les sauvegardes de la base sont inexploitables.

---

### Étape 6 — Obtenir les certificats HTTPS

```bash
bash scripts/init-ssl.sh
```

Le script vérifie le DNS, dépose un certificat temporaire, démarre Nginx, contrôle
que le défi Let's Encrypt est bien accessible depuis Internet, puis demande le vrai
certificat.

> **Premier essai ?** Mettez `LETSENCRYPT_STAGING=1` dans le `.env` pour tester sans
> consommer le quota Let's Encrypt (5 échecs par heure et par domaine). Une fois que
> le script se déroule sans erreur, repassez à `0` et relancez.

---

### Étape 7 — Démarrer l'infrastructure

```bash
docker compose up -d
docker compose ps
```

Vous devez voir :

| Conteneur | État attendu |
|---|---|
| `gtfc-postgres` | `Up (healthy)` |
| `gtfc-minio` | `Up (healthy)` |
| `gtfc-nginx` | `Up (healthy)` |
| `gtfc-certbot` | `Up` |
| `gtfc-nginx-reloader` | `Up` |
| `gtfc-minio-init` | `Exited (0)` — **c'est normal**, il a fini son travail |

Suivez le démarrage de la base :

```bash
docker compose logs -f postgres
# Attendez : « database system is ready to accept connections »
```

---

### Étape 8 — Vérifier

```bash
bash scripts/healthcheck.sh
```

Contrôles manuels complémentaires :

```bash
# PostGIS répond
docker exec gtfc-postgres psql -U postgres -d gtfc_taxes -c "SELECT PostGIS_Version();"

# Détection d'un point GPS — le cœur de la localisation des commerces
docker exec gtfc-postgres psql -U postgres -d gtfc_taxes \
  -c "SELECT ST_AsText(ST_SetSRID(ST_MakePoint(-17.4467, 14.6928), 4326));"

# Buckets MinIO
docker compose logs minio-init | tail -20
```

Dans un navigateur :

- `https://console.VOTRE-DOMAINE` → console MinIO, connexion avec `MINIO_ROOT_USER`
- `https://api.VOTRE-DOMAINE` → **502 Bad Gateway attendu** (l'API arrive en phase 3)
- `https://gtfc.VOTRE-DOMAINE` → **502 Bad Gateway attendu** (dashboard en phase 6)
- Le cadenas doit être vert sur les trois

> Une **502** ici est le résultat correct : Nginx fonctionne et cherche un backend
> qui n'existe pas encore.

---

### Étape 9 — Activer les sauvegardes

Branchez le disque externe, puis :

```bash
lsblk                                    # repérez le disque, ex. /dev/sdb1
sudo mkdir -p /mnt/backup-externe
sudo mount /dev/sdb1 /mnt/backup-externe

# Montage permanent
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdb1) /mnt/backup-externe ext4 defaults,nofail 0 2" \
  | sudo tee -a /etc/fstab
```

Renseignez `BACKUP_MIRROR_DIR=/mnt/backup-externe/gtfc` dans le `.env`, puis :

```bash
bash scripts/install-cron.sh
```

Vérifiez :

```bash
crontab -l
ls -lh /var/backups/gtfc/daily/
```

---

## Critères de validation de la phase 1

Cochez chaque point avant de passer à la phase 2 :

- [ ] `docker compose ps` : tous les conteneurs `Up`, `minio-init` en `Exited (0)`
- [ ] `bash scripts/healthcheck.sh` se termine sans erreur (des avertissements PM2 sont normaux)
- [ ] `https://console.VOTRE-DOMAINE` s'ouvre avec un cadenas vert
- [ ] `SELECT PostGIS_Version();` renvoie une version
- [ ] Le rôle `gtfc_app` se connecte à la base
- [ ] Les 3 buckets MinIO existent
- [ ] Une sauvegarde est présente dans `/var/backups/gtfc/daily/`
- [ ] `sudo reboot` → tout redémarre seul, sans intervention

Le dernier point est le plus important : les coupures de courant sont fréquentes à
Dakar, et l'onduleur ne couvre que quelques dizaines de minutes.

---

## En cas de problème

| Symptôme | Cause probable | Correctif |
|---|---|---|
| `bad interpreter: ...^M` | Fins de ligne Windows | `dos2unix scripts/*.sh` |
| `permission denied` sur `/var/run/docker.sock` | Groupe docker non pris en compte | Se déconnecter/reconnecter |
| Certbot : `Timeout during connect` | Port 80 non redirigé sur la box | Vérifier le NAT du routeur Sonatel |
| Certbot : `DNS problem: NXDOMAIN` | DNS non propagé | Attendre, vérifier avec `dig` |
| `nginx: host not found in upstream "minio"` | MinIO pas encore démarré | `docker compose up -d minio` puis `docker compose restart nginx` |
| Postgres redémarre en boucle | Valeur mémoire trop élevée dans `.env` | Réduire `PG_SHARED_BUFFERS` |
| `minio-init` échoue | Mot de passe MinIO < 8 caractères | Corriger le `.env`, puis `docker compose down -v && docker compose up -d` |

> **Attention** : `docker compose down -v` **supprime les volumes**, donc toutes les
> données. En phase 1 c'est sans conséquence ; ne le faites plus jamais ensuite.

Journaux utiles :

```bash
docker compose logs -f postgres
docker compose logs -f nginx
tail -f infra/certbot/log/letsencrypt.log
tail -f /var/log/gtfc/cron.log
```

---

## Ensuite

Quand tous les critères de validation sont cochés, dites-le-moi : je génère la
**phase 2 — base de données** (schéma multi-communes et multi-taxes, migrations
versionnées, fonctions PostGIS de détection du quartier, seed data GTFC).

Pour la phase 2, j'aurai besoin de trois informations que je ne peux pas inventer :
les noms des 3 zones et 15 quartiers, les 21 catégories de commerces, et les barèmes
exacts des taxes. Le détail est dans `docs/QUESTIONS-PHASE-2.md`.
