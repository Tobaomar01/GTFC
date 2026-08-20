#!/usr/bin/env bash

# Nom du conteneur PostgreSQL. Variable plutôt que figé : la démonstration
# locale utilise gtfc-demo-db, et un serveur peut en héberger plusieurs.
PG_CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"
# ============================================================================
#  Recette fonctionnelle — la plateforme fait-elle vraiment son travail ?
#
#  Usage :
#      bash scripts/recette.sh                recette complète
#      bash scripts/recette.sh --sans-ecrire  lectures seules
#
#  Différence avec healthcheck.sh : celui-ci vérifie que les SERVICES sont
#  debout. Celui-là vérifie que le MÉTIER fonctionne — se connecter, créer un
#  commerce, calculer une taxe, synchroniser, encaisser, produire une
#  quittance, exporter.
#
#  Les données créées sont préfixées RECETTE- et supprimées à la fin. En cas
#  d'interruption, relancer le script nettoie les restes.
# ============================================================================
# PAS de -e ici, volontairement.
#
# Une recette CONSTATE, elle n'agit pas : elle doit aller au bout et rapporter
# tous les écarts, pas s'arrêter au premier. Avec -e, l'idiome
#     [[ condition ]] ; verifier "nom" "$?"
# interrompt le script dès qu'un contrôle échoue — donc avant que l'échec ne
# soit enregistré, et avant l'affichage du bilan. La recette ne saurait alors
# annoncer que « tout va bien », ce qui est le contraire de son objet.
#
# -u et pipefail sont conservés : une variable oubliée reste une erreur.
set -Euo pipefail

cd "$(dirname "$0")/.."
RACINE="$(pwd)"

GRAS=$'\033[1m'; VERT=$'\033[0;32m'; JAUNE=$'\033[0;33m'
ROUGE=$'\033[0;31m'; GRIS=$'\033[0;90m'; NC=$'\033[0m'

SUCCES=0; ECHECS=0; ALERTES=0
declare -a RESULTATS

verifier() {
  local nom="$1" condition="$2" detail="${3:-}"
  if [[ "$condition" == "0" ]]; then
    SUCCES=$((SUCCES + 1)); RESULTATS+=("  ${VERT}✓${NC} $nom")
  else
    ECHECS=$((ECHECS + 1)); RESULTATS+=("  ${ROUGE}✗${NC} $nom ${GRIS}$detail${NC}")
  fi
}
alerter() { ALERTES=$((ALERTES + 1)); RESULTATS+=("  ${JAUNE}!${NC} $1 ${GRIS}${2:-}${NC}"); }
section() { echo; echo "${GRAS}$1${NC}"; }

SANS_ECRIRE=0
[[ "${1:-}" == "--sans-ecrire" ]] && SANS_ECRIRE=1

# Fichier de configuration : .env sur un serveur, .env.demo en local.
# Surchargeable pour éprouver la recette AVANT de déployer plutôt qu'après.
ENV_FICHIER="${ENV_FICHIER:-.env}"
if [[ ! -f "$ENV_FICHIER" ]]; then
  if [[ -f .env.demo ]]; then
    ENV_FICHIER=".env.demo"
    echo "${GRIS}(.env absent — recette lancée sur la démonstration locale)${NC}"
  else
    echo "${ROUGE}$ENV_FICHIER introuvable${NC}"
    echo "${GRIS}  Sur un serveur : bash scripts/deployer.sh crée le .env.${NC}"
    echo "${GRIS}  En local       : bash scripts/demo-locale.sh demarrer.${NC}"
    exit 1
  fi
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FICHIER"; set +a

# 0.0.0.0 (ou ::) signifie « écouter partout ». On ne s'y CONNECTE pas :
# curl y reste bloqué sans message. On retombe donc sur la boucle locale.
hote_joignable() {
  case "${1:-}" in
    ''|0.0.0.0|::|'*') echo "127.0.0.1" ;;
    *) echo "$1" ;;
  esac
}

API="http://$(hote_joignable "${API_HOST:-127.0.0.1}"):${API_PORT:-4000}"
DASH="http://$(hote_joignable "${DASHBOARD_HOST:-127.0.0.1}"):${DASHBOARD_PORT:-3000}"

