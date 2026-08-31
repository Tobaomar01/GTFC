#!/usr/bin/env bash
# ============================================================================
#  Épreuve d'installation NEUVE
#
#  Rejoue, sur une base jetable, ce qui se passera le jour du déploiement :
#  base vide, extensions, rôles, puis TOUTES les migrations et TOUS les seeds
#  dans l'ordre, puis le jeu de tests complet.
#
#  Pourquoi c'est indispensable. On applique les migrations une par une au fil
#  du développement, et la base de travail finit par porter des états qu'une
#  base neuve n'aura jamais. Un seed peut ainsi entrer en collision avec un
#  déclencheur ajouté APRÈS lui, sans que rien ne le signale : sur la base de
#  travail, le seed avait été joué avant que le déclencheur n'existe.
#
#  C'est exactement le défaut que cette épreuve a trouvé la première fois
#  qu'elle a été jouée. Le pilote se serait installé sur un seed en échec.
#
#  Usage :
#      bash scripts/verifier-installation-neuve.sh [nom_base]
#
#  La base est SUPPRIMÉE puis recréée. Ne visez jamais une base de production :
#  le script refuse les noms qui y ressemblent.
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-gtfc_epreuve}"

case "$BASE" in
    *prod*|*production*|gtfc_taxes)
        echo "Refus : « $BASE » ressemble à une base de production." >&2
        exit 1 ;;
esac

command -v psql >/dev/null || { echo "psql introuvable." >&2; exit 1; }

export POSTGRES_USER="${PGUSER:-$(whoami)}" POSTGRES_DB="$BASE"
export APP_DB_USER="${APP_DB_USER:-gtfc_app}"
export APP_DB_PASSWORD="${APP_DB_PASSWORD:-motdepasse_local}"
export APP_DB_NAME="$BASE"

echo "==> Base jetable : $BASE"
dropdb --if-exists "$BASE" 2>/dev/null
createdb "$BASE" || { echo "Création impossible." >&2; exit 1; }

echo "==> Extensions"
bash infra/postgres/init/01-extensions.sh >/dev/null 2>&1 \
    || { echo "ÉCHEC : extensions (PostGIS est-il installé ?)" >&2; exit 1; }

echo "==> Rôles et schémas"
bash infra/postgres/init/02-app-role.sh >/dev/null 2>&1 \
    || { echo "ÉCHEC : rôles" >&2; exit 1; }

echoues=0
appliquer() {
    for f in $(find "$1" -maxdepth 1 -name '*.sql' -type f | sort); do
        if ! sortie=$(psql -q -v ON_ERROR_STOP=1 --single-transaction \
                           -d "$BASE" -f "$f" 2>&1); then
            echoues=$((echoues + 1))
            echo "  ÉCHEC  $(basename "$f")"
            echo "$sortie" | grep -E '^(psql:|ERROR|DETAIL|HINT)' | head -4 | sed 's/^/         /'
        fi
    done
}

echo "==> Migrations"
appliquer db/migrations
echo "==> Seeds"
appliquer db/seeds

if [ "$echoues" -gt 0 ]; then
    echo
    echo "$echoues fichier(s) en échec : une installation neuve ne passerait pas."
    exit 1
fi

echo "==> Contenu"
#
# Une table vide qui devrait être pleine ne se signale pas toute seule : le
# seed se termine sans erreur et l'installation paraît réussie. C'est ce qui
# est arrivé aux chantiers, restés à zéro pendant des semaines parce que leur
# seed tournait avant celui des rues.
#
# Cette liste est l'inventaire de ce qu'une installation utilisable doit
# contenir. À compléter quand une nouvelle famille d'objets apparaît.
#
ATTENDUES="
app.commune
app.zone
app.quartier
app.rue
app.utilisateur
app.commerce
app.redevable
app.dispositif_affichage
app.chantier
app.commerce_taxe
ref.categorie_commerce
ref.categorie_taxe
ref.type_taxe
ref.type_affichage
ref.motif_contestation
ref.motif_exoneration
"

vides=0
for table in $ATTENDUES; do
    n=$(psql -q "$BASE" -At -c "SELECT count(*) FROM $table" 2>/dev/null || echo "erreur")
    if [ "$n" = "erreur" ]; then
        echo "   $table : TABLE ABSENTE"
        vides=$((vides + 1))
    elif [ "$n" = "0" ]; then
        echo "   $table : VIDE"
        vides=$((vides + 1))
    else
        printf '   %-28s %s\n' "$table" "$n"
    fi
done

if [ "$vides" -gt 0 ]; then
    echo
    echo "$vides table(s) vide(s) ou absente(s) : l'installation n'est pas utilisable."
    echo "Un seed qui ne trouve rien à faire se termine sans erreur — c'est"
    echo "précisément ce que ce contrôle rattrape."
    echo "La base $BASE est conservée pour examen."
    exit 1
fi

echo "==> Jeu de tests sur cette base neuve"
# Les tests lisent avec un compte privilégié pour voir au-delà des politiques
# d'isolation ; l'API se connecte comme en production, avec gtfc_app.
#
# Le code de sortie est celui de `node`, pas celui de `grep` : sans
# PIPESTATUS, un test en échec passait inaperçu et le script annonçait quand
# même la réussite. Un vérificateur qui se trompe est pire que pas de
# vérificateur.
#
# Le rapporteur est IMPOSÉ. `node --test` choisit « spec » sur un terminal et
# TAP partout ailleurs — or la sortie part toujours dans un tuyau, donc c'était
# toujours TAP, et le filtre ci-dessous, écrit pour « spec », ne retenait
# jamais rien. Le script annonçait l'échec sans une ligne de diagnostic, ce qui
# laisse le lecteur devant un verdict qu'il ne peut pas instruire.
( cd apps/api && LOG_LEVEL=silent \
    DATABASE_URL_TEST="postgres://localhost/$BASE" \
    DB_NAME="$BASE" DB_USER="$APP_DB_USER" DB_PASSWORD="$APP_DB_PASSWORD" \
    node --test --test-reporter=spec $(find tests -name '*.test.js') 2>&1 ) \
  | grep -E '^ℹ (tests|pass|fail)|^✖ [a-zé]'
statut_tests=${PIPESTATUS[0]}

echo
if [ "$statut_tests" -ne 0 ]; then
    echo "Des tests échouent sur une base neuve : le déploiement n'est pas prêt."
    echo "La base $BASE est conservée pour examen."
    exit 1
fi

echo "Installation neuve vérifiée. La base $BASE peut être supprimée :"
echo "    dropdb $BASE"
