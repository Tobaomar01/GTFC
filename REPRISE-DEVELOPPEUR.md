# Reprise du projet

Plateforme de collecte des taxes locales pour la commune de **Gueule
Tapée-Fass-Colobane**, à Dakar. Pilote en partenariat public-privé.

`master` n'a pas été touché. Tout le travail est sur `conformite-specification`
— **40 commits**.

---

## 1. Transférer

Le paquet `transfert/` contient ce qui n'est pas sur GitHub.

### Le code

```bash
git clone https://github.com/Tobaomar01/GTFC.git ~/revenu-municipal/code-existant
cd ~/revenu-municipal/code-existant
git bundle verify /chemin/vers/code/gtfc-conformite-specification.bundle
git fetch /chemin/vers/code/gtfc-conformite-specification.bundle \
    conformite-specification:conformite-specification
git checkout conformite-specification
```

Un *bundle* plutôt qu'un `git push` : pousser 40 commits sur un dépôt partagé
est visible par tout le monde, et cette décision revient à son propriétaire.
Le bundle porte exactement les mêmes commits ; vous poussez quand vous voulez.

### Les dépendances, la base

```bash
cd apps/api && npm install && cd ../dashboard && npm install && cd ../mobile && npm install
```

**PostgreSQL 17 et PostGIS.** La version 16 ne suffit pas : elle refuse de
lire ce fichier, et son `pg_dump` produit un fichier de zéro octet sans le
dire.

```bash
createdb gtfc_recette
psql gtfc_recette -c "CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto;
  CREATE EXTENSION \"uuid-ossp\"; CREATE EXTENSION unaccent;
  CREATE EXTENSION pg_trgm; CREATE EXTENSION btree_gist;"
pg_restore -d gtfc_recette --no-owner --no-privileges base/gtfc.dump
```

Vérifiez l'empreinte avant : `shasum -a 256 base/gtfc.dump`.

### Les secrets

**Absents du paquet, délibérément.** `code/variables-a-renseigner.txt` liste
les 63 noms, sans valeur. Copiez `.env.template` en `.env`.

### La mémoire de Claude

C'est ce qu'on oublie. Sans elle, une nouvelle session ignore les décisions
prises et leurs motifs.

```bash
mkdir -p ~/.claude/projects/-Users-momar-revenu-municipal/memory
cp memoire/*.md ~/.claude/projects/-Users-momar-revenu-municipal/memory/
```

Le nom du dossier encode le chemin du projet ; adaptez-le si vous travaillez
ailleurs (les tirets remplacent les barres obliques).

---

## 2. Vérifier que la reprise a réussi

Cinq commandes. Les cinq doivent passer.

```bash
# Installation depuis une base vide, puis les 122 tests
bash scripts/verifier-installation-neuve.sh gtfc_epreuve

# Le métier, contre l'API locale (API sur 4000, dashboard sur 3000)
DB_NAME=gtfc_recette RECETTE_MDP='GtfcDemo2026!' bash scripts/recette.sh

# La chaîne entière EN CONDITIONS DE PRODUCTION, passerelle SMS factice
bash scripts/repetition-generale.sh gtfc_recette

# Les douze tâches automatiques
cd apps/api && DB_NAME=gtfc_recette node src/scheduler.js --une-fois

# Les défauts qu'aucun test ne voit — la sortie doit être VIDE
npx eslint@9 --config eslint.defauts.mjs \
  apps/api/src apps/api/scripts apps/api/tests \
  apps/dashboard/src apps/mobile/src apps/mobile/outils
```

Plus, avec un navigateur : `cd apps/dashboard && npm test` (18 tests).

---

## 3. Ce qu'il faut savoir avant de lire le code

**Les défauts de ce projet ne sont pas dans le code, ils sont aux jointures.**
Une dizaine ont été trouvés en une journée. Aucun n'était visible à la
lecture ; tous l'ont été en exécutant quelque chose pour la première fois.

Trois formes reviennent, et elles reviendront :

**Deux modules corrects qui se rencontrent mal.** La passerelle SMS refusait
tout message contenant un montant ; les trois modèles en annonçaient un.
Chacun juste isolément. Ensemble : aucun SMS ne serait jamais parti — et c'est
le seul canal de recouvrement.

**Un chemin de repli qui masque le vrai chemin.** Sans passerelle raccordée et
hors mode production, le système emprunte des routes qui n'existeront pas le
jour venu. Le code à usage unique renvoyé en clair dans la réponse HTTP, le
canal de notification resté à l'état d'intention : invisibles jusqu'au
branchement de l'opérateur.

