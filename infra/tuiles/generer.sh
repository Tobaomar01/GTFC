#!/usr/bin/env bash
# ============================================================================
#  Production des tuiles cartographiques servies par la commune
#
#  À exécuter SUR LE SERVEUR, une fois, puis à chaque rafraîchissement de la
#  source. Le résultat est un arbre de fichiers PNG que Nginx sert directement.
#
#  Pourquoi la commune héberge ses tuiles : voir LISEZ-MOI.md, à côté. En
#  résumé — la politique d'usage d'OpenStreetMap proscrit l'usage systématique
#  de ses serveurs, chaque affichage révélerait à un tiers où et quand la
#  commune inspecte, et sans lien international la carte serait blanche.
#
#  Ce script ne télécharge rien tant qu'il n'a pas vérifié que les outils sont
#  là : un échec à mi-parcours laisserait un extrait de 800 Mo et pas de
#  tuiles.
#
#  Usage :
#      bash infra/tuiles/generer.sh [dossier_de_sortie]
#
#  Défaut : /var/www/tuiles
# ============================================================================
set -Eeuo pipefail

SORTIE="${1:-/var/www/tuiles}"
TRAVAIL="${TUILES_TRAVAIL:-/tmp/tuiles-gtfc}"

# Emprise de la commune, avec une marge : une carte qui s'arrête net à la
# limite communale se lit mal, l'œil a besoin de la rue d'en face.
OUEST="${TUILES_OUEST:--17.4900}"
SUD="${TUILES_SUD:-14.6600}"
EST="${TUILES_EST:--17.4100}"
NORD="${TUILES_NORD:-14.7200}"

ZOOM_MIN="${TUILES_ZOOM_MIN:-14}"
ZOOM_MAX="${TUILES_ZOOM_MAX:-19}"

SOURCE="${TUILES_SOURCE:-https://download.geofabrik.de/africa/senegal-latest.osm.pbf}"

info() { echo "  $*"; }
etape() { echo; echo "==> $*"; }
abandon() { echo; echo "ERREUR : $*" >&2; exit 1; }

# --- Vérifications préalables ----------------------------------------------
etape "Vérification des outils"
manquants=()
for outil in curl osmium tilemaker mb-util; do
    command -v "$outil" >/dev/null || manquants+=("$outil")
done

if [ ${#manquants[@]} -gt 0 ]; then
    echo
    echo "Outils manquants : ${manquants[*]}"
    echo
    echo "Sur Ubuntu :"
    echo "    sudo apt-get install -y curl osmium-tool"
    echo "    sudo apt-get install -y tilemaker      # ou compilation depuis les sources"
    echo "    pip3 install mbutil"
    echo
    abandon "installez-les puis relancez."
fi
info "curl, osmium, tilemaker, mb-util : présents"

if [ -e "$SORTIE" ] && [ -n "$(ls -A "$SORTIE" 2>/dev/null)" ]; then
    echo
    echo "Le dossier $SORTIE contient déjà des tuiles."
    echo "Les remplacer coupera brièvement le fond de plan pour les utilisateurs."
    read -rp "Continuer ? (oui/non) " reponse
    [ "$reponse" = "oui" ] || { echo "Annulé."; exit 0; }
fi

mkdir -p "$TRAVAIL"

# --- 1. Extrait régional ----------------------------------------------------
etape "Extrait OpenStreetMap du Sénégal"
PBF="$TRAVAIL/senegal.osm.pbf"
if [ -f "$PBF" ]; then
    info "déjà téléchargé : $PBF"
    info "supprimez-le pour repartir d'une source fraîche"
else
    info "depuis $SOURCE"
    curl -fL --progress-bar -o "$PBF.partiel" "$SOURCE" \
        || abandon "téléchargement impossible. Vérifiez le lien réseau."
    # Renommé seulement une fois complet : un fichier tronqué qu'on croit
    # complet fait échouer l'étape suivante avec un message incompréhensible.
    mv "$PBF.partiel" "$PBF"
fi

# --- 2. Découpe sur la commune ---------------------------------------------
etape "Découpe sur l'emprise de la commune"
info "$OUEST,$SUD → $EST,$NORD"
COMMUNE="$TRAVAIL/commune.osm.pbf"
osmium extract --overwrite -b "$OUEST,$SUD,$EST,$NORD" "$PBF" -o "$COMMUNE" \
    || abandon "découpe impossible."
info "$(du -h "$COMMUNE" | cut -f1) après découpe"

# --- 3. Rendu ---------------------------------------------------------------
etape "Rendu des tuiles (zoom $ZOOM_MIN à $ZOOM_MAX)"
MBTILES="$TRAVAIL/tuiles.mbtiles"
rm -f "$MBTILES"
tilemaker --input "$COMMUNE" --output "$MBTILES" \
    || abandon "rendu impossible. Vérifiez la configuration de tilemaker."

# --- 4. Découpe en fichiers -------------------------------------------------
etape "Découpe en fichiers servis par Nginx"
rm -rf "$SORTIE.nouveau"
mb-util --image_format=png "$MBTILES" "$SORTIE.nouveau" \
    || abandon "découpe impossible."

# Bascule en une fois : les utilisateurs ne voient jamais un arbre à moitié
# écrit. L'ancien est conservé le temps de vérifier, puis effacé à la main.
if [ -e "$SORTIE" ]; then
    rm -rf "$SORTIE.precedent"
    mv "$SORTIE" "$SORTIE.precedent"
fi
mkdir -p "$(dirname "$SORTIE")"
mv "$SORTIE.nouveau" "$SORTIE"

NB=$(find "$SORTIE" -name '*.png' | wc -l | tr -d ' ')
TAILLE=$(du -sh "$SORTIE" | cut -f1)

echo
echo "==> Terminé"
info "$NB tuiles · $TAILLE · $SORTIE"
[ -e "$SORTIE.precedent" ] && info "ancien jeu conservé : $SORTIE.precedent (à effacer après vérification)"
echo
echo "Nginx doit servir ce dossier sous /tuiles/ — voir LISEZ-MOI.md."
echo "Une tuile absente se sert en 204, jamais en 404 : en bordure d'emprise"
echo "c'est normal, et un 404 remplirait le journal d'erreurs pour rien."