echo
echo "${GRAS}Recette fonctionnelle — plateforme de collecte des taxes locales${NC}"
echo "${GRIS}$(date '+%d/%m/%Y %H:%M') · $API${NC}"
[[ "$SANS_ECRIRE" == "1" ]] && echo "${GRIS}Mode lecture seule${NC}"

psql_admin() {
  docker exec -e PGPASSWORD="${DB_SUPERUSER_PASSWORD}" "$PG_CONTENEUR" \
    psql -tAX -v ON_ERROR_STOP=1 -U "${DB_SUPERUSER}" -d "${DB_NAME}" "$@"
}

# ---------------------------------------------------------------------------
# Nettoyage préventif : un passage interrompu a pu laisser des traces
# ---------------------------------------------------------------------------
nettoyer() {
  psql_admin -c "
    DELETE FROM app.paiement WHERE commentaire = 'RECETTE';
    DELETE FROM app.visite WHERE commentaire = 'RECETTE';
    DELETE FROM app.commerce_taxe WHERE commerce_id IN
      (SELECT id FROM app.commerce WHERE notes = 'RECETTE');
    DELETE FROM app.qr_code WHERE commerce_id IN
      (SELECT id FROM app.commerce WHERE notes = 'RECETTE');
    DELETE FROM app.commerce WHERE notes = 'RECETTE';
    DELETE FROM app.utilisateur WHERE matricule = 'RECETTE-AG';
  " >/dev/null 2>&1 || true
}
[[ "$SANS_ECRIRE" == "0" ]] && nettoyer
trap '[[ "$SANS_ECRIRE" == "0" ]] && nettoyer' EXIT

# ===========================================================================
section "1. Services"
# ===========================================================================
curl -fsS --max-time 8 "$API/healthz" >/dev/null 2>&1
verifier "L'API répond" "$?"

pret=$(curl -fsS --max-time 15 "$API/pret" 2>/dev/null || echo '{}')
echo "$pret" | grep -q '"statut":"pret"'
verifier "Base et stockage opérationnels" "$?" "$(echo "$pret" | head -c 120)"

curl -fsS --max-time 8 "$DASH/connexion" >/dev/null 2>&1
verifier "Le tableau de bord répond" "$?"

