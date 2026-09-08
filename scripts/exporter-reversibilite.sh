#!/usr/bin/env bash
# ============================================================================
#  Export de réversibilité — la sortie de la commune du dispositif
#  Plateforme GTFC
#
#  La constitution, principe VI : « Les données DOIVENT pouvoir être exportées
#  à tout moment dans un format ouvert et documenté, sans outil propriétaire.
#  La sortie de la commune du dispositif est un droit exerçable, pas une
#  clause. »
#
#  CE QUI EXISTAIT AVANT. Sept exports : le registre des commerces (xlsx, csv,
#  geojson, pdf), les paiements, l'activité des agents, un état de recouvrement.
#  Utiles au travail quotidien, insuffisants pour partir : ni les redevables,
#  ni les avis d'imposition, ni le barème, ni les quittances, ni les
#  contestations, ni le référentiel territorial, ni le journal d'audit. Et sur
#  les trois natures imposables — commerce, affichage, chantier — seule la
#  première sortait. La commune serait repartie avec un annuaire, pas avec son
#  registre fiscal.
#
#  LA LISTE DES TABLES N'EST PAS ÉCRITE EN DUR. Elle est dérivée du schéma à
#  chaque exécution. Un inventaire figé rouille : une table ajoutée un mardi
#  serait oubliée en silence, et personne ne s'en apercevrait avant le jour du
#  divorce. Ici, toute table est soit exportée, soit explicitement exclue avec
#  son motif — et l'exercice de réversibilité refuse de passer si une table
#  n'est ni l'un ni l'autre.
#
#  Usage :
#      bash scripts/exporter-reversibilite.sh
#      bash scripts/exporter-reversibilite.sh --commune gtfc
#      bash scripts/exporter-reversibilite.sh --vers /chemin/de/sortie
#      bash scripts/exporter-reversibilite.sh --sans-objets
# ============================================================================
set -Eeuo pipefail
cd "$(dirname "$0")/.."

SLUG=""
DESTINATION=""
AVEC_OBJETS=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --commune)      SLUG="${2:?--commune attend un slug}"; shift ;;
        --vers)         DESTINATION="${2:?--vers attend un chemin}"; shift ;;
        --sans-objets)  AVEC_OBJETS=0 ;;
        -h|--help)      sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Option inconnue : $1" >&2; exit 2 ;;
    esac
    shift
done

[[ -f .env ]] || { echo "[ERREUR] .env introuvable" >&2; exit 1; }
# shellcheck disable=SC1091
set -a; source .env; set +a

# Defaut : le nom de docker-compose.yml, donc celui de la production.
# La premiere version portait « gtfc-pg17 », le nom de la machine de recette :
# l'export aurait echoue sur le serveur, la ou il sert.
CONTENEUR="${PG_CONTENEUR:-gtfc-postgres}"
BASE="${DB_NAME:-gtfc_recette}"

# ---------------------------------------------------------------------------
#  Accès à PostgreSQL.
#
#  Deux chemins, et JAMAIS l'un qui s'appelle lui-même : c'est le défaut qui a
#  bloqué scripts/recette.sh, sa branche conteneur se rappelant elle-même au
#  lieu d'appeler docker.
# ---------------------------------------------------------------------------
if docker inspect -f '{{.State.Running}}' "$CONTENEUR" 2>/dev/null | grep -q true; then
    psql_q()   { docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -tAX -c "$1"; }
    psql_csv() { docker exec -i "$CONTENEUR" psql -U postgres -d "$BASE" -c "COPY ($1) TO STDOUT WITH (FORMAT csv, HEADER true)"; }
    pg_ddl()   { docker exec -i "$CONTENEUR" pg_dump -U postgres -d "$BASE" --schema-only --no-owner --no-privileges; }
    VOIE="conteneur ${CONTENEUR}"
elif command -v psql >/dev/null 2>&1; then
    psql_q()   { psql -d "$BASE" -tAX -c "$1"; }
    psql_csv() { psql -d "$BASE" -c "COPY ($1) TO STDOUT WITH (FORMAT csv, HEADER true)"; }
    pg_ddl()   { pg_dump -d "$BASE" --schema-only --no-owner --no-privileges; }
    VOIE="psql natif"
else
    echo "[ERREUR] Ni le conteneur ${CONTENEUR} ni psql ne sont disponibles." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
