#!/usr/bin/env bash

# Nom du conteneur PostgreSQL. Variable plutôt que figé : la démonstration
# locale utilise gtfc-demo-db, et un serveur peut en héberger plusieurs.
PG_CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"
# ============================================================================
#  Restauration de la base PostgreSQL à partir d'une sauvegarde
#  Plateforme GTFC
#
#  Usage :
#      bash scripts/restore-postgres.sh                       # menu interactif
#      bash scripts/restore-postgres.sh /chemin/vers/x.dump    # fichier précis
#
#  OPÉRATION DESTRUCTIVE : la base courante est renommée puis remplacée.
#  L'ancienne base est conservée sous le nom <base>_avant_restauration_<date>
#  et n'est PAS supprimée automatiquement — à vous de la supprimer une fois
#  la restauration validée.
# ============================================================================
set -Eeuo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
info() { echo "${GREEN}[OK]${NC}    $*"; }
step() { echo; echo "${BOLD}==> $*${NC}"; }
warn() { echo "${YELLOW}[ATTENTION]${NC} $*"; }
fail() { echo "${RED}[ERREUR]${NC} $*" >&2; exit 1; }

cd "$(dirname "$0")/.."
[[ -f .env ]] || fail ".env introuvable"
# shellcheck disable=SC1091

# ---------------------------------------------------------------------------
#  L'environnement de l'APPELANT prime sur .env.
#
#  « set -a; source .env » ecrase les variables deja posees. Sans cette
#  precaution, DB_NAME passe en
#  ligne de commande est ignore en
#  silence, et le script travaille ailleurs que la ou on le croit. Un script
#  qu'on ne peut pas diriger vers un bac a sable est un script qu'on n'eprouve
#  jamais — et, ici, une operation qui peut se tromper de cible.
# ---------------------------------------------------------------------------
_APPELANT_DB_NAME="${DB_NAME:-}"
set -a; source .env; set +a
[[ -n "$_APPELANT_DB_NAME" ]] && DB_NAME="$_APPELANT_DB_NAME"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/gtfc}"
CONTAINER="$PG_CONTENEUR"

docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true \
    || fail "Le conteneur ${CONTAINER} n'est pas démarré."

