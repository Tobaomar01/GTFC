#!/usr/bin/env bash
# ============================================================================
#  Répétition générale — le système dans les conditions du vrai
#
#  Les deux défauts les plus graves du projet avaient la même forme : deux
#  règles écrites séparément, chacune juste isolément, incompatibles ensemble.
#  Le code à usage unique renvoyé en clair dans la réponse HTTP. Le SMS mensuel
#  refusé par sa propre passerelle parce qu'il annonce un montant.
#
#  Ni l'un ni l'autre n'était visible en développement, et pour la MÊME
#  raison : en développement, la passerelle n'est pas raccordée et le mode
#  production n'est pas actif. Le système emprunte des chemins de repli qui
#  n'existeront pas le jour venu.
#
#  Cette répétition démarre donc l'API en NODE_ENV=production, avec une
#  passerelle SMS factice qui parle le vrai protocole, et parcourt la chaîne
#  entière : recensement, avis, émission, campagne, SMS réellement sorti,
#  paiement Wave signé, quittance.
#
#  Elle ne touche à aucun service extérieur. Aucun numéro réel n'est appelé,
#  aucun paiement réel n'est déclenché.
#
#  Usage :
#      bash scripts/repetition-generale.sh [base]
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-gtfc_recette}"
PORT_API="${PORT_API:-4321}"
PORT_SMS="${PORT_SMS:-4555}"
SECRET_WAVE="secret-de-repetition-generale"
MDP="${RECETTE_MDP:-GtfcDemo2026!}"

VERT=$'\033[0;32m'; ROUGE=$'\033[0;31m'; GRIS=$'\033[0;90m'; GRAS=$'\033[1m'; NC=$'\033[0m'
SUCCES=0; ECHECS=0
verifier() {
  if [ "$2" = "0" ]; then SUCCES=$((SUCCES+1)); echo "  ${VERT}✓${NC} $1"
  else ECHECS=$((ECHECS+1)); echo "  ${ROUGE}✗${NC} $1 ${GRIS}${3:-}${NC}"; fi
}

nettoyer() {
  [ -n "${PID_API:-}" ] && kill "$PID_API" 2>/dev/null
  [ -n "${PID_SMS:-}" ] && kill "$PID_SMS" 2>/dev/null
}
trap nettoyer EXIT

echo
echo "${GRAS}Répétition générale — configuration de production${NC}"
echo "${GRIS}base $BASE · API $PORT_API · passerelle SMS factice $PORT_SMS${NC}"

# --- La passerelle factice ---------------------------------------------------
node outils/passerelle-sms-factice.js "$PORT_SMS" > /tmp/repetition-sms.log 2>&1 &
PID_SMS=$!
sleep 1

# --- L'API, en production ----------------------------------------------------
# Tout ce que la configuration de production exige, et rien de simulé : c'est
# le point de l'exercice.
(
  cd apps/api
  NODE_ENV=production \
  API_PORT="$PORT_API" \
  DB_NAME="$BASE" \
  LOG_LEVEL=error \
  JWT_SECRET="$(openssl rand -base64 48)" \
  CORS_ORIGINS="https://gtfc.exemple.sn" \
  SMS_ACTIF=true SMS_FOURNISSEUR=generique \
  SMS_BASE_URL="http://127.0.0.1:${PORT_SMS}/" SMS_API_KEY=factice SMS_EXPEDITEUR=MAIRIE \
  WAVE_ACTIF=true WAVE_WEBHOOK_SECRET="$SECRET_WAVE" \
  node src/server.js
) > /tmp/repetition-api.log 2>&1 &
PID_API=$!

API="http://127.0.0.1:${PORT_API}"
for _ in $(seq 1 30); do
  curl -fsS -m 2 "$API/healthz" >/dev/null 2>&1 && break
  sleep 1
done

