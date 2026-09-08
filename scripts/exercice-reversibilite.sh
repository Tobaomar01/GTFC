#!/usr/bin/env bash
# ============================================================================
#  Exercice de réversibilité — prouver que la commune peut vraiment partir
#  Plateforme GTFC
#
#  La constitution, principe VI : « La sortie de la commune du dispositif est
#  un droit exerçable, pas une clause. » Un droit qu'on n'a jamais exercé n'est
#  pas un droit : c'est une intention.
#
#  Cet exercice :
#      1. produit l'export de réversibilité ;
#      2. reconstruit une base TÉMOIN à partir de lui seul ;
#      3. compare le témoin à la base d'origine, table par table ;
#      4. efface le témoin.
#
#  Il ne touche jamais à la base d'origine.
#
#  CE QU'IL A TROUVÉ LA PREMIÈRE FOIS. L'export se produisait sans une erreur
#  et ne se rechargeait pas : « SELECT * » emportait les colonnes GÉNÉRÉES, que
#  « COPY … FROM » refuse. Dix tables sur quarante-huit restaient vides —
#  commerce, redevable, rue, utilisateur, avis_imposition — sans que rien ne le
#  signale. Produire un export ne prouve rien ; le recharger, si.
#
#  Usage :
#      bash scripts/exercice-reversibilite.sh
#      bash scripts/exercice-reversibilite.sh --garder
# ============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."

# Sous Git Bash, MSYS reecrit tout argument qui ressemble a un chemin Unix.
# « /tmp/x » devient « C:/Users/.../Temp/x » — or ici /tmp designe l interieur
# du CONTENEUR, pas l hote. Sans cette ligne psql cherche au mauvais endroit
# et repond « No such file or directory ». Ignoree sur Linux et macOS.
export MSYS_NO_PATHCONV=1

GARDER=0
[[ "${1:-}" == "--garder" ]] && GARDER=1

