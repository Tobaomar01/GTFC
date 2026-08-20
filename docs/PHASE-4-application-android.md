# Phase 4 — Application Android des agents

**Objectif** : l'application que les agents utilisent sur le terrain — login,
tableau de bord, formulaire multi-taxes, GPS, photos, scan QR, et surtout un
**mode hors-ligne complet** avec synchronisation automatique au retour du réseau.

---

## Ce que j'ai généré

```
apps/mobile/
├── app.json                    Configuration Expo — Android uniquement
├── eas.json                    Profils de build (APK de test, AAB pour Play)
├── package.json                26 dépendances
├── App.js / index.js
├── assets/                     Icônes provisoires (à remplacer, voir LISEZ-MOI)
│
├── src/
│   ├── bdd/
│   │   ├── schema.js           10 tables SQLite — la couche hors-ligne
│   │   ├── database.js         Ouverture, migrations, journal, diagnostic
│   │   ├── commerces.repo.js   Commerces, visites, encaissements
│   │   └── sync.repo.js        File d'envoi, photos, référentiels
│   ├── api/client.js           HTTP, rafraîchissement auto du jeton
│   ├── services/
│   │   ├── sync.service.js     Moteur de synchronisation
│   │   ├── localisation.js     GPS, qualité du signal, suggestion de quartier
│   │   └── photos.js           Capture, compression, envoi, purge
│   ├── contextes/AppContexte.js  Session, réseau, état de synchronisation
│   ├── composants/             ui.js (10 composants) + terrain.js (5)
│   ├── ecrans/                 Connexion, tableau de bord, recensement,
│   │                           commerces, fiche, scanner, encaissement, outils
│   ├── navigation.js
│   └── theme.js
│
└── outils/
    ├── verifier-schema.js      Rejoue le schéma SQLite sur un vrai moteur
    └── verifier-syntaxe.js     Syntaxe JSX + règles du projet
```

---

## Les décisions qui comptent

### 1. Tout passe par SQLite d'abord

Aucun écran n'appelle le réseau pour enregistrer. L'agent valide une fiche,
elle est en base locale, et une **opération est empilée dans une file d'envoi**
— les deux dans la même transaction. Les séparer permettrait à un commerce
d'exister sur le téléphone sans jamais remonter : le pire défaut possible pour
une application terrain.

Corollaire assumé : **la première connexion exige du réseau**. Vérifier un mot
de passe hors ligne supposerait de stocker de quoi le vérifier sur l'appareil,
c'est-à-dire de mettre l'annuaire des agents dans la poche de qui vole le
téléphone. Une fois connecté, l'agent le reste 30 jours et peut travailler des
journées entières sans couverture.

### 2. Rien n'est effacé avant confirmation du serveur

Une opération reste dans la file tant que le serveur n'a pas répondu qu'il l'a
appliquée. Une photo n'est supprimée du téléphone qu'après confirmation. La
déconnexion et la réinitialisation sont **refusées** s'il reste du travail non
synchronisé — avec un écran qui dit exactement ce qui serait perdu.

### 3. L'application ne calcule aucun montant

Elle recueille des mesures : surface de trottoir occupée, surface d'enseigne,
nombre de jours de marché. Le barème est appliqué par le serveur. Dupliquer les
règles fiscales dans l'app garantirait qu'un jour les deux calculs divergent —
et c'est le commerçant qui recevrait une quittance fausse.

Les montants s'affichent donc uniquement en ligne, via `/taxes/simuler`, avec le
détail du calcul (barème, tranche, arrondi) exploitable au guichet.

### 4. Le quartier est *suggéré*, jamais affirmé

Le serveur dispose des polygones et sait dire si un point est dans un quartier
(PostGIS). Le téléphone ne reçoit que le centre de chaque quartier. Il propose
donc le plus proche, en signalant quand deux quartiers sont à distance
comparable. Le rattachement définitif est fait par le serveur. Un commerce mal
rattaché changerait le barème TODP appliqué — ce n'est pas un détail.

### 5. Les doublons sont repérés avant la saisie

Dès la position relevée, l'écran affiche les commerces déjà recensés à moins de
50 m, avec leur distance. Corriger un doublon après coup coûte bien plus cher
que l'éviter : il faut retrouver les deux fiches, décider laquelle garder, et
récupérer le sticker déjà collé.

