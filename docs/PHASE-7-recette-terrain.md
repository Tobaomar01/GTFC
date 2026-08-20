# Phase 7 — Tests terrain et déploiement

**Objectif** : passer d'une plateforme qui marche en laboratoire à une
plateforme qui marche entre les mains de trois agents, dans une rue de Dakar.

Cette phase est à **95 % vos actions**. Il reste très peu de code à écrire —
ce document est une checklist, pas une documentation technique.

---

## Avant la journée de test

### 1. L'APK

```bash
cd apps/mobile
npm install -g eas-cli
eas login
eas init                    # une seule fois — reporte le projectId dans app.json
```

Renseignez l'URL de production dans `eas.json`, profil `preview` :

```json
"env": { "EXPO_PUBLIC_API_URL": "https://api.VOTRE-DOMAINE" }
```

```bash
npm run build:apk           # EAS compile dans le nuage, ~15 min
```

Vous recevez un lien. L'APK s'installe **directement** sur les téléphones —
pas besoin de Google Play à ce stade.

> **Avant de compiler** : remplacez les icônes. Les vertes actuelles sont des
> aplats provisoires ([assets/LISEZ-MOI.md](../apps/mobile/assets/LISEZ-MOI.md)).
> Google Play refuse un aplat uni — bloquant pour le dépôt, pas pour les tests.

### 2. Les téléphones

Pour chacun des trois :

- [ ] Android 8 minimum, 3 Go de RAM
- [ ] Autoriser l'installation depuis une source inconnue (le temps du test)
- [ ] Installer l'APK
- [ ] Ouvrir l'application **une fois avec du réseau** : connexion, changement
      de mot de passe, chargement initial des données
- [ ] Vérifier que le nom de la commune s'affiche
- [ ] Batterie chargée, batterie de secours prévue

### 3. Les comptes

- [ ] Un compte par agent, **jamais de compte partagé**
- [ ] Un compte superviseur pour vous
- [ ] Les mots de passe provisoires notés, à remettre en main propre
- [ ] Affectation de chaque agent à sa zone

### 4. La zone de test

Choisissez **un seul quartier**, avec une trentaine de commerces variés :
une boutique, un restaurant avec terrasse (pour la TODP), un tailleur, un
commerce fermé si possible. Prévenez le chef de quartier.

### 5. La veille

- [ ] `bash scripts/recette.sh` → tout au vert
- [ ] `bash scripts/backup-postgres.sh --verify` → la restauration fonctionne
- [ ] Les barèmes sont-ils les vrais ? Si non, **prévenez les agents que les
      montants affichés sont faux** — et n'émettez aucun avis réel