# --- Choix du fichier -------------------------------------------------------
if [[ $# -ge 1 ]]; then
    DUMP_FILE="$1"
else
    step "Sauvegardes disponibles"
    mapfile -t FILES < <(find "$BACKUP_DIR" -name '*.dump' -type f -printf '%T@ %p\n' \
                          | sort -rn | cut -d' ' -f2-)
    [[ ${#FILES[@]} -gt 0 ]] || fail "Aucune sauvegarde trouvée dans ${BACKUP_DIR}"
    for i in "${!FILES[@]}"; do
        printf "  %2d) %-60s %8s  %s\n" "$((i+1))" \
            "$(basename "${FILES[$i]}")" \
            "$(du -h "${FILES[$i]}" | cut -f1)" \
            "$(date -r "${FILES[$i]}" '+%d/%m/%Y %H:%M')"
    done
    echo
    read -rp "Numéro de la sauvegarde à restaurer : " n
    [[ "$n" =~ ^[0-9]+$ && "$n" -ge 1 && "$n" -le ${#FILES[@]} ]] || fail "Choix invalide."
    DUMP_FILE="${FILES[$((n-1))]}"
fi

[[ -f "$DUMP_FILE" ]] || fail "Fichier introuvable : ${DUMP_FILE}"

# --- Vérifications ----------------------------------------------------------
step "Vérification de l'archive"
if [[ -f "${DUMP_FILE}.sha256" ]]; then
    (cd "$(dirname "$DUMP_FILE")" && sha256sum -c "$(basename "$DUMP_FILE").sha256" >/dev/null) \
        && info "Somme de contrôle SHA-256 valide" \
        || fail "Somme de contrôle INVALIDE — l'archive est corrompue."
else
    warn "Pas de fichier .sha256 associé — intégrité non vérifiable."
fi
# DANS LE CONTENEUR, comme la restauration elle-meme quelques lignes plus bas.
# L'hote porte postgresql-client-16 (install-ubuntu.sh) alors que le serveur
# tourne en PostgreSQL 17 : le pg_restore de 16 refusait le format 1.16 —
#     pg_restore: error: unsupported version (1.16) in file header
# La verification prealable rejetait donc TOUTE sauvegarde valide, et la
# restauration s'arretait avant d'avoir commence. La commune n'aurait pas pu
# restaurer, meme en possedant une archive parfaite. Meme defaut que celui
# corrige dans scripts/backup-postgres.sh.
LISTE_ARCHIVE="$(docker exec -i "$CONTAINER" pg_restore --list < "$DUMP_FILE" 2>/dev/null)" || fail "Archive illisible."
NB_OBJETS=$(echo "$LISTE_ARCHIVE" | grep -cv '^;' || true)
info "Archive lisible — ${NB_OBJETS} objets"

# --- Confirmation -----------------------------------------------------------
echo
warn "La base '${DB_NAME}' va être REMPLACÉE par le contenu de :"
echo "      $(basename "$DUMP_FILE")  ($(date -r "$DUMP_FILE" '+%d/%m/%Y %H:%M'))"
echo
# SANS TERMINAL, ON REFUSE — et on le DIT.
#
# Le « read » rencontrait une fin de fichier, rendait un code non nul, et
# set -e arretait tout : code 1, aucun message. L'operateur qui lance ce
# script depuis une tache, un ssh non interactif ou un outil ne voyait RIEN,
# et pouvait croire la restauration faite. Sur une operation destructive,
# c'est le pire des silences.
#
# Refuser est le bon defaut : une base ne se remplace pas sans que quelqu'un
# l'ait decide. Qui veut automatiser l'annonce explicitement.
if [[ -t 0 ]]; then
    read -rp "Tapez exactement le nom de la base pour confirmer (${DB_NAME}) : " confirm || confirm=""
elif [[ "${RESTAURATION_CONFIRMEE:-}" == "$DB_NAME" ]]; then
    confirm="$DB_NAME"
    warn "Sans terminal : confirmé par RESTAURATION_CONFIRMEE=${DB_NAME}."
else
    echo "Refusé : pas de terminal pour confirmer le remplacement de '${DB_NAME}'." >&2
    echo "Pour le faire depuis un script : RESTAURATION_CONFIRMEE=${DB_NAME} bash scripts/restore-postgres.sh ${DUMP_FILE}" >&2
    exit 1
fi
[[ "$confirm" == "$DB_NAME" ]] || { echo "Annulé."; exit 1; }

# --- Arrêt des services applicatifs ----------------------------------------
step "1/5  Arrêt de l'API et du dashboard"
pm2 stop all >/dev/null 2>&1 && info "Services PM2 arrêtés" \
    || warn "PM2 : aucun service à arrêter (normal avant la phase 3)"

# --- Mise à l'écart de la base courante ------------------------------------
step "2/5  Mise de côté de la base actuelle"
OLD_DB="${DB_NAME}_avant_restauration_$(date +%Y%m%d_%H%M)"
PSQL=(docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER"
      psql -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d postgres)

"${PSQL[@]}" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                 WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null
"${PSQL[@]}" -c "ALTER DATABASE \"${DB_NAME}\" RENAME TO \"${OLD_DB}\";"
info "Base actuelle renommée en ${OLD_DB}"

# --- Création de la nouvelle base ------------------------------------------
step "3/5  Création d'une base vierge"
"${PSQL[@]}" -c "CREATE DATABASE \"${DB_NAME}\" OWNER \"${DB_SUPERUSER}\";"
docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -c "CREATE EXTENSION IF NOT EXISTS postgis;
        CREATE EXTENSION IF NOT EXISTS postgis_topology;
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
        CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";
        CREATE EXTENSION IF NOT EXISTS unaccent;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null
info "Base ${DB_NAME} recréée avec ses extensions"

# --- Restauration -----------------------------------------------------------
step "4/5  Restauration des données"
# La restauration parallele (--jobs) exige un fichier accessible en acces
# direct, pas l'entree standard. On le DEPOSE donc dans le conteneur avec
# « docker cp », qui ne suppose aucun volume.
#
# La premiere version passait par un volume partage ./infra/postgres/dumps
# -> /dumps, en le SUPPOSANT monte. Il ne l'est pas partout : pg_restore ne
# trouvait aucun fichier, echouait, et le script annoncait quand meme
# « RESTAURATION TERMINEE » sur une base VIDE.
MSYS_NO_PATHCONV=1 docker cp "$DUMP_FILE" "${CONTAINER}:/tmp/_restore.dump" >/dev/null \
    || fail "Impossible de deposer la sauvegarde dans le conteneur ${CONTAINER}."
trap 'MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" rm -f /tmp/_restore.dump >/dev/null 2>&1 || true' EXIT

docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    pg_restore -U "$DB_SUPERUSER" -d "$DB_NAME" \
        --no-owner --no-privileges --jobs=4 /tmp/_restore.dump \
    && RESTAURE_OK=1 \
    || { RESTAURE_OK=0; warn "pg_restore a signale des erreurs — voir ci-dessus."; }

# Les droits du rôle applicatif ne sont pas dans le dump (--no-privileges)
# « docker exec » SANS -i ne transmet PAS l'entree standard au conteneur.
# Le heredoc partait donc dans le vide : psql ne recevait rien, ne faisait
# rien, et sortait en 0. Le script annoncait « Droits reappliques » alors
# qu'AUCUN droit n'avait ete donne. Apres restauration, gtfc_app n'avait
# meme plus USAGE sur le schema app, et toute connexion echouait sur
#     permission denied for schema app
# La commune restaurait sa sauvegarde apres un incident, lisait
# « RESTAURATION TERMINEE », et la plateforme restait morte.
docker exec -i -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$DB_SUPERUSER" -d "$DB_NAME" <<SQL >/dev/null
    GRANT USAGE ON SCHEMA app, ref, audit, public TO ${DB_USER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA app, ref TO ${DB_USER};
    GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA app, ref TO ${DB_USER};
    GRANT SELECT, INSERT                 ON ALL TABLES    IN SCHEMA audit  TO ${DB_USER};
    GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA audit  TO ${DB_USER};
SQL
# ON VERIFIE, ON N'ANNONCE PAS. Cette ligne se contentait de dire que les
# droits etaient reappliques, sans jamais le constater — c'est ainsi qu'un
# heredoc parti dans le vide a pu passer pour un succes. Un message n'est pas
# un controle.
DROITS_OK=$(docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" psql -tAX -U "$DB_SUPERUSER" -d "$DB_NAME" -c "SELECT has_schema_privilege('${DB_USER}','app','USAGE') AND has_table_privilege('${DB_USER}','app.utilisateur','SELECT');" | tr -d "[:space:]")
if [[ "$DROITS_OK" != "t" ]]; then
    fail "Les droits de ${DB_USER} n'ont PAS ete appliques : la base est restauree mais l'application ne pourra pas la lire."
fi
info "Droits du rôle ${DB_USER} réappliqués et vérifiés"

# --- Contrôle ---------------------------------------------------------------
step "5/5  Contrôle"
docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -c "SELECT table_schema, count(*) AS tables
        FROM information_schema.tables
        WHERE table_schema IN ('app','ref','audit')
        GROUP BY table_schema ORDER BY table_schema;"

echo
# ---------------------------------------------------------------------------
#  Le controle DECIDE, il ne se contente pas d'afficher.
#
#  La premiere version imprimait le tableau ci-dessus puis annoncait
#  « RESTAURATION TERMINEE » quoi qu'il arrive. Mesure : pg_restore en echec,
#  « 0 rows » affiche, base VIDE — et succes annonce en vert. Pour un
#  dispositif de sauvegarde, c'est la pire issue : on croit avoir restaure.
# ---------------------------------------------------------------------------
NB_TABLES=$(docker exec -e PGPASSWORD="$DB_SUPERUSER_PASSWORD" "$CONTAINER" \
    psql -tAX -U "$DB_SUPERUSER" -d "$DB_NAME" \
    -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'app';" | tr -d "")

if [[ "${NB_TABLES:-0}" -lt 1 ]]; then
    fail "La base restauree ne contient AUCUNE table dans app. La sauvegarde
n'a pas ete restauree. L'ancienne base est intacte sous ${OLD_DB}."
fi
if [[ "${RESTAURE_OK:-0}" -ne 1 ]]; then
    warn "pg_restore a signale des erreurs, mais ${NB_TABLES} tables sont presentes."
    warn "Verifiez le contenu avant de supprimer ${OLD_DB}."
fi

info "RESTAURATION TERMINÉE — ${NB_TABLES} tables dans app"
echo
echo "  Ancienne base conservée sous : ${BOLD}${OLD_DB}${NC}"
echo "  Une fois la restauration validée, supprimez-la :"
echo "      docker exec -it ${CONTAINER} psql -U ${DB_SUPERUSER} -c 'DROP DATABASE \"${OLD_DB}\";'"
echo
echo "  Redémarrez ensuite les services :"
echo "      pm2 restart all"
echo