---

## Ce que vous devez faire

### Étape 1 — Installer les outils sur votre poste

```powershell
npm install -g eas-cli
cd C:\Users\DELL\Desktop\GTFC\apps\mobile
npm install
```

Sur le téléphone Android de test, installez **Expo Go** depuis le Play Store.

### Étape 2 — Aligner les versions natives

```powershell
npx expo install --fix
npx expo-doctor
```

> **À faire avant tout le reste.** J'ai écrit `package.json` avec les versions
> cohérentes de l'écosystème Expo SDK 53, mais c'est `expo install --fix` qui
> fait autorité : il aligne chaque module natif sur la version exacte attendue
> par le SDK installé. Un décalage se traduit par un écran blanc au lancement,
> sans message d'erreur exploitable.

### Étape 3 — Vérifier avant de lancer

```powershell
node outils/verifier-syntaxe.js    # syntaxe JSX + imports + règles projet
npm run test:schema                # rejoue le schéma SQLite sur un vrai moteur
```

### Étape 4 — Lancer en développement

L'application doit joindre l'API. Sur un téléphone physique, `localhost`
désigne le téléphone lui-même : utilisez l'**IP de votre poste sur le réseau
local**.

```powershell
ipconfig                            # relevez l'IPv4, ex. 192.168.1.20
```

Créez `apps/mobile/.env` :

```
EXPO_PUBLIC_API_URL=http://192.168.1.20:4000
```

Puis :

```powershell
npx expo start
```

Scannez le QR affiché avec Expo Go. Le téléphone et le poste doivent être sur
le même réseau Wi-Fi.

> L'API écoute sur `127.0.0.1` (phase 1). Pour un test depuis le téléphone,
> soit vous passez par Nginx en HTTPS (`https://api.VOTRE-DOMAINE`), soit vous
> ouvrez temporairement `API_HOST=0.0.0.0` dans le `.env` du serveur. **La
> seconde option est à réserver au réseau local** et à annuler ensuite.

### Étape 5 — Le parcours à tester

1. **Connexion** avec un compte agent (`+221700000011` / `GtfcDemo2026!` si le
   jeu de démonstration est chargé). Le changement de mot de passe est imposé.
2. Le **chargement initial** se déclenche seul : catégories, quartiers, zones,
   commerces.
3. **Activez le mode avion.** Le bandeau passe en orange « Hors ligne ».
4. **Recensez un commerce** : relevez la position, remplissez, cochez la TODP,
   saisissez une surface, enregistrez, prenez les photos.
5. Vérifiez dans **Outils** que les éléments sont bien « à envoyer ».
6. **Coupez le mode avion.** La synchronisation part seule au bout de quelques
   secondes.
7. Vérifiez sur le serveur : `GET /commerces?q=<nom saisi>`.

### Étape 6 — Générer l'APK pour les agents pilotes

```powershell
eas login
eas init                            # crée le projectId, à reporter dans app.json
```

Renseignez l'URL de production dans `eas.json` (profil `preview`), puis :

```powershell
npm run build:apk
```

EAS compile dans le nuage et fournit un lien de téléchargement. L'APK
s'installe **directement** sur le téléphone d'un agent, sans compte Google Play
— c'est ce qu'il faut pour les tests terrain de la phase 7.

---

## Critères de validation de la phase 4

- [ ] `npx expo-doctor` ne signale aucun problème
- [ ] `node outils/verifier-syntaxe.js` → 0 problème
- [ ] `npm run test:schema` → 28 succès
- [ ] L'application se lance dans Expo Go sans écran blanc
- [ ] Connexion réussie, changement de mot de passe imposé
- [ ] Le chargement initial ramène 21 catégories et 15 quartiers
- [ ] **En mode avion** : recensement complet possible, avec photos
- [ ] Le bandeau orange annonce le nombre d'éléments à envoyer
- [ ] Au retour du réseau, la synchronisation part **automatiquement**
- [ ] Le commerce apparaît côté serveur avec son code `GTFC-Z1-000xx`
- [ ] Le scan d'un QR ouvre la fiche, **y compris hors ligne**
- [ ] La déconnexion est refusée s'il reste du travail non synchronisé