- [ ] Imprimer le [mémo de l'agent](GUIDE-AGENT.md), un par personne

---

## La journée de test — déroulé

### Matin : 1 h de formation

Faites-la **dehors, devant un vrai commerce**, pas en salle.

1. Montrez le parcours complet sur un commerce, à voix haute
2. Chaque agent en fait un, vous regardez sans intervenir
3. Puis les cas qui posent problème — la moitié du mémo verso :
   commerce fermé, GPS faible, refus, contestation du montant

### Matinée : chacun sa rue

Objectif réaliste pour une première fois : **10 à 15 commerces par agent**,
pas 25. On vise la qualité de la saisie, pas le volume.

Restez joignable. Notez chaque question posée — c'est le vrai résultat de la
journée.

### Milieu de matinée : le test hors ligne

**Faites-le explicitement, ne l'improvisez pas.**

1. Tous les agents activent le **mode avion**
2. Chacun recense un commerce complet, photos comprises
3. Vérifier : le bandeau orange affiche le nombre d'éléments en attente
4. Désactiver le mode avion
5. Vérifier : la synchronisation part **toute seule** en quelques secondes
6. Sur le tableau de bord : les commerces apparaissent

C'est le point le plus important de la journée. Si ça marche ici, ça marchera
partout.

### Fin de matinée : retour à la mairie

- [ ] Chaque agent synchronise et montre « Tout est synchronisé »
- [ ] Espèces éventuellement encaissées : versées en caisse, comptées ensemble
- [ ] Sur le tableau de bord : les commerces sont sur la carte, aux bons endroits

### Après-midi : le débriefing

**La partie la plus utile de la journée.** Une heure, tous ensemble.

Trois questions, dans cet ordre :

1. **Qu'est-ce qui vous a ralenti ?**
2. **Qu'est-ce que vous n'avez pas compris ?**
3. **Qu'est-ce qui manque ?**

Écrivez tout. Ne défendez pas l'application — vous n'êtes pas là pour la
justifier, mais pour découvrir ce qui cloche.

---

## Ce qu'on vérifie — checklist

### Sur le terrain

- [ ] La position se relève sous 30 m en rue ouverte
- [ ] La liste des commerces proches s'affiche et évite un doublon
- [ ] Le quartier est proposé automatiquement, et il est **juste**
- [ ] Les photos partent, la qualité suffit à identifier la devanture
- [ ] La mesure TODP est saisissable rapidement
- [ ] Le scan d'un QR ouvre la fiche, **y compris hors ligne**
- [ ] L'écran reste lisible **en plein soleil**
- [ ] La batterie tient une matinée complète

### Sur le tableau de bord

- [ ] Les commerces recensés apparaissent sur la carte, au bon endroit
- [ ] Les couleurs correspondent à la situation réelle
- [ ] Les statistiques par zone et par agent sont cohérentes
- [ ] Le journal d'audit contient bien chaque création
- [ ] L'export Excel s'ouvre et les colonnes sont exploitables

### Ce qui ne doit **jamais** arriver

- [ ] Une saisie perdue
- [ ] Un doublon créé sans avertissement
- [ ] Un montant affiché différent du calcul de la mairie
- [ ] Une photo envoyée sans son commerce
- [ ] Un agent bloqué sans pouvoir continuer

---

## Grille de relevé — à imprimer

| Commerce | Agent | Heure | Ce qui a bloqué | Gravité |
|---|---|---|---|---|
| | | | | bloquant / gênant / détail |
| | | | | |
| | | | | |

**Bloquant** = l'agent n'a pas pu enregistrer le commerce.
**Gênant** = il y est arrivé, mais en perdant du temps ou en devinant.
**Détail** = ça marche, c'est juste perfectible.

Traitez les bloquants avant la deuxième journée. Les gênants avant le
déploiement complet. Les détails, plus tard.

---

## Après les tests

### Wave en production

- [ ] Le compte Wave Business est validé
- [ ] **Confirmer auprès de Wave le format exact de la signature du webhook**
      (nom de l'en-tête et composition du message signé)
- [ ] Tester un paiement complet en sandbox, de bout en bout
- [ ] Basculer : `WAVE_API_KEY`, `WAVE_ACTIF=true`, `WAVE_SIMULER=false`
- [ ] Déclarer l'URL du webhook dans le tableau de bord Wave
- [ ] `pm2 restart gtfc-api gtfc-scheduler`
- [ ] Faire un **vrai paiement de 100 F** et vérifier la quittance

### Les stickers

- [ ] Acheter du papier autocollant A4
- [ ] **Imprimer une planche sur papier ordinaire d'abord** pour vérifier
      l'alignement de l'imprimante
- [ ] Imprimer, découper le long des pointillés
- [ ] Les agents les posent lors de leur passage suivant
- [ ] Vérifier qu'un sticker posé se scanne bien avec l'appareil photo natif

### Google Play

- [ ] Compte développeur (25 USD, paiement unique)
- [ ] Icônes définitives en place
- [ ] `npm run build:production` → un fichier `.aab`
- [ ] Fiche Play : description, captures d'écran, politique de confidentialité
- [ ] Déposer sur la **piste interne** d'abord — diffusion aux testeurs
      déclarés, sans validation Google
- [ ] Après une semaine sans incident, passer en production

> **Sur la politique de confidentialité** : Google l'exige et vérifie sa
> cohérence avec les permissions demandées. Dites-y ce que fait vraiment
> l'application — collecte de position pendant les tournées, photos de
> devantures, aucune donnée revendue, hébergement sur le serveur de la commune.
> C'est vrai, et c'est plus simple à écrire qu'un texte évasif.

### Le déploiement complet

- [ ] Les barèmes officiels sont en place, `v_donnees_a_remplacer` renvoie 0
- [ ] Les vrais noms de quartiers remplacent les provisoires
- [ ] Les polygones de quartiers sont chargés, puis
      `SELECT app.recalculer_quartiers(...)`
- [ ] Le registre existant de la mairie est importé, s'il existe
- [ ] Tous les agents sont formés et équipés
- [ ] Le premier cycle mensuel réel est lancé — et surveillé de près

---

## Le calendrier réaliste

| Semaine | Quoi |
|---|---|
| 1 | APK, téléphones, comptes, zone de test |
| 2 | Journée de test · corrections des bloquants · deuxième journée |
| 3 | Wave en production · stickers · dépôt Google Play (piste interne) |
| 4 | Déploiement complet · premier cycle mensuel réel |

Comptez large. Un fournisseur en retard, un agent malade, une coupure de
courant : c'est la règle, pas l'exception.

---

## Le seul point non négociable

**Aucun avis d'imposition ne doit partir à un commerçant tant que
`SELECT * FROM app.v_donnees_a_remplacer` renvoie des lignes.**

La plateforme calcule juste. Sur des tarifs inventés. Une quittance fausse
remise à un commerçant engage la commune, et ce genre d'erreur se sait vite
dans un quartier.