[[ -f .env ]] || { echo "[ERREUR] .env introuvable" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"
BASE="${DB_NAME:-gtfc_recette}"
TEMOIN="${BASE}_reversibilite"
# Le dossier de travail vit dans le depot, pas dans /tmp : sous Windows,
# Docker interprete « /tmp » comme « C:	mp », qui n'existe pas. Le chemin
# de travail reste donc sous le depot, la ou Docker sait le monter.
TRAVAIL="$(pwd)/.exercice-reversibilite-$"

# Docker sous Windows ne connait pas les chemins MSYS (/c/Users/...).
# « pwd -W » rend la forme attendue ; ailleurs « pwd » suffit.
# UN SEUL « cd », dans un SOUS-SHELL. La forme precedente en faisait deux : la
# premiere branche changeait de dossier PUIS echouait sur « pwd -W », et le
# repli refaisait le meme cd depuis le dossier ou il venait d'arriver — donc
# une erreur des que l'argument est relatif. Et « { } » n'etant pas un
# sous-shell, ce cd fuyait dans le shell appelant : la suite du script
# aurait travaille ailleurs sans que rien ne le dise.
chemin_hote() { ( cd "$1" && { pwd -W 2>/dev/null || pwd; } ); }

docker inspect -f '{{.State.Running}}' "$CONTENEUR" 2>/dev/null | grep -q true \
    || { echo "Le conteneur ${CONTENEUR} n'est pas démarré." >&2; exit 1; }

psql_q() { docker exec -i "$CONTENEUR" psql -U postgres -d "$1" -tAX -c "$2"; }

nettoyer() {
    if [[ $GARDER -eq 1 ]]; then
        echo "==> Conservés : base ${TEMOIN}, export ${TRAVAIL}"
        return
    fi
    docker exec "$CONTENEUR" psql -U postgres -q -c "DROP DATABASE IF EXISTS ${TEMOIN};" >/dev/null 2>&1 || true
    docker exec "$CONTENEUR" rm -rf /tmp/reversibilite-exercice >/dev/null 2>&1 || true
    rm -rf "$TRAVAIL"
    echo "==> Témoin effacé"
}
trap nettoyer EXIT

ECHECS=0

echo "==> 1. Export"
bash scripts/exporter-reversibilite.sh --vers "$TRAVAIL" >/dev/null || {
    echo "    ÉCHEC : l'export lui-même a échoué"; exit 1; }
NB_CSV=$(find "$TRAVAIL/donnees" -name '*.csv' | wc -l | tr -d ' ')
echo "    ${NB_CSV} fichiers CSV, $(wc -l < "$TRAVAIL/schema.sql") lignes de DDL"

echo "==> 2. Reconstruction dans « ${TEMOIN} »"
MSYS_NO_PATHCONV=1 docker exec "$CONTENEUR" rm -rf /tmp/reversibilite-exercice
MSYS_NO_PATHCONV=1 docker cp "$(chemin_hote "$TRAVAIL")" "${CONTENEUR}:/tmp/reversibilite-exercice" >/dev/null
docker exec "$CONTENEUR" psql -U postgres -q -c "DROP DATABASE IF EXISTS ${TEMOIN};" >/dev/null
docker exec "$CONTENEUR" psql -U postgres -q -c "CREATE DATABASE ${TEMOIN};" >/dev/null

# On lit le CODE DE SORTIE, pas un motif dans la sortie. psql prefixe ses
# erreurs par « psql:fichier:ligne: » quand il lit un fichier : un
# « grep '^ERROR' » ne les voit pas et annonce zero erreur sur un chargement
# qui n'a jamais eu lieu. C'est exactement ce qu'il a fait ici avant correction.
if docker exec "$CONTENEUR" psql -U postgres -q -v ON_ERROR_STOP=1 -d "$TEMOIN" \
        -f /tmp/reversibilite-exercice/schema.sql > "$TRAVAIL/ddl.log" 2>&1; then
    echo "    schéma rechargé"
else
    echo "    ÉCHEC du rechargement du schéma :"
    tail -3 "$TRAVAIL/ddl.log" | sed 's/^/        /'
    ECHECS=$((ECHECS + 1))
fi

# Les clés étrangères sont différées le temps du chargement : l'ordre
# alphabétique des fichiers n'est pas l'ordre des dépendances.
{
  echo "SET session_replication_role = replica;"
  for f in "$TRAVAIL"/donnees/*.csv; do
      t=$(basename "$f" .csv)
      echo "COPY ${t} FROM '/tmp/reversibilite-exercice/donnees/$(basename "$f")' WITH (FORMAT csv, HEADER true);"
  done
  echo "SET session_replication_role = origin;"
} > "$TRAVAIL/charger.sql"
MSYS_NO_PATHCONV=1 docker cp "$(chemin_hote "$TRAVAIL")/charger.sql" "${CONTENEUR}:/tmp/charger.sql" >/dev/null

if docker exec "$CONTENEUR" psql -U postgres -q -v ON_ERROR_STOP=1 -d "$TEMOIN" \
        -f /tmp/charger.sql > "$TRAVAIL/copy.log" 2>&1; then
    echo "    données rechargées"
else
    echo "    ÉCHEC du rechargement des données :"
    tail -3 "$TRAVAIL/copy.log" | sed 's/^/        /'
    ECHECS=$((ECHECS + 1))
fi

echo "==> 3. Comparaison témoin / origine"
# ---------------------------------------------------------------------------
#  On compare au CONTENU D'ORIGINE, pas aux fichiers exportés. Comparer un
#  export à lui-même passerait toujours : c'est le contrôle vrai par vacuité
#  que ce projet a déjà rencontré ailleurs.
# ---------------------------------------------------------------------------
for f in "$TRAVAIL"/donnees/*.csv; do
    T=$(basename "$f" .csv)
    N_TEMOIN=$(psql_q "$TEMOIN" "SELECT count(*) FROM ${T}" | tr -d '\r')
    N_CSV=$(( $(wc -l < "$f") - 1 )); [[ $N_CSV -lt 0 ]] && N_CSV=0
    if [[ "$N_TEMOIN" != "$N_CSV" ]]; then
        echo "    ÉCART ${T} : témoin=${N_TEMOIN}, export=${N_CSV}"
        ECHECS=$((ECHECS + 1))
    fi
done
TOTAL=$(psql_q "$TEMOIN" "SELECT sum(n) FROM (SELECT count(*) n FROM app.commerce UNION ALL SELECT count(*) FROM app.redevable UNION ALL SELECT count(*) FROM audit.journal) s" | tr -d '\r')
echo "    commerces + redevables + journal d'audit : ${TOTAL} lignes rechargées"

echo
if [[ $ECHECS -gt 0 ]]; then
    echo "EXERCICE ÉCHOUÉ — ${ECHECS} anomalie(s). La commune ne pourrait pas repartir avec ses données."
    exit 1
fi
echo "EXERCICE RÉUSSI — l'export se recharge intégralement dans une base neuve."