#  Tables volontairement exclues, et pourquoi.
#  Le motif est repris dans le manifeste : une exclusion sans raison est une
#  omission qui se cache.
# ---------------------------------------------------------------------------
declare -A EXCLUES=(
  ["app.session"]="jetons d'authentification en cours — les exporter serait une faille, et ils ne valent plus rien après la sortie"
  ["app.session_redevable"]="idem, sessions du portail des redevables"
  ["app.tache_planifiee"]="journal interne du planificateur, sans valeur pour la commune"
  ["app.schema_migration"]="registre des migrations appliquées — état de l'outil, pas donnée de la commune ; il ne veut rien dire sans le code qui va avec, et le schéma part déjà dans schema.sql"
)

# ---------------------------------------------------------------------------
#  Tables sans commune_id, rattachées par leur parent.
# ---------------------------------------------------------------------------
declare -A PAR_PARENT=(
  ["app.avis_ligne"]="SELECT %COLS% FROM app.avis_ligne WHERE avis_id IN (SELECT id FROM app.avis_imposition WHERE commune_id = '%s')"
  ["app.bareme_tranche"]="SELECT %COLS% FROM app.bareme_tranche WHERE bareme_id IN (SELECT id FROM app.bareme_taxe WHERE commune_id = '%s')"
  ["app.chantier_occupation"]="SELECT %COLS% FROM app.chantier_occupation WHERE chantier_id IN (SELECT id FROM app.chantier WHERE commune_id = '%s')"
  ["app.affectation_agent"]="SELECT %COLS% FROM app.affectation_agent WHERE utilisateur_id IN (SELECT id FROM app.utilisateur WHERE commune_id = '%s')"
  ["app.feuille_route_ligne"]="SELECT %COLS% FROM app.feuille_route_ligne WHERE feuille_id IN (SELECT id FROM app.feuille_route WHERE commune_id = '%s')"
)

# ---------------------------------------------------------------------------
#  Les colonnes GÉNÉRÉES ne sont pas exportées.
#
#  « SELECT * » les inclut, mais « COPY table FROM » les refuse : PostgreSQL
#  les recalcule et n'accepte pas qu'on les lui dicte. Un CSV qui les porte
#  fait échouer le rechargement sur « extra data after last expected column ».
#
#  Le premier export les emportait. Il se produisait sans une erreur, et dix
#  tables sur quarante-huit refusaient de se recharger — commerce, redevable,
#  rue, utilisateur, avis_imposition… Rien ne le signalait : c'est l'exercice
#  de rechargement qui l'a montré, pas l'export.
#
#  Elles ne manquent à personne : elles se recalculent à l'insertion. Ce sont
#  des formes normalisées pour la recherche, des durées, des soldes dérivés.
# ---------------------------------------------------------------------------
colonnes_de() {
    psql_q "SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
              FROM information_schema.columns
             WHERE table_schema = '$1' AND table_name = '$2'
               AND is_generated = 'NEVER'" | tr -d '\r'
}

# ---------------------------------------------------------------------------
#  Référentiels partagés, exportés en entier : sans eux, les codes présents
#  dans les données de la commune ne veulent plus rien dire.
# ---------------------------------------------------------------------------
declare -A GLOBALES=(
  ["ref.type_taxe"]=1
  ["ref.categorie_taxe"]=1
)

# ---------------------------------------------------------------------------
echo "==> Commune"
if [[ -z "$SLUG" ]]; then
    NB=$(psql_q "SELECT count(*) FROM app.commune" | tr -d '\r')
    [[ "$NB" == "1" ]] || { echo "Plusieurs communes en base : precisez --commune <slug>." >&2; exit 2; }
    LIGNE=$(psql_q "SELECT id || '|' || slug || '|' || nom FROM app.commune" | tr -d '\r')
else
    LIGNE=$(psql_q "SELECT id || '|' || slug || '|' || nom FROM app.commune WHERE slug = '${SLUG}'" | tr -d '\r')
fi
[[ -n "$LIGNE" ]] || { echo "Commune introuvable." >&2; exit 1; }
COMMUNE_ID="${LIGNE%%|*}"; RESTE="${LIGNE#*|}"
COMMUNE_SLUG="${RESTE%%|*}"; COMMUNE_NOM="${RESTE#*|}"
echo "    ${COMMUNE_NOM} (${COMMUNE_SLUG}) — ${COMMUNE_ID}"
echo "    acces : ${VOIE}, base ${BASE}"

