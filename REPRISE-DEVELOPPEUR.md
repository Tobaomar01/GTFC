# Reprise du projet sur une autre machine

Ce paquet contient tout ce qui n'est pas déjà sur GitHub : les 31 commits qui
n'ont pas été poussés, la base de données, et la mémoire de travail de Claude.

Compte : le même que sur la machine d'origine. Rien à créer.

---

## Ce que c'est

Plateforme de collecte des taxes locales pour la commune de **Gueule
Tapée-Fass-Colobane**, à Dakar. Pilote en partenariat public-privé.

Trois applications et une base :

| | |
|---|---|
| `apps/api` | Express, PostgreSQL 17 + PostGIS. 94 tests. |
| `apps/dashboard` | Next.js. 12 pages, 13 tests de navigateur. |
| `apps/mobile` | Expo / React Native. Compile ; jamais installée sur un téléphone. |
| `db/` | 59 migrations, 13 seeds. Installation depuis une base vide vérifiée. |

Le dépôt d'origine est `github.com/Tobaomar01/GTFC`. **`master` n'a pas été
touché.** Tout le travail est sur la branche `conformite-specification`.

---

## Transfert, dans l'ordre

### 1. Le code

```bash
git clone https://github.com/Tobaomar01/GTFC.git ~/revenu-municipal/code-existant
cd ~/revenu-municipal/code-existant
git bundle verify /chemin/vers/code/gtfc-conformite-specification.bundle
git fetch /chemin/vers/code/gtfc-conformite-specification.bundle \
    conformite-specification:conformite-specification
git checkout conformite-specification
```

Un *bundle* plutôt qu'un `git push` : pousser 31 commits sur un dépôt partagé
est visible par tout le monde, et cette décision revient au propriétaire du
dépôt, pas à moi. Le bundle transporte exactement les mêmes commits, signés de
la même façon, et vous poussez quand vous le jugez bon.

### 2. Les dépendances

```bash
cd apps/api       && npm install
cd ../dashboard   && npm install
cd ../mobile      && npm install
```

### 3. La base

Il faut **PostgreSQL 17** et **PostGIS**. La version 16 ne suffit pas : elle
refuse de lire ce fichier, et son `pg_dump` produit silencieusement un fichier
de zéro octet.

```bash
createdb gtfc_recette
psql gtfc_recette -c "CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto;
  CREATE EXTENSION \"uuid-ossp\"; CREATE EXTENSION unaccent;
  CREATE EXTENSION pg_trgm; CREATE EXTENSION btree_gist;"
pg_restore -d gtfc_recette --no-owner --no-privileges base/gtfc.dump
```

Vérifiez l'empreinte avant : `shasum -a 256 base/gtfc.dump` doit correspondre
à `base/gtfc.dump.sha256`.

Puis contrôlez que tout est arrivé :

```bash
bash scripts/exercice-restauration.sh gtfc_recette
```

### 4. Les secrets

**Ils ne sont pas dans ce paquet, et c'est délibéré.** Le fichier `.env` est
ignoré par git et n'a pas à voyager dans une archive.

`code/variables-a-renseigner.txt` liste les 63 noms de variables, sans aucune
valeur. Copiez `.env.template` en `.env` et remplissez-le — pour un poste de
développement, les valeurs locales suffisent, sauf `WAVE_WEBHOOK_SECRET` que
les tests de paiement utilisent (n'importe quelle chaîne fait l'affaire en
local).

### 5. La mémoire de Claude

C'est le point qu'on oublie. Sans elle, une nouvelle session ne sait rien des
décisions prises ni de leurs motifs, et refera les mêmes erreurs.

```bash
mkdir -p ~/.claude/projects/-Users-momar-revenu-municipal/memory
cp memoire/*.md ~/.claude/projects/-Users-momar-revenu-municipal/memory/
```

Le nom du dossier encode le chemin du projet. Si vous travaillez ailleurs que
dans `~/revenu-municipal`, adaptez-le : les tirets remplacent les barres
obliques.

Cinq fichiers, dont un index `MEMORY.md` chargé à chaque session. Ils portent
notamment pourquoi il n'y a pas d'espèces, pourquoi les agents ne sont pas
géolocalisés, et qui valide une remise de dette.

---

## Vérifier que la reprise a réussi