# ===========================================================================
section "2. Authentification"
# ===========================================================================
# L'administrateur de commune AVANT le super-admin : ce dernier n'est
# rattaché à aucune commune, et les routes filtrées par commune lui répondent
# — à juste titre — qu'il n'a rien à y voir. La recette conclurait à une panne.
COMPTE=$(psql_admin -c "SELECT telephone FROM app.utilisateur
  WHERE role IN ('admin_commune','super_admin') AND actif AND archive_le IS NULL
    AND commune_id IS NOT NULL
  ORDER BY (role <> 'admin_commune'), (matricule LIKE 'DEMO-%'), cree_le
  LIMIT 1" 2>/dev/null | tr -d ' ')

# Repli : aucune commune rattachée nulle part — installation neuve.
if [[ -z "$COMPTE" ]]; then
  COMPTE=$(psql_admin -c "SELECT telephone FROM app.utilisateur
    WHERE role IN ('admin_commune','super_admin') AND actif AND archive_le IS NULL
    ORDER BY (role <> 'admin_commune'), cree_le LIMIT 1" 2>/dev/null | tr -d ' ')
fi

if [[ -z "$COMPTE" ]]; then
  alerter "Aucun compte administrateur — recette métier impossible" \
    "node apps/api/scripts/creer-utilisateur.js --role super_admin ..."
  printf '%s\n' "${RESULTATS[@]}"; echo; exit 1
fi

echo "  ${GRIS}Compte utilisé : $COMPTE${NC}"

# Le mot de passe se saisit au clavier : il n'a rien à faire dans un fichier
# ni dans l'historique du shell. RECETTE_MDP existe pour les enchaînements
# automatisés — déploiement, vérification après correction — où personne
# n'est devant l'écran.
if [[ -n "${RECETTE_MDP:-}" ]]; then
  MOTDEPASSE="$RECETTE_MDP"
  echo "  ${GRIS}Mot de passe fourni par RECETTE_MDP${NC}"
elif [[ -t 0 ]]; then
  echo -n "  Mot de passe : "
  read -rs MOTDEPASSE; echo
else
  # Sans terminal et sans variable, « read » attendrait indéfiniment : la
  # recette s'arrêterait sans un mot d'explication.
  alerter "Aucun terminal pour saisir le mot de passe" \
    "relancez avec RECETTE_MDP=... bash scripts/recette.sh"
  printf '%s\n' "${RESULTATS[@]}"; echo; exit 1
fi

reponse=$(curl -s -m 15 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"telephone\":\"$COMPTE\",\"mot_de_passe\":\"$MOTDEPASSE\"}" 2>/dev/null || echo '{}')
JETON=$(echo "$reponse" | node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8')).donnees.jeton_acces}catch(e){''}" 2>/dev/null || echo '')

[[ -n "$JETON" ]]
verifier "Connexion réussie" "$?" "$(echo "$reponse" | head -c 140)"
[[ -n "$JETON" ]] || { printf '%s\n' "${RESULTATS[@]}"; echo; exit 1; }

# Un mauvais mot de passe DOIT être refusé — sinon l'authentification ne
# protège rien.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"telephone\":\"$COMPTE\",\"mot_de_passe\":\"mauvais-mot-de-passe\"}")
[[ "$code" == "401" ]]
verifier "Un mauvais mot de passe est refusé" "$?" "(reçu $code)"

H=(-H "Authorization: Bearer $JETON")
appel() { curl -s -m 25 "${H[@]}" "$@"; }
lire() { node -pe "try{JSON.parse(require('fs').readFileSync(0,'utf8'))$1}catch(e){''}" 2>/dev/null || echo ''; }

# ===========================================================================
section "3. Référentiels et isolation"
# ===========================================================================
nbCommerces=$(appel "$API/commerces?limite=1" | lire ".pagination.total")
[[ "${nbCommerces:-0}" -ge 0 ]]
verifier "Lecture des commerces (${nbCommerces:-?})" "$?"

nbCategories=$(appel "$API/categories" | lire ".donnees.length")
[[ "${nbCategories:-0}" -gt 0 ]]
verifier "Catégories de commerces (${nbCategories:-0})" "$?"

nbQuartiers=$(appel "$API/quartiers" | lire ".donnees.length")
[[ "${nbQuartiers:-0}" -gt 0 ]]
verifier "Quartiers (${nbQuartiers:-0})" "$?"

# Sans jeton, l'API doit refuser : c'est la base de tout le reste
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$API/commerces")
[[ "$code" == "401" ]]
verifier "Sans jeton, l'API refuse" "$?" "(reçu $code)"

# Le rôle applicatif ne doit voir aucune ligne sans contexte de commune :
# c'est la garantie d'isolation multi-communes.
sansContexte=$(docker exec -e PGPASSWORD="${DB_PASSWORD}" "$PG_CONTENEUR" \
  psql -tAX -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT count(*) FROM app.commerce" 2>/dev/null | tr -d ' ')
[[ "${sansContexte:-1}" == "0" ]]
verifier "Isolation : 0 ligne visible sans contexte de commune" "$?" "(vu $sansContexte)"

# Le journal d'audit doit être inaltérable
docker exec -e PGPASSWORD="${DB_PASSWORD}" "$PG_CONTENEUR" \
  psql -tAX -U "${DB_USER}" -d "${DB_NAME}" -c "UPDATE audit.journal SET motif='x'" >/dev/null 2>&1
[[ $? -ne 0 ]]
verifier "Journal d'audit inaltérable" "$?"

# ===========================================================================
section "4. PostGIS — détection du quartier"
# ===========================================================================
communeId=$(psql_admin -c "SELECT id FROM app.commune WHERE actif LIMIT 1" | tr -d ' ')
# Séparateur VIRGULE, pas espace : le « tr -d ' ' » qui nettoie le remplissage
# de psql effacerait aussi le séparateur, et collerait longitude et latitude
# en un seul nombre absurde.
centre=$(psql_admin -c "SELECT ST_X(centre)||','||ST_Y(centre) FROM app.commune WHERE id='$communeId'" | tr -d ' ' || echo '')
lon=${centre%%,*}; lat=${centre##*,}
# Une coordonnée mal lue produirait un JSON invalide plus loin, avec un
# message qui n'aurait rien à voir. On s'en assure ici.
if [[ ! "$lon" =~ ^-?[0-9]+\.?[0-9]*$ || ! "$lat" =~ ^-?[0-9]+\.?[0-9]*$ ]]; then
  lon=""; lat=""
fi

if [[ -n "$lon" && -n "$lat" ]]; then
  methode=$(psql_admin -c "SELECT methode FROM app.detecter_quartier('$communeId', $lon, $lat) LIMIT 1" | tr -d ' ')
  [[ -n "$methode" ]]
  verifier "Détection du quartier par GPS (méthode : ${methode:-aucune})" "$?"
else
  alerter "Le centre de la commune n'est pas renseigné" "détection GPS non testable"
fi

# ===========================================================================
section "5. Calcul des taxes"
# ===========================================================================
unCommerce=$(appel "$API/commerces?limite=1" | lire ".donnees[0].id")
if [[ -n "$unCommerce" ]]; then
  simulation=$(appel "$API/taxes/simuler/$unCommerce")
  total=$(echo "$simulation" | lire ".donnees.total")
  nbLignes=$(echo "$simulation" | lire ".donnees.lignes.length")
  [[ "${nbLignes:-0}" -gt 0 ]]
  verifier "Simulation multi-taxes (${nbLignes:-0} lignes, total ${total:-?} XOF)" "$?"

  # Le détail du calcul doit être présent : c'est ce qui permet de justifier
  # un montant contesté au guichet.
  echo "$simulation" | grep -q 'detail'
  verifier "Le détail du calcul est fourni" "$?"
else
  alerter "Aucun commerce en base" "calcul de taxe non testable"
fi

# ===========================================================================
section "6. Écriture — création d'un commerce de recette"
# ===========================================================================
if [[ "$SANS_ECRIRE" == "1" ]]; then
  echo "  ${GRIS}ignoré (mode lecture seule)${NC}"
else
  categorieId=$(appel "$API/categories" | lire ".donnees[0].id")
  quartierId=$(appel "$API/quartiers" | lire ".donnees[0].id")

  creation=$(curl -s -m 25 "${H[@]}" -X POST "$API/commerces" -H 'Content-Type: application/json' \
    -d "{\"enseigne\":\"RECETTE — commerce de contrôle\",
         \"categorie_id\":\"$categorieId\",\"quartier_id\":\"$quartierId\",
         \"longitude\":$lon,\"latitude\":$lat,\"precision_gps_m\":8,
         \"gerant_telephone\":\"+221770000099\",\"telephone_paiement\":\"+221770000099\",
         \"todp_surface_m2\":5.5,\"notes\":\"RECETTE\"}")

  commerceId=$(echo "$creation" | lire ".donnees.id")
  code=$(echo "$creation" | lire ".donnees.code")
  [[ -n "$commerceId" ]]
  verifier "Création d'un commerce (${code:-?})" "$?" "$(echo "$creation" | head -c 140)"

  if [[ -n "$commerceId" ]]; then
    fiche=$(appel "$API/commerces/$commerceId")

    echo "$fiche" | grep -q '"qr_code"'
    verifier "Un QR code a été généré automatiquement" "$?"

    nbTaxes=$(echo "$fiche" | lire ".donnees.taxes.length")
    [[ "${nbTaxes:-0}" -gt 0 ]]
    verifier "Taxes rattachées d'après la catégorie (${nbTaxes:-0})" "$?"

    auto=$(echo "$fiche" | lire ".donnees.quartier_detecte_auto")
    [[ "$auto" == "true" ]] && verifier "Quartier rattaché par PostGIS" "0" \
      || alerter "Quartier saisi manuellement" "polygones de quartiers absents ?"

    # Le sticker imprimable
    codeHttp=$(curl -s -o /dev/null -w '%{http_code}' -m 20 "${H[@]}" "$API/commerces/$commerceId/sticker")
    [[ "$codeHttp" == "200" ]]
    verifier "Sticker A6 imprimable" "$?" "(reçu $codeHttp)"

    # Le journal d'audit doit avoir enregistré la création, tout seul
    trace=$(psql_admin -c "SELECT count(*) FROM audit.journal
      WHERE entite='commerce' AND entite_id='$commerceId' AND action='creation'" | tr -d ' ')
    [[ "${trace:-0}" -ge 1 ]]
    verifier "La création est tracée dans le journal d'audit" "$?"
  fi
fi

# ===========================================================================
section "7. Synchronisation hors-ligne"
# ===========================================================================
if [[ "$SANS_ECRIRE" == "1" ]]; then
  echo "  ${GRIS}ignoré (mode lecture seule)${NC}"
else
  paquet=$(appel "$API/sync/paquet")
  nbRef=$(echo "$paquet" | lire ".donnees.referentiels.categories.length")
  [[ "${nbRef:-0}" -gt 0 ]]
  verifier "Paquet hors-ligne téléchargeable (${nbRef:-0} catégories)" "$?"

  # Un lot envoyé deux fois ne doit encaisser qu'une fois
  lot="recette-$(date +%s)"
  envoyer() {
    curl -s -m 30 "${H[@]}" -X POST "$API/sync/batch" -H 'Content-Type: application/json' \
      -d "{\"identifiant_client\":\"$lot\",\"operations\":[{
        \"entite\":\"visite\",\"operation\":\"creation\",
        \"identifiant_local\":\"$lot-v1\",
        \"horodatage_client\":\"$(date -Iseconds)\",
        \"donnees\":{\"commerce_id\":\"${commerceId:-null}\",\"resultat\":\"controle\",
          \"commentaire\":\"RECETTE\",\"debute_le\":\"$(date -Iseconds)\"}}]}"
  }
  r1=$(envoyer); r2=$(envoyer)
  appliquees=$(echo "$r1" | lire ".donnees.resume.appliquees")
  rejoue=$(echo "$r2" | lire ".donnees.rejoue")

  [[ "${appliquees:-0}" == "1" ]]
  verifier "Lot de synchronisation appliqué" "$?" "$(echo "$r1" | head -c 140)"
  [[ "$rejoue" == "true" ]]
  verifier "Lot rejoué reconnu — pas de double application" "$?"
fi

# ===========================================================================
section "8. Paiement et quittance"
# ===========================================================================
mode="production"
[[ -z "${WAVE_API_KEY:-}" ]] && mode="SIMULATION"
echo "  ${GRIS}Mode Wave : $mode${NC}"

periodeId=$(appel "$API/periodes" | lire ".donnees[0].id")
if [[ -n "$periodeId" ]]; then
  verifier "Période fiscale disponible" "0"
  enAttente=$(psql_admin -c "SELECT count(*) FROM app.transaction_wave
    WHERE statut IN ('initiee','en_attente')" | tr -d ' ')
  [[ "${enAttente:-0}" -ge 0 ]]
  verifier "Liens de paiement en attente : ${enAttente:-0}" "$?"
else
  alerter "Aucune période fiscale" "POST /periodes puis /generer et /emettre"
fi

quittanceId=$(appel "$API/quittances?limite=1" | lire ".donnees[0].id")
if [[ -n "$quittanceId" ]]; then
  codeHttp=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${H[@]}" "$API/quittances/$quittanceId/pdf")
  [[ "$codeHttp" == "200" || "$codeHttp" == "302" ]]
  verifier "Quittance PDF téléchargeable" "$?" "(reçu $codeHttp)"
else
  alerter "Aucune quittance émise" "normal si aucun paiement n'a encore eu lieu"
fi

# ===========================================================================
section "9. Exports"
# ===========================================================================
for export in "commerces.xlsx" "paiements.xlsx" "recouvrement.pdf"; do
  codeHttp=$(curl -s -o /dev/null -w '%{http_code}' -m 60 "${H[@]}" "$API/exports/$export")
  [[ "$codeHttp" == "200" ]]
  verifier "Export $export" "$?" "(reçu $codeHttp)"
done

# ===========================================================================
# En local, il n'y a ni Nginx ni certificat : les contrôles HTTPS seraient
# rouges sans que rien ne soit cassé. On les signale plutôt que de les faire
# échouer — une recette qui crie au loup n'est plus lue.
LOCAL=0
[[ "$ENV_FICHIER" == ".env.demo" ]] && LOCAL=1

section "10. Accès public"
# ===========================================================================
# En local il n'y a ni Nginx ni certificat : contrôler HTTPS y produirait trois
# échecs rouges sans qu'aucune fonction ne soit cassée. Une recette qui crie au
# loup finit par ne plus être lue — et c'est le jour où elle a raison qu'on
# l'ignore. On l'annonce donc, et on éprouve ce qui est éprouvable : la page
# publique elle-même, servie par le tableau de bord local.
if [[ "$ENV_FICHIER" == ".env.demo" ]]; then
  echo "  ${GRIS}HTTPS non testé : ni Nginx ni certificat en local${NC}"
  BASE_PUBLIQUE="$DASH"
else
  for hote in "api.${APP_DOMAIN}/healthz" "gtfc.${APP_DOMAIN}/connexion"; do
    codeHttp=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${hote}" 2>/dev/null || echo 000)
    [[ "$codeHttp" == "200" ]]
    verifier "https://${hote}" "$?" "(reçu $codeHttp)"
  done
  BASE_PUBLIQUE="https://gtfc.${APP_DOMAIN}"
fi

# Le scan public d'un QR : sans compte, et sans divulguer de donnée fiscale.
jetonQr=$(psql_admin -c "SELECT jeton FROM app.qr_code WHERE actif LIMIT 1" | tr -d ' ')
if [[ -n "$jetonQr" ]]; then
  page=$(curl -s --max-time 15 "${BASE_PUBLIQUE}/c/${jetonQr}" 2>/dev/null || echo '')

  # Une page VIDE passerait le contrôle « ne divulgue rien » sans rien prouver.
  # On vérifie donc d'abord qu'elle a bien répondu.
  [[ -n "$page" ]]
  verifier "Page publique de scan QR accessible" "$?" "(${#page} octets)"

  if [[ -n "$page" ]]; then
    ! echo "$page" | grep -qiE "impay|reste dû|solde|FCFA"
    verifier "Elle ne divulgue aucune donnée fiscale" "$?"
  fi
else
  alerter "Aucun QR code actif" "page publique non testable"
fi

# ===========================================================================
section "11. Données provisoires"
# ===========================================================================
provisoires=$(psql_admin -c "SELECT count(*) FROM app.v_donnees_a_remplacer" 2>/dev/null | tr -d ' ' || echo '?')
if [[ "${provisoires:-0}" == "0" ]]; then
  verifier "Aucune donnée provisoire — prêt pour la production" "0"
else
  alerter "$provisoires données encore provisoires (barèmes inventés compris)" \
    "aucun avis ne doit être émis en l'état"
fi

especes=$(psql_admin -c "SELECT count(*) FROM app.paiement
  WHERE moyen='especes' AND verse_en_caisse_le IS NULL AND annule_le IS NULL
    AND paye_le < now() - interval '3 days'" 2>/dev/null | tr -d ' ' || echo 0)
[[ "${especes:-0}" == "0" ]] \
  && verifier "Aucun encaissement en espèces en attente de versement" "0" \
  || alerter "$especes encaissement(s) en espèces non versés depuis plus de 3 jours" \
       "à rapprocher avec la caisse"

# ===========================================================================
echo
echo "${GRAS}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
printf '%s\n' "${RESULTATS[@]}"
echo "${GRAS}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
if [[ $ECHECS -eq 0 && $ALERTES -eq 0 ]]; then
  echo "  ${VERT}${GRAS}$SUCCES contrôles réussis — la plateforme est opérationnelle${NC}"
elif [[ $ECHECS -eq 0 ]]; then
  echo "  ${JAUNE}${GRAS}$SUCCES réussis, $ALERTES point(s) à regarder${NC}"
else
  echo "  ${ROUGE}${GRAS}$SUCCES réussis, $ECHECS ÉCHEC(S), $ALERTES alerte(s)${NC}"
fi
echo
[[ $ECHECS -eq 0 ]] || exit 1