**Un commentaire qui décrit une protection absente.** « Ce mode refuse de
s'activer en production sans `SMS_SIMULER_EN_PROD` » — cette variable
n'existait nulle part ailleurs que dans cette phrase. Pire qu'un silence : il
rassure le relecteur. Je l'ai lu deux fois avant de vérifier.

### Les dix commits à lire en premier

Chaque message explique le défaut, pourquoi il était invisible, et ce qu'il
aurait coûté. C'est le plus court chemin vers l'état d'esprit du projet.

| | |
|---|---|
| `3dc6d10` | Le système se serait arrêté le 1er mars, d'un coup |
| `d52b6b5` | Aucun SMS ne serait jamais parti |
| `0d8d6cc` | Le code à usage unique partait dans la réponse HTTP |
| `4308d0f` | La répétition générale, et la troisième rupture du même chemin |
| `cf92bb7` | Trois routes échouaient à chaque appel, pour la même raison |
| `57cfe1c` | Deux pages du tableau de bord n'avaient jamais fonctionné |
| `c8dc053` | Le maire, le chef de projet, et une chaîne d'audit qui criait au loup |
| `049a43b` | Des seeds muets, et des tests vrais par vacuité |
| `c62361a` | L'adresse d'un passant n'a pas à rester |
| `d1e7379` | Éprouver l'installation neuve, et réparer ce qu'elle a trouvé |

---

## 4. Les décisions du commanditaire, et leurs motifs

Elles ne se déduisent pas du code. Les défaire serait une erreur.

**Zéro espèce, Wave uniquement.** « C'est dans la collecte que réside le
risque de vol par les agents. » Ni virement, ni chèque, ni compensation.

**Aucun suivi de position des agents.** Écarté explicitement. Les seules
positions enregistrées sont celles rattachées à une intervention.

**Liquidation annuelle, solde restant dû.** Le redevable paie à son rythme ;
le mensuel n'est qu'un repère indicatif, jamais un calendrier imposé.

**Deux organisations.** Côté exploitant, le `chef_projet` voit tout le
dispositif et INSTRUIT les décisions dérogatoires. Côté municipalité, le
`maire` les VALIDE — c'est sa seule écriture engageant la commune. Aucune des
deux parties ne peut effacer une dette à elle seule : remettre une dette
publique est un acte de la commune, et la constitution du projet interdit à
l'exploitant tout droit sur les échéances.

**Le dépôt d'une contestation ne suspend pas le recouvrement.** Sinon
contester deviendrait un moyen de ne pas payer.

---

## 5. Où en est le projet

### Éprouvé

122 tests API · 18 tests de navigateur · 12 contrôles de répétition générale ·
31 contrôles de recette · installation depuis une base vide · sauvegarde
restaurée, chaîne d'audit intacte après restauration · douze tâches
automatiques exécutées.

Les six chemins que la constitution impose d'éprouver sont couverts.

### Jamais ouvert — c'est là que sont les prochains défauts

- **Les sept écrans mobiles.** Jamais affichés. Seules les fonctions pures
  sont testées. **C'est le plus grand angle mort**, et Expo Go permet d'y voir
  en cinq minutes : voir `apps/mobile/TESTER-SANS-SERVEUR.md`.
- **Six familles d'appels** : `/zones`, `/quartiers`, `/categories`,
  `/quittances/:id/pdf`, `/impression/stickers`, `/campagnes/lien/:avisId`.
  Les planches de stickers sont ce que l'agent colle le premier jour.
- **MinIO en conditions réelles.**
- **Les huit scripts de déploiement.**
- **L'exercice de réversibilité** que la constitution exige. La restauration
  est faite ; sortir la commune du dispositif ne l'est pas.

### Bloqué ailleurs

| | Qui |
|---|---|
| 188 données provisoires : 100 rues, 65 lignes de barème, 15 quartiers | la mairie, par délibération |
| Code court USSD | les opérateurs |
| Compte marchand Wave | la commune |
| Déclaration CDP | la commune |
| Serveur au Sénégal, domaine, certificat | la commune |
| Compte Expo pour compiler l'APK | le développeur |

`SELECT * FROM app.v_donnees_a_remplacer;` donne la liste à porter en réunion.

Aucun de ces blocages n'empêche de tester le **recensement** sur le terrain :
il ne dépend ni des tarifs, ni de Wave, ni de l'USSD.

---

## 6. Ce que je recommanderais en premier

**Faire relire ces 40 commits.** J'ai modifié le schéma, les règles
d'habilitation, la passerelle SMS. Chaque décision est motivée dans son
message, la branche est séparée — mais une relecture humaine doit venir avant
le terrain, pas après.

Puis ouvrir l'application mobile sur un vrai téléphone. C'est gratuit,
immédiat, et c'est la seule chose qu'aucun test écrit d'ici ne remplace.