```bash
# 1. L'installation depuis une base vide, puis les 94 tests
bash scripts/verifier-installation-neuve.sh gtfc_epreuve

# 1 bis. La recette fonctionnelle et les pages du tableau de bord
#        (exigent l'API sur 4000 et le tableau de bord sur 3000)
DB_NAME=gtfc_recette RECETTE_MDP='GtfcDemo2026!' bash scripts/recette.sh
cd apps/dashboard && npm test

# 2. Le tableau de bord compile
cd apps/dashboard && npx next build

# 3. L'application mobile compile en entier
cd apps/mobile && npx expo export --platform android --output-dir .export-verif

# 4. Les défauts que les tests ne voient pas
npx eslint@9 --config eslint.defauts.mjs \
  apps/api/src apps/api/scripts apps/api/tests \
  apps/dashboard/src apps/mobile/src apps/mobile/outils
```

Les quatre doivent passer. La quatrième doit être **silencieuse** : un
avertissement laissé traîner enterre celui qui viendra ensuite.

---

## Où en est le projet

### Fait et vérifié

- Base : 59 migrations, installation neuve éprouvée, sauvegarde restaurée,
  chaîne d'audit intacte après restauration.
- API : 94 tests. Les six chemins que la constitution du projet impose
  d'éprouver sont couverts — idempotence des paiements, imputation,
  rapprochement opérateur, synchronisation hors ligne, limites du code à usage
  unique, chaînage du journal d'audit.
- Référentiel de 100 rues, dont 85 extraites d'OpenStreetMap avec leur tracé.
- Rôles et séparation des pouvoirs : le chef de projet instruit une remise de
  dette, le maire la valide. Aucun des deux ne peut la conclure seul.

- Tableau de bord : les douze pages s'ouvrent dans un vrai navigateur et
  portent leurs données. Deux d'entre elles ne fonctionnaient pas.
- Recette fonctionnelle : 31 contrôles au vert, sur un poste sans serveur.

### Ce qui reste à coder

Rien de bloquant. Les surfaces principales sont éprouvées. Ce qui manque
encore de tests : les sept écrans mobiles au-delà des fonctions pures, les
contestations de bout en bout, et le portail redevable côté navigateur.

### Ce qui est bloqué ailleurs

| | Qui |
|---|---|
| 188 données provisoires : 100 noms de rue, 65 lignes de barème, 15 quartiers | la mairie, par délibération |
| Code court USSD | les opérateurs |
| Compte marchand Wave | la commune |
| Déclaration CDP | la commune |
| Serveur au Sénégal, domaine, certificat | la commune |

La liste des données provisoires se lit directement :
`SELECT * FROM app.v_donnees_a_remplacer;`

Aucun de ces blocages n'empêche de tester le **recensement** sur le terrain :
il ne dépend ni des tarifs, ni de Wave, ni de l'USSD.

---

## Trois pièges rencontrés, à ne pas retrouver

**`pg_dump` en version 16 sur un serveur 17** produit un fichier de zéro
octet. Il porte un nom de sauvegarde, il est daté, il est dans le bon dossier.
C'est le pire cas de tous : on croit avoir une sauvegarde. Le script de
sauvegarde efface maintenant les fichiers partiels.

**La chaîne du journal d'audit ne résistait pas aux écritures simultanées.**
Trois défauts empilés, dont le dernier était subtil : `nextval` est évalué
avant le déclencheur, donc l'identifiant suit l'ordre d'arrivée des
transactions et non celui du chaînage. Le journal porte maintenant son propre
rang. Sur le terrain, l'alarme anti-fraude se serait déclenchée tous les jours
sans raison — jusqu'à ce que plus personne ne la regarde.

**Les seeds muets.** Un seed qui ne trouve rien à faire se termine sans
erreur, exactement comme un seed qui a réussi. Les chantiers sont restés à
zéro pendant des semaines. Le contrôle d'installation vérifie désormais que
seize tables ne sont pas vides, et échoue sinon.

---

## Le vrai risque

Rien de ce qui précède. **Le recensement n'a jamais été fait par un agent réel
sur une vraie devanture.** Tout a été éprouvé contre 60 commerces de
démonstration aux positions inventées — c'est pourquoi 51 d'entre eux ne se
rattachent à aucune rue.

Une demi-journée de terrain sur une seule rue, avec un vrai téléphone,
apprendra plus que n'importe quel test écrit d'ici.

---

## Éprouver l'application sur un téléphone, dès maintenant

Le recensement ne dépend ni des tarifs, ni de Wave, ni de l'USSD : il se teste
avant que le serveur n'existe, contre l'API du poste, par le Wi-Fi.

Voir `apps/mobile/TESTER-SANS-SERVEUR.md`. Deux voies : Expo Go en cinq
minutes sans rien installer, ou un APK autonome qui demande un compte Expo
gratuit.
