#!/usr/bin/env bash
# ============================================================================
#  Exercice de restauration
#
#  La constitution l'exige avant toute mise en production : « une sauvegarde
#  jamais restaurée n'est pas une sauvegarde ». Ce script en fait la preuve,
#  et la refait à volonté.
#
#  Il sauvegarde, restaure DANS UNE AUTRE BASE, compare table par table, et
#  vérifie que la chaîne du journal d'audit a survécu au voyage — c'est elle
#  qui donne au journal sa valeur probante, et elle ne se recalcule pas.
#
#  Il ne touche jamais à la base d'origine.
#
#  Usage :
#      bash scripts/exercice-restauration.sh [base] [dossier_de_sauvegarde]
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-gtfc_recette}"
DEST="${2:-$HOME/revenu-municipal/sauvegardes}"
TEMOIN="${BASE}_restauration"

# Les outils clients doivent être de la MÊME version majeure que le serveur.
# Sinon pg_dump s'arrête sur « server version mismatch » — et sans le
# garde-fou du script de sauvegarde, il laisse un fichier de zéro octet qui
# ressemble à une sauvegarde.
VERSION_SERVEUR=$(psql -q "$BASE" -At -c "SHOW server_version" | cut -d. -f1)
PG_BIN=""
for chemin in "/opt/homebrew/opt/postgresql@${VERSION_SERVEUR}/bin" \
              "/usr/local/opt/postgresql@${VERSION_SERVEUR}/bin" \
              "/usr/lib/postgresql/${VERSION_SERVEUR}/bin" ""; do
    if [ -x "${chemin}/pg_dump" ] || { [ -z "$chemin" ] \
        && pg_dump --version | grep -q " ${VERSION_SERVEUR}\."; }; then
        PG_BIN="$chemin"; break
    fi
done
if [ -z "$PG_BIN" ] && ! pg_dump --version | grep -q " ${VERSION_SERVEUR}\."; then
    echo "pg_dump de la version ${VERSION_SERVEUR} introuvable." >&2
    echo "Serveur ${VERSION_SERVEUR}, client $(pg_dump --version | awk '{print $3}')." >&2
    exit 1
fi
DUMP="${PG_BIN:+$PG_BIN/}pg_dump"
RESTORE="${PG_BIN:+$PG_BIN/}pg_restore"

mkdir -p "$DEST"
FICHIER="$DEST/${BASE}-$(date +%Y%m%d-%H%M%S).dump"

echo "==> Sauvegarde"
if ! "$DUMP" --format=custom --compress=9 -d "$BASE" -f "$FICHIER"; then
    rm -f "$FICHIER"
    echo "Sauvegarde impossible — fichier partiel effacé." >&2
    exit 1
fi
echo "    $(ls -lh "$FICHIER" | awk '{print $5}')  $FICHIER"
echo "    sha256 $(shasum -a 256 "$FICHIER" | cut -c1-32)…"

echo "==> Restauration dans « $TEMOIN »"
dropdb --if-exists "$TEMOIN"
createdb "$TEMOIN"
psql -q "$TEMOIN" -c "
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";
    CREATE EXTENSION IF NOT EXISTS unaccent;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS btree_gist;" >/dev/null
"$RESTORE" -d "$TEMOIN" --no-owner --no-privileges "$FICHIER" 2>/tmp/restauration.log
# `grep -c` affiche « 0 » PUIS sort en échec quand il ne trouve rien : un
# `|| echo 0` ajouterait un second zéro, et la comparaison plus bas échouerait
# sur « 0\n0 » — en laissant l'exercice se déclarer réussi. C'est précisément
# le genre de contrôle qui rassure sans vérifier.
erreurs=$(grep -c 'error:' /tmp/restauration.log 2>/dev/null || true)
erreurs=${erreurs:-0}
echo "    erreurs de restauration : $erreurs"

echo "==> Comparaison"
ecarts=0
for t in app.commune app.zone app.quartier app.rue app.commerce app.redevable \
         app.commerce_taxe app.avis_imposition app.avis_ligne app.paiement \
         app.quittance app.utilisateur audit.journal; do
    a=$(psql -q "$BASE"   -At -c "SELECT count(*) FROM $t" 2>/dev/null || echo '?')
    b=$(psql -q "$TEMOIN" -At -c "SELECT count(*) FROM $t" 2>/dev/null || echo '?')
    if [ "$a" = "$b" ]; then
        printf '    %-24s %7s\n' "$t" "$a"
    else
        printf '    %-24s %7s → %-7s ÉCART\n' "$t" "$a" "$b"
        ecarts=$((ecarts + 1))
    fi
done

echo "==> Chaîne d'audit après restauration"
# Une sauvegarde qui rendrait le journal invérifiable ne restituerait pas sa
# valeur probante : les écritures seraient là, la preuve de leur intégrité non.
chaine=$(psql -q "$TEMOIN" -At -c \
    "SELECT coalesce((SELECT rupture_motif FROM audit.verifier_chaine() LIMIT 1), 'intacte')")
echo "    $chaine"

echo
if [ "$ecarts" -gt 0 ] || [ "$erreurs" -gt 0 ] || [ "$chaine" != "intacte" ]; then
    echo "Exercice ÉCHOUÉ. La base témoin « $TEMOIN » est conservée pour examen."
    exit 1
fi
dropdb --if-exists "$TEMOIN"
echo "Exercice réussi : la sauvegarde du $(date +%d/%m/%Y) est restaurable."
echo "Fichier : $FICHIER"
