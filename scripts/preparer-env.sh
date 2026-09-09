#!/usr/bin/env bash
#
# Fabrique le fichier .env de cette installation.
#
#   bash scripts/preparer-env.sh
#
# POURQUOI CE SCRIPT EXISTE.
#
# Le modèle porte douze valeurs « A_REMPLIR », dont sept secrets. Les remplir à
# la main, c'est lancer six fois `openssl rand`, recopier six chaînes dans un
# éditeur en console, et se tromper une fois sur deux. Le déploiement s'arrête
# alors à l'étape 3 sur un message juste mais tardif — après avoir installé
# Docker, PostgreSQL et MinIO.
#
# Le script ne demande QUE ce que la machine ne peut pas deviner : le domaine
# et l'adresse électronique pour Let's Encrypt. Il fabrique le reste.
#
# CE QU'IL NE FAIT PAS. Il ne touche ni à Wave ni à l'opérateur SMS : ces
# deux-là restent en simulation tant que la mairie n'a pas ouvert ses comptes,
# et toute la chaîne fonctionne ainsi — les liens de paiement sont fabriqués
# localement, les codes SMS s'écrivent dans le journal du serveur.
#
# LES SECRETS SONT ALPHANUMÉRIQUES, ET C'EST DÉLIBÉRÉ.
#
# `openssl rand -base64` produit des « / », des « + » et des « = ». Ces
# caractères traversent mal : docker-compose interprète le « $ », une URL de
# connexion PostgreSQL exige que le « / » soit encodé, et un mot de passe
# recopié à la main se casse sur un « = » final. On tire donc dans l'alphabet
# qui passe partout, en tirant plus long pour garder la même solidité.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELE="${RACINE}/.env.template"
CIBLE="${RACINE}/.env"

VERT='\033[0;32m'; ROUGE='\033[0;31m'; JAUNE='\033[0;33m'; GRAS='\033[1m'; NEUTRE='\033[0m'
dire()      { printf '%b\n' "$*"; }
succes()    { dire "  ${VERT}✓${NEUTRE} $*"; }
avertir()   { dire "  ${JAUNE}!${NEUTRE} $*"; }
abandonner(){ dire "\n  ${ROUGE}✗${NEUTRE} $*\n"; exit 1; }

[[ -f "$MODELE" ]] || abandonner "Modèle introuvable : $MODELE"

# ---------------------------------------------------------------------------
#  Ne jamais écraser un .env existant sans le dire.
#
#  Il contient des mots de passe qui sont peut-être DÉJÀ ceux de la base en
#  service. Les remplacer rendrait la base inaccessible, et la sauvegarde de la
#  veille irrécupérable sans le mot de passe d'avant.
# ---------------------------------------------------------------------------
if [[ -e "$CIBLE" ]]; then
  avertir "${GRAS}${CIBLE} existe déjà.${NEUTRE}"
  dire    "    Il contient probablement les mots de passe de la base EN SERVICE."
  dire    "    Les remplacer la rendrait inaccessible, et vos sauvegardes"
  dire    "    illisibles sans les anciens.\n"
  if [[ ! -t 0 ]]; then
    abandonner "Refus d'écraser sans confirmation possible (entrée non interactive)."
  fi
  read -r -p "  Écrire par-dessus ? Tapez REMPLACER en toutes lettres : " reponse
  [[ "$reponse" == "REMPLACER" ]] || abandonner "Rien n'a été touché."
  horodatage="$(date +%Y%m%d-%H%M%S)"
  cp "$CIBLE" "${CIBLE}.${horodatage}.bak"
  chmod 600 "${CIBLE}.${horodatage}.bak"
  succes "Ancien fichier conservé : .env.${horodatage}.bak"
fi

# ---------------------------------------------------------------------------
#  Ce que la machine ne peut pas deviner.
# ---------------------------------------------------------------------------
demander() {
  local invite="$1" motif="$2" refus="$3" valeur=""
  while true; do
    read -r -p "  ${invite}" valeur
    [[ "$valeur" =~ $motif ]] && { printf '%s' "$valeur"; return; }
    dire "  ${ROUGE}${refus}${NEUTRE}"
  done
}

dire "\n${GRAS}Configuration de cette installation${NEUTRE}\n"