HORODATAGE="$(date +%Y%m%d-%H%M%S)"
SORTIE="${DESTINATION:-./reversibilite-${COMMUNE_SLUG}-${HORODATAGE}}"
mkdir -p "${SORTIE}/donnees"
echo "==> Sortie : ${SORTIE}"

# ---------------------------------------------------------------------------
#  Portee du journal d'audit.
#
#  Le declencheur d'audit inscrit le commune_id de la ligne modifiee. Les
#  tables qui n'en portent pas — avis_ligne, bareme_tranche,
#  chantier_occupation, affectation_agent — produisent donc des entrees a
#  commune_id NUL. Mesure sur la base de recette : 197 lignes sur 2015, dont
#  132 creations d'avis_ligne et 60 de bareme_tranche.
#
#  Ce sont les plus probantes : le detail du calcul d'une taxe et les tranches
#  du bareme. Les laisser derriere reviendrait a livrer les montants sans la
#  trace de qui les a etablis — precisement ce qu'une contestation met en
#  cause.
#
#  Sur une base a commune unique, ces lignes ne peuvent appartenir a personne
#  d'autre : on les emporte. Sur une plateforme multi-communes, elles sont
#  ambigues, et les emporter ferait fuiter le journal d'une autre commune vers
#  celle qui part. On s'arrete alors, plutot que de deviner.
# ---------------------------------------------------------------------------
NB_COMMUNES=$(psql_q "SELECT count(*) FROM app.commune" | tr -d '')
if [[ "$NB_COMMUNES" == "1" ]]; then
    AUDIT_PORTEE="commune_id = '${COMMUNE_ID}' OR commune_id IS NULL"
    AUDIT_NOTE="commune_id, plus les lignes sans commune (base a commune unique)"
    NB_ORPHELINES_AUDIT=$(psql_q "SELECT count(*) FROM audit.journal WHERE commune_id IS NULL" | tr -d '')
    echo "==> Journal d'audit : ${NB_ORPHELINES_AUDIT} lignes sans commune, emportees (commune unique)"
else
    AUDIT_PORTEE="commune_id = '${COMMUNE_ID}'"
    AUDIT_NOTE="commune_id seul — voir l'avertissement du manifeste"
    echo "==> Journal d'audit : ATTENTION, base multi-communes"
    echo "    Les lignes d'audit sans commune_id (avis_ligne, bareme_tranche) ne"
    echo "    peuvent pas etre attribuees et NE SERONT PAS exportees."
fi