---

## Ce que j'ai vérifié — et ce que je n'ai pas pu vérifier

**Ce que j'ai testé pour de vrai.**

Je ne peux pas lancer un émulateur Android ici, mais j'ai testé les deux choses
qui cassent réellement une application terrain.

*Le schéma SQLite* — rejoué sur un moteur SQLite réel (sql.js), avec un jeu de
données représentatif : **28 contrôles, tous verts**. Les 10 tables, les index,
les contraintes, et surtout les requêtes exactes des dépôts — le rectangle de
recherche des commerces proches, la jointure qui retient les photos tant que
leur commerce n'est pas remonté, la purge du journal, les suppressions en
cascade, l'unicité de la référence de paiement qui empêche un double
encaissement.

*Le protocole de synchronisation* — un simulateur rejoue les payloads exacts de
l'application contre l'API réellement démarrée (PostgreSQL + PostGIS + MinIO en
conteneurs) : **28 contrôles, tous verts**. Le scénario est celui d'une journée
entièrement hors ligne : recensement, visite, encaissement, position ; puis
synchronisation, rejeu du lot après coupure, conflit de version, rotation du
jeton, delta.

**Ce que je n'ai pas pu vérifier**, et qu'il faudra regarder à l'étape 5 :
le rendu visuel sur un vrai écran, le comportement réel du GPS et de l'appareil
photo, la fluidité sur un téléphone d'entrée de gamme, et le déclenchement de la
synchronisation automatique au retour du réseau — NetInfo se comporte
différemment selon les constructeurs Android.

### Quatre défauts trouvés et corrigés

1. **Des backticks dans un commentaire SQL** terminaient prématurément le
   littéral JavaScript du schéma. L'application n'aurait pas démarré du tout —
   trouvé par `verifier-syntaxe.js`.
2. **Un encaissement fait hors ligne sur un commerce lui-même créé hors ligne**
   partait sans identifiant de commerce, et était rejeté par le serveur. Le
   moteur résout désormais la dépendance au moment de l'envoi, avec une seconde
   passe une fois la fiche remontée.
3. **Les commerces créés hors ligne n'obtenaient aucun QR code** — donc aucun
   sticker imprimable. Or c'est le cas majoritaire pendant le recensement.
   Corrigé côté API : le QR est généré dans la même transaction que la fiche.
4. **La valeur par défaut de `modifie_localement` était 0** : une ligne insérée
   par un chemin de code oubliant de la marquer n'aurait jamais été
   synchronisée. Les valeurs par défaut sont maintenant « pessimistes ».

---

## Points d'attention pour le terrain

| Sujet | Ce qui a été prévu |
|---|---|
| **Batterie** | La géolocalisation en arrière-plan est bloquée dans `app.json`. L'app ne suit l'agent que pendant sa tournée, application ouverte. |
| **Données mobiles** | Photos réduites à 1600 px / qualité 0,7 → environ 300 Ko au lieu de 6 Mo. Synchronisation en delta : seuls les commerces modifiés reviennent. |
| **Stockage** | Les photos confirmées sont effacées du téléphone après chaque synchronisation. L'écran Outils affiche l'espace occupé. |
| **Vol du téléphone** | Jetons dans le stockage sécurisé Android (`expo-secure-store`), `allowBackup=false` : la base fiscale ne part pas dans la sauvegarde Google. |
| **Écran au soleil** | Contrastes élevés, aucun texte sous 14 px, cibles tactiles de 48 px. |
| **Coupure en pleine synchro** | Les opérations « envoyées sans réponse » sont remises en file au démarrage suivant. Le serveur étant idempotent, un doublon est sans effet. |

---

## Ensuite

La **phase 5 — Paiement Wave et QR** finalise ce qui est déjà en place :
génération des liens de paiement, quittances PDF avec QR intégré, planificateur
mensuel, et planche de stickers A6 imprimables. Le webhook, lui, fonctionne
déjà depuis la phase 3.

Elle demandera vos **identifiants Wave Business** (clé sandbox pour commencer).

Et le rappel qui vaut jusqu'à la mise en production : les barèmes du seed sont
inventés. L'application recueille correctement les mesures, l'API calcule
correctement — sur des tarifs qui ne sont pas ceux de la commune.