if [[ -t 0 ]]; then
  DOMAINE=$(demander "Domaine, sans https:// ni slash (ex. taxes-gtfc.com) : " \
    '^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$' \
    "Domaine invalide. Attendu : quelque-chose.com — sans http, sans slash.")
  COURRIEL=$(demander "Adresse électronique réelle pour Let's Encrypt : " \
    '^[^@[:space:]]+@[^@[:space:]]+\.[a-zA-Z]{2,}$' \
    "Adresse invalide. C'est là que partiront les alertes d'expiration du certificat.")
else
  DOMAINE="${APP_DOMAIN:-}"
  COURRIEL="${LETSENCRYPT_EMAIL:-}"
  [[ -n "$DOMAINE" && -n "$COURRIEL" ]] \
    || abandonner "Entrée non interactive : posez APP_DOMAIN et LETSENCRYPT_EMAIL."
fi

# ---------------------------------------------------------------------------
#  Répétition ou installation réelle ? La réponse décide d'UN réglage, et il
#  touche à la sécurité — il n'est donc pas posé en douce.
#
#  Sans passerelle SMS, l'API REFUSE de démarrer en production : le code à
#  usage unique repartirait en clair dans la réponse HTTP, et connaître un
#  numéro suffirait à ouvrir le dossier fiscal de son propriétaire.
#  SMS_SIMULER_EN_PROD=true lève ce refus. C'est exactement ce qu'il faut sur
#  un banc d'essai, et exactement ce qu'il ne faut pas ailleurs.
#
#  Le guide de répétition disait « laissez SMS_ACTIF=false » sans mentionner ce
#  second réglage : le déploiement s'arrêtait à l'étape 7, après avoir installé
#  Docker, PostgreSQL et MinIO.
# ---------------------------------------------------------------------------
SIMULER_SMS=false
if [[ -t 0 ]]; then
  dire ""
  dire "  Cette machine est-elle un ${GRAS}banc d'essai${NEUTRE} — aucun redevable réel,"
  dire "  détruite après la répétition ?"
  read -r -p "  Répondez oui ou non : " essai
  case "${essai,,}" in
    o|oui|y|yes) SIMULER_SMS=true ;;
    *)           SIMULER_SMS=false ;;
  esac
else
  SIMULER_SMS="${SMS_SIMULER_EN_PROD:-false}"
fi

# ---------------------------------------------------------------------------
#  Les secrets.
# ---------------------------------------------------------------------------
command -v openssl >/dev/null 2>&1 || abandonner "openssl est absent de cette machine."

# Alphanumérique uniquement — voir l'en-tête. On tire large puis on coupe :
# `tr -dc` supprime ce qui ne convient pas, donc il faut de la marge.
secret() {
  local longueur="$1"
  openssl rand -base64 $(( longueur * 3 )) | tr -dc 'A-Za-z0-9' | head -c "$longueur"
  echo
}

DB_PASSWORD=$(secret 40)
DB_SUPERUSER_PASSWORD=$(secret 40)
JWT_SECRET=$(secret 64)
MINIO_ROOT_USER="gtfc_admin_$(secret 8)"
MINIO_ROOT_PASSWORD=$(secret 40)
MINIO_ACCESS_KEY="gtfc_app_$(secret 8)"
MINIO_SECRET_KEY=$(secret 40)
WAVE_WEBHOOK_SECRET=$(secret 44)

# ---------------------------------------------------------------------------
#  Écriture.
#
#  On remplace ligne par ligne plutôt que par un `sed` global : une valeur
#  tirée au sort peut contenir n'importe quelle suite de caractères, et un
#  `sed s/…/$SECRET/` finirait par tomber sur un secret qui casse sa propre
#  commande. Ici la substitution se fait en bash, sans réinterprétation.
# ---------------------------------------------------------------------------
poser() {
  local cle="$1" valeur="$2"
  local trouve=0 ligne
  local tampon="${CIBLE}.encours"
  : > "$tampon"
  while IFS= read -r ligne || [[ -n "$ligne" ]]; do
    if [[ "$ligne" == "${cle}="* ]]; then
      printf '%s=%s\n' "$cle" "$valeur" >> "$tampon"
      trouve=1
    else
      printf '%s\n' "$ligne" >> "$tampon"
    fi
  done < "$CIBLE"
  mv "$tampon" "$CIBLE"
  [[ "$trouve" == 1 ]] || abandonner "La clé ${cle} n'existe pas dans le modèle."
}