echo
echo "${GRAS}1. Démarrage en production${NC}"
curl -fsS -m 5 "$API/healthz" >/dev/null 2>&1
verifier "L'API démarre avec une configuration de production" "$?" \
  "(voir /tmp/repetition-api.log)"
if [ "$ECHECS" -gt 0 ]; then
  echo; sed -n '1,20p' /tmp/repetition-api.log; exit 1
fi

lire() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const v=$1;console.log(v??'')}catch{console.log('')}})"; }

# --- Connexion ---------------------------------------------------------------
echo
echo "${GRAS}2. Connexion${NC}"
JETON=$(curl -s -m 10 -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d "{\"telephone\":\"+221700000002\",\"mot_de_passe\":\"${MDP}\"}" | lire "j.donnees.jeton_acces")
[ -n "$JETON" ]
verifier "L'administrateur se connecte" "$?"
H=(-H "authorization: Bearer $JETON" -H 'content-type: application/json')

# --- Le code à usage unique ne doit PAS revenir ------------------------------
echo
echo "${GRAS}3. Code à usage unique${NC}"
# Un redevable vérifié qui n'a pas épuisé son quota horaire. Le plafond de
# cinq demandes par heure est une protection voulue : rejouer la répétition
# plusieurs fois de suite l'atteint, et l'exercice échouerait alors sur un
# comportement correct.
TEL_REDEVABLE=$(psql -q "$BASE" -At -c \
  "SELECT r.telephone
     FROM app.redevable r
     LEFT JOIN app.code_acces c
            ON c.telephone = r.telephone AND c.cree_le > now() - interval '1 hour'
    WHERE r.statut_telephone = 'verifie'
    GROUP BY r.telephone
   HAVING count(c.id) < 4
    ORDER BY count(c.id)
    LIMIT 1")

if [ -z "$TEL_REDEVABLE" ]; then
  echo "  ${GRIS}Aucun redevable vérifié sous le quota horaire : étape reportée${NC}"
fi
if [ -n "$TEL_REDEVABLE" ]; then
COMMUNE_SLUG=$(psql -q "$BASE" -At -c "SELECT slug FROM app.commune LIMIT 1")
REPONSE=$(curl -s -m 10 -X POST "$API/portail/code" -H 'content-type: application/json' \
  -d "{\"commune\":\"${COMMUNE_SLUG}\",\"telephone\":\"${TEL_REDEVABLE}\"}")
echo "$REPONSE" | grep -q 'code_simule'
[ "$?" -ne 0 ]
verifier "Le code n'apparaît pas dans la réponse HTTP" "$?" "$(echo "$REPONSE" | head -c 120)"

sleep 1
NB_SMS=$(curl -s -m 5 "http://127.0.0.1:${PORT_SMS}/_recus" | lire "j.nb")
[ "${NB_SMS:-0}" -ge 1 ]
verifier "Le code est bien parti par la passerelle" "$?" "(reçus : ${NB_SMS:-0})"
fi

# --- La campagne mensuelle ---------------------------------------------------
echo
echo "${GRAS}4. Campagne mensuelle${NC}"
# La période qui porte réellement des avis, non la plus récente : une période
# ouverte mais vide donnerait une campagne sans destinataire, et l'exercice
# passerait au vert sans avoir rien éprouvé.
PERIODE=$(psql -q "$BASE" -At -c \
  "SELECT p.id FROM app.periode_fiscale p
     JOIN app.avis_imposition a ON a.periode_id = p.id AND a.annule_le IS NULL
    WHERE NOT p.close
    GROUP BY p.id, p.date_debut
    ORDER BY count(*) DESC, p.date_debut DESC LIMIT 1")

# Les avis doivent être ÉMIS : une campagne sur des brouillons n'envoie rien.
curl -s -m 60 -X POST "$API/periodes/${PERIODE}/emettre" "${H[@]}" >/dev/null
NB_EMIS=$(psql -q "$BASE" -At -c \
  "SELECT count(*) FROM app.avis_imposition WHERE periode_id='${PERIODE}' AND statut IN ('emis','partiellement_paye')")
[ "${NB_EMIS:-0}" -ge 1 ]
verifier "Les avis sont émis (${NB_EMIS:-0})" "$?"

curl -s -X POST "http://127.0.0.1:${PORT_SMS}/_vider" >/dev/null
CAMPAGNE=$(curl -s -m 120 -X POST "$API/campagnes/${PERIODE}/lancer" "${H[@]}")

# La campagne ne renotifie pas ce qui l'a déjà été — c'est la règle : une
# seule notification par mois. Au second passage de cette répétition, la file
# est donc vide, et exiger un envoi ferait échouer l'exercice sur un
# comportement correct. On mesure ce qu'il y a À ENVOYER avant de conclure.
EN_FILE=$(psql -q "$BASE" -At -c \
  "SELECT count(*) FROM app.notification WHERE statut = 'en_attente' AND nb_tentatives < 3")
NOTIFS=$(echo "$CAMPAGNE" | lire "j.donnees?.notifications")
[ -n "$NOTIFS" ]
verifier "La campagne s'exécute" "$?" "$(echo "$CAMPAGNE" | head -c 160)"

# Le traitement de la file est ce qui fait réellement sortir les messages.
curl -s -m 120 -X POST "$API/notifications/traiter" "${H[@]}" \
  -d '{"limite":200}' >/dev/null 2>&1
sleep 2
SORTIS=$(curl -s -m 5 "http://127.0.0.1:${PORT_SMS}/_recus" | lire "j.nb")

if [ "${EN_FILE:-0}" -gt 0 ]; then
  [ "${SORTIS:-0}" -ge 1 ]
  verifier "Des SMS sortent réellement vers la passerelle (${SORTIS:-0}/${EN_FILE})" "$?" \
    "aucun message n'est parti — c'est le défaut que cette répétition cherche"

  RESTANT=$(psql -q "$BASE" -At -c \
    "SELECT count(*) FROM app.notification WHERE statut IN ('en_attente','echec') AND nb_tentatives > 0")
  [ "${RESTANT:-0}" = "0" ]
  verifier "Aucun message ne reste en échec" "$?" "(${RESTANT:-0} en souffrance)"
else
  echo "  ${GRIS}Rien à envoyer : la campagne ne renotifie pas ce mois-ci${NC}"
fi

if [ "${SORTIS:-0}" -ge 1 ]; then
  TROP_LONG=$(curl -s -m 5 "http://127.0.0.1:${PORT_SMS}/_recus" \
    | lire "j.messages.filter(m=>m.longueur>320).length")
  [ "${TROP_LONG:-0}" = "0" ]
  verifier "Aucun message ne dépasse deux segments" "$?" "(${TROP_LONG} trop longs)"

  AVEC_ACCENT=$(curl -s -m 5 "http://127.0.0.1:${PORT_SMS}/_recus" \
    | lire "j.messages.filter(m=>/[à-ÿ]/i.test(m.texte)).length")
  [ "${AVEC_ACCENT:-0}" = "0" ]
  verifier "Aucun accent : l'encodage reste sur 7 bits" "$?" "(${AVEC_ACCENT} accentués)"
fi

# --- Le paiement Wave --------------------------------------------------------
echo
echo "${GRAS}5. Paiement Wave signé${NC}"
AVIS=$(psql -q "$BASE" -At -F'|' -c \
  "SELECT a.id, a.commune_id, a.montant_restant FROM app.avis_imposition a
    WHERE a.periode_id='${PERIODE}' AND a.montant_restant > 1000 AND a.annule_le IS NULL LIMIT 1")
AVIS_ID="${AVIS%%|*}"; RESTE="${AVIS##*|}"
# Identifiant court : la référence du paiement est composée des SEIZE
# DERNIERS caractères de la session, mis en majuscules. Un identifiant plus
# long, et le script cherchait ensuite une référence qui ne correspondait plus
# à ce qu'il avait posé.
SESSION="rep$(date +%s)"
psql -q "$BASE" -c "INSERT INTO app.transaction_wave
  (commune_id, avis_id, wave_session_id, montant, statut)
  SELECT commune_id, id, '${SESSION}', 1000, 'initiee'
    FROM app.avis_imposition WHERE id='${AVIS_ID}'" >/dev/null

CORPS="{\"type\":\"checkout_session_completed\",\"data\":{\"id\":\"${SESSION}\",\"amount\":1000}}"
HORO=$(date +%s)
SIG=$(node -e "
  const c=require('crypto');
  console.log(c.createHmac('sha256','${SECRET_WAVE}').update('${HORO}.'+process.argv[1]).digest('hex'));
" "$CORPS")

CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "$API/webhooks/wave" \
  -H 'content-type: application/json' -H "wave-signature: t=${HORO},v1=${SIG}" -d "$CORPS")
[ "$CODE" = "200" ]
verifier "Le webhook signé est accepté" "$?" "(reçu $CODE)"

MAUVAIS=$(curl -s -o /dev/null -w '%{http_code}' -m 15 -X POST "$API/webhooks/wave" \
  -H 'content-type: application/json' -H "wave-signature: t=${HORO},v1=00" -d "$CORPS")
[ "$MAUVAIS" = "401" ]
verifier "Une signature invalide est refusée" "$?" "(reçu $MAUVAIS)"

REFERENCE="WAVE-$(echo "$SESSION" | tr '[:lower:]' '[:upper:]')"
PAYE=$(psql -q "$BASE" -At -c \
  "SELECT count(*) FROM app.paiement WHERE reference = '${REFERENCE}' AND annule_le IS NULL")
[ "${PAYE:-0}" = "1" ]
verifier "Le paiement est enregistré une fois" "$?" "(${PAYE:-0})"

QUITTANCE=$(psql -q "$BASE" -At -c \
  "SELECT count(*) FROM app.quittance q JOIN app.paiement p ON p.id=q.paiement_id
    WHERE p.reference = '${REFERENCE}'")
[ "${QUITTANCE:-0}" = "1" ]
verifier "Une quittance est émise" "$?" "(${QUITTANCE:-0})"

# --- On contre-passe : la répétition ne laisse pas d'argent derrière elle -----
psql -q "$BASE" -c "UPDATE app.paiement SET annule_le=now(),
  motif_annulation='contre-passation de répétition générale'
  WHERE reference = '${REFERENCE}' AND annule_le IS NULL" >/dev/null
psql -q "$BASE" -c "DELETE FROM app.transaction_wave WHERE wave_session_id='${SESSION}'" >/dev/null

# --- Le journal d'audit a-t-il tenu ? ----------------------------------------
echo
echo "${GRAS}6. Après coup${NC}"
CHAINE=$(psql -q "$BASE" -At -c \
  "SELECT coalesce((SELECT rupture_motif FROM audit.verifier_chaine() LIMIT 1),'intacte')")
[ "$CHAINE" = "intacte" ]
verifier "La chaîne du journal d'audit est intacte" "$?" "($CHAINE)"

ERREURS=$(grep -ci "error\|ERREUR_INTERNE" /tmp/repetition-api.log 2>/dev/null || true)
[ "${ERREURS:-0}" = "0" ]
verifier "Aucune erreur interne pendant la répétition" "$?" \
  "(${ERREURS:-0} — voir /tmp/repetition-api.log)"

echo
echo "───────────────────────────────────────────────────────────"
if [ "$ECHECS" -gt 0 ]; then
  echo "  ${ROUGE}${GRAS}${SUCCES} réussis, ${ECHECS} ÉCHEC(S)${NC}"
  exit 1
fi
echo "  ${VERT}${GRAS}${SUCCES} réussis${NC} — la chaîne tient en conditions de production"