echo "==> Inventaire des tables"
TABLES=$(psql_q "
  SELECT n.nspname || '.' || c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('app','ref','audit')
     AND c.relkind IN ('r','p')
     AND NOT c.relispartition
   ORDER BY 1" | tr -d '\r')
NB_TABLES=$(echo "$TABLES" | grep -c . || true)
echo "    ${NB_TABLES} tables (partitions ecartees : le parent les contient)"

echo "==> Export"
MANIFESTE_LIGNES=""
EXPORTEES=0; ECARTEES=0; ORPHELINES=0

for T in $TABLES; do
    if [[ -n "${EXCLUES[$T]:-}" ]]; then
        MANIFESTE_LIGNES+="| \`${T}\` | — | *exclue* : ${EXCLUES[$T]} |"$'\n'
        ECARTEES=$((ECARTEES + 1))
        continue
    fi

    SCHEMA="${T%%.*}"; NOM="${T#*.}"

    # Les colonnes reelles, sans les generees : voir colonnes_de() plus haut.
    COLS=$(colonnes_de "$SCHEMA" "$NOM")
    [[ -n "$COLS" ]] || { echo "    !! ${T} : aucune colonne lisible" >&2; exit 1; }

    if [[ -n "${PAR_PARENT[$T]:-}" ]]; then
        MODELE="${PAR_PARENT[$T]//%COLS%/$COLS}"
        REQUETE=$(printf "$MODELE" "$COMMUNE_ID")
        PORTEE="rattachee par son parent"
    elif [[ -n "${GLOBALES[$T]:-}" ]]; then
        REQUETE="SELECT ${COLS} FROM ${T}"
        PORTEE="referentiel partage, en entier"
    elif [[ "$SCHEMA" == "audit" ]]; then
        REQUETE="SELECT ${COLS} FROM ${T} WHERE ${AUDIT_PORTEE}"
        PORTEE="${AUDIT_NOTE}"
    elif [[ "$T" == "app.commune" ]]; then
        REQUETE="SELECT ${COLS} FROM app.commune WHERE id = '${COMMUNE_ID}'"
        PORTEE="la commune elle-meme"
    else
        A_COMMUNE=$(psql_q "SELECT 1 FROM information_schema.columns WHERE table_schema='${SCHEMA}' AND table_name='${NOM}' AND column_name='commune_id'" | tr -d '\r')
        if [[ "$A_COMMUNE" == "1" ]]; then
            REQUETE="SELECT ${COLS} FROM ${T} WHERE commune_id = '${COMMUNE_ID}'"
            PORTEE="commune_id"
        else
            echo "    !! ${T} : ni commune_id, ni parent connu, ni exclusion — NON EXPORTEE"
            MANIFESTE_LIGNES+="| \`${T}\` | **?** | **non traitee — portee inconnue** |"$'\n'
            ORPHELINES=$((ORPHELINES + 1))
            continue
        fi
    fi

    FICHIER="${SORTIE}/donnees/${T}.csv"
    psql_csv "$REQUETE" > "$FICHIER"
    LIGNES=$(( $(wc -l < "$FICHIER") - 1 ))
    [[ $LIGNES -lt 0 ]] && LIGNES=0
    printf "    %-34s %6d lignes\n" "$T" "$LIGNES"
    MANIFESTE_LIGNES+="| \`${T}\` | ${LIGNES} | ${PORTEE} |"$'\n'
    EXPORTEES=$((EXPORTEES + 1))
done

echo "==> Structure de la base"
pg_ddl > "${SORTIE}/schema.sql"
echo "    schema.sql — $(wc -l < "${SORTIE}/schema.sql") lignes de DDL"

NB_OBJETS=0
if [[ $AVEC_OBJETS -eq 1 ]] && docker inspect -f '{{.State.Running}}' gtfc-minio 2>/dev/null | grep -q true; then
    echo "==> Objets (photos, quittances, QR)"
    mkdir -p "${SORTIE}/objets"

    # Docker sous Windows ne monte pas un chemin MSYS (/c/Users/...). « pwd -W »
    # rend la forme que le moteur comprend ; ailleurs, « pwd » suffit. Sans
    # cela le montage echoue en silence et le miroir ecrit dans le conteneur,
    # qui disparait aussitot : zero fichier, et aucune erreur.
    # UN SEUL « cd ». La forme precedente en faisait deux : la premiere branche
    # changeait de dossier PUIS echouait sur « pwd -W », qui n'existe pas hors
    # de Git Bash ; le repli refaisait alors le meme cd RELATIF depuis le dossier
    # ou il venait d'arriver. Sur un serveur Linux, avec un SORTIE relatif :
    #     cd: ./reversibilite-gtfc-20260908-172742/objets: No such file or directory
    # ABSOLU restait vide, et l'export de reversibilite — la garantie que la
    # commune peut partir avec ses donnees — s'arretait la, sans manifeste ni
    # archive. Il ne marchait que sous Windows, ou « pwd -W » reussit du premier
    # coup et le second cd n'a jamais lieu.
    ABSOLU="$(cd "${SORTIE}/objets" && { pwd -W 2>/dev/null || pwd; })"

    ATTENDUS=0
    for B in "${MINIO_BUCKET_PHOTOS}" "${MINIO_BUCKET_DOCUMENTS}" "${MINIO_BUCKET_QRCODES}"; do
        N=$(MSYS_NO_PATHCONV=1 docker run --rm --network gtfc-net \
              -e "MC_HOST_gtfc=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
              minio/mc:RELEASE.2024-10-08T09-37-26Z \
              ls --recursive "gtfc/${B}" 2>/dev/null | grep -c . || true)
        ATTENDUS=$((ATTENDUS + N))

        # Pas de « || true » ici : un miroir qui echoue doit se voir. C'est
        # justement un « || true » qui masquait l'echec du montage.
        if ! MSYS_NO_PATHCONV=1 docker run --rm --network gtfc-net \
                -v "${ABSOLU}:/sortie" \
                -e "MC_HOST_gtfc=http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@minio:9000" \
                minio/mc:RELEASE.2024-10-08T09-37-26Z \
                mirror --overwrite --quiet "gtfc/${B}" "/sortie/${B}" >/dev/null 2>&1; then
            echo "    ECHEC du miroir de ${B}" >&2
            exit 1
        fi
    done

    NB_OBJETS=$({ find "${SORTIE}/objets" -type f 2>/dev/null || true; } | wc -l | tr -d ' ')
    echo "    ${NB_OBJETS} fichiers sur ${ATTENDUS} attendus"
    if [[ "${NB_OBJETS}" -ne "${ATTENDUS}" ]]; then
        echo "    ECHEC : le magasin contient ${ATTENDUS} objets, l'export en porte ${NB_OBJETS}." >&2
        echo "    Un export de reversibilite incomplet est pire qu'absent : il rassure." >&2
        exit 1
    fi
else
    echo "==> Objets : ignores"
fi

echo "==> Manifeste"
cat > "${SORTIE}/MANIFESTE.md" <<MANIFESTE
# Export de reversibilite — ${COMMUNE_NOM}

**Commune** : ${COMMUNE_NOM} (\`${COMMUNE_SLUG}\`)
**Identifiant** : ${COMMUNE_ID}
**Produit le** : $(date '+%Y-%m-%d %H:%M:%S')
**Base d'origine** : ${BASE}

Cet export existe pour que la commune puisse quitter le dispositif sans rien
perdre et sans rien acheter. C'est une obligation de la constitution du projet,
principe VI, et non une faveur : « la sortie de la commune du dispositif est un
droit exercable, pas une clause ».

## Ce que vous avez entre les mains

| Fichier | Format | Contenu |
|---|---|---|
| \`donnees/*.csv\` | CSV (RFC 4180), UTF-8, avec en-tete | une table par fichier, nomme \`schema.table.csv\` |
| \`schema.sql\` | SQL PostgreSQL | la structure complete : tables, colonnes, types, contraintes |
| \`objets/\` | JPEG, PNG, PDF | photos de devanture, QR codes, quittances |
| \`MANIFESTE.md\` | Markdown | ce fichier |

Aucun format proprietaire. Les CSV s'ouvrent avec LibreOffice, Excel, Python,
R, ou n'importe quel tableur. Le \`schema.sql\` se relit avec un editeur de
texte.

## Comment tout remonter dans une base neuve

\`\`\`bash
createdb registre_communal
psql -d registre_communal -f schema.sql
for f in donnees/*.csv; do
    t=\$(basename "\$f" .csv)          # ex. app.commerce
    psql -d registre_communal -c "\copy \${t} FROM '\$f' WITH (FORMAT csv, HEADER true)"
done
\`\`\`

L'ordre d'insertion peut buter sur les cles etrangeres. Le plus simple est de
les differer le temps du chargement :

\`\`\`sql
SET session_replication_role = replica;   -- suspend declencheurs et cles etrangeres
-- … chargement …
SET session_replication_role = origin;
\`\`\`

## Le detail, table par table

| Table | Lignes | Portee |
|---|---|---|
${MANIFESTE_LIGNES}

## Objets

${NB_OBJETS} fichiers, dans \`objets/\`, ranges par bucket. Les colonnes
\`bucket\` et \`chemin\` des tables \`app.commerce_photo\`, \`app.quittance\` et
\`app.qr_code\` donnent le chemin de chacun.

## Le journal d'audit

\`audit.journal.csv\` porte le registre probant : qui a modifie quoi, quand, et
la valeur avant/apres. Il est chaine par empreintes — chaque ligne porte celle
de la precedente. Le \`schema.sql\` contient les fonctions de verification.

Attention : depuis la migration 0062, l'empreinte se calcule sur un horodatage
canonique en UTC. Un journal scelle avant elle ne se verifie que dans le fuseau
horaire de la machine qui l'a ecrit.
MANIFESTE

echo "    MANIFESTE.md ecrit"

echo
if [[ $ORPHELINES -gt 0 ]]; then
    echo "ATTENTION : ${ORPHELINES} table(s) sans portee connue n'ont PAS ete exportees."
    echo "Completez PAR_PARENT ou EXCLUES dans ce script avant de livrer cet export."
fi
echo "Export termine — ${EXPORTEES} tables exportees, ${ECARTEES} exclues, ${ORPHELINES} sans portee."
echo "    ${SORTIE}"
[[ $ORPHELINES -eq 0 ]]