cp "$MODELE" "$CIBLE"
chmod 600 "$CIBLE"

poser APP_DOMAIN            "$DOMAINE"
poser LETSENCRYPT_EMAIL     "$COURRIEL"
poser DB_PASSWORD           "$DB_PASSWORD"
poser DB_SUPERUSER_PASSWORD "$DB_SUPERUSER_PASSWORD"
poser JWT_SECRET            "$JWT_SECRET"
poser MINIO_ROOT_USER       "$MINIO_ROOT_USER"
poser MINIO_ROOT_PASSWORD   "$MINIO_ROOT_PASSWORD"
poser MINIO_ACCESS_KEY      "$MINIO_ACCESS_KEY"
poser MINIO_SECRET_KEY      "$MINIO_SECRET_KEY"
poser WAVE_WEBHOOK_SECRET   "$WAVE_WEBHOOK_SECRET"
poser CORS_ORIGINS          "https://gtfc.${DOMAINE},https://portail.${DOMAINE}"
poser WAVE_WEBHOOK_URL      "https://api.${DOMAINE}/webhooks/wave"
poser SMS_SIMULER_EN_PROD   "$SIMULER_SMS"

dire ""
if [[ "$SIMULER_SMS" == "true" ]]; then
  avertir "${GRAS}SMS_SIMULER_EN_PROD=true${NEUTRE} — les codes à usage unique s'afficheront"
  dire    "    dans le journal du serveur au lieu d'être envoyés. Cette machine ne"
  dire    "    doit porter AUCUNE donnée réelle."
else
  avertir "${GRAS}SMS_SIMULER_EN_PROD=false${NEUTRE} — l'API refusera de démarrer tant qu'une"
  dire    "    passerelle SMS n'est pas raccordée (SMS_ACTIF, SMS_FOURNISSEUR,"
  dire    "    SMS_BASE_URL, SMS_API_KEY). C'est le comportement voulu sur une"
  dire    "    installation qui portera de vrais redevables."
fi

# ---------------------------------------------------------------------------
#  Vérification : ce fichier est-il vraiment prêt ?
#
#  Une valeur d'exemple oubliée ne se voit pas à la relecture — elle ressemble
#  à une vraie. Le déploiement, lui, s'arrête dessus une demi-heure plus tard.
# ---------------------------------------------------------------------------
dire ""
restants=$(grep -n 'A_REMPLIR' "$CIBLE" | grep -v '^[0-9]*:#' || true)
if [[ -n "$restants" ]]; then
  dire "  ${JAUNE}Restent à remplir, et c'est normal à ce stade :${NEUTRE}"
  printf '%s\n' "$restants" | sed 's/^/    /'
  dire "\n    Ces valeurs appartiennent à Wave et à l'opérateur SMS. Tant que"
  dire "    WAVE_ACTIF et SMS_ACTIF valent false, la chaîne entière fonctionne"
  dire "    sans elles : les liens de paiement sont fabriqués localement et les"
  dire "    codes SMS s'écrivent dans le journal du serveur."
else
  succes "Aucune valeur d'exemple ne subsiste."
fi

dire "\n${GRAS}Écrit :${NEUTRE} ${CIBLE}  (droits 600, lisible par vous seul)"
dire "${GRAS}Domaine :${NEUTRE} ${DOMAINE}"
dire "\n  Les trois enregistrements DNS à créer chez votre registrar :\n"
dire "    api.${DOMAINE}       A    <adresse IP du serveur>"
dire "    gtfc.${DOMAINE}      A    <adresse IP du serveur>"
dire "    portail.${DOMAINE}   A    <adresse IP du serveur>"
dire "\n  Vérifiez la propagation avant de déployer :\n"
dire "    dig +short api.${DOMAINE}"
dire "\n  Puis :\n"
dire "    bash scripts/deployer.sh --simulation"
dire "    bash scripts/deployer.sh"
dire ""
dire "  ${GRAS}Sauvegardez ce fichier hors de la machine.${NEUTRE} Sans DB_PASSWORD,"
dire "  une sauvegarde PostgreSQL est un fichier que personne ne peut relire.\n"
