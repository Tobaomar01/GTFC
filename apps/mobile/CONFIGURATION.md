# Configuration de l'application — pourquoi ces choix

`app.json` doit rester **strictement conforme au schéma Expo** : toute clé
supplémentaire, même un commentaire, fait échouer `expo-doctor` et le dépôt
EAS Build. Les explications vivent donc ici.

---

## Android uniquement

Aucune section `ios`. Le cahier des charges prévoit des téléphones Android
pour les agents ; ajouter iOS coûterait un compte développeur Apple à 99 USD
par an, pour personne.

## Les permissions demandées

| Permission | Pourquoi |
|---|---|
| `ACCESS_FINE_LOCATION` | Géolocaliser les commerces et attester des passages |
| `CAMERA` | Photos de devanture, de trottoir (TODP), scan des QR codes |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Synchronisation et détection du retour du réseau |
| `VIBRATE` | Retour tactile à la confirmation d'un scan |

## Les permissions explicitement **bloquées**

```json
"blockedPermissions": ["ACCESS_BACKGROUND_LOCATION", "RECORD_AUDIO", "READ_CONTACTS"]
```

La géolocalisation **en arrière-plan** est bloquée délibérément. L'application
ne suit les agents que pendant leur tournée, application ouverte. Deux raisons :

1. **proportionnalité** — suivre un agent en permanence, y compris chez lui,
   n'est pas nécessaire au recouvrement des taxes ;
2. **Google Play refuse** couramment les applications qui demandent la
   localisation en arrière-plan sans justification impérieuse. La bloquer
   évite un rejet au dépôt.

`RECORD_AUDIO` et `READ_CONTACTS` ne servent à rien ici : les demander
alarmerait les agents pour rien.

## `allowBackup: false`

La base SQLite locale contient des données fiscales nominatives — enseignes,
noms de gérants, numéros de téléphone, montants dus. Elle ne doit pas partir
dans la sauvegarde Google du téléphone, hors du contrôle de la commune.

## `updates.fallbackToCacheTimeout: 0`

L'application démarre **immédiatement** avec la version en cache, sans attendre
le réseau. Indispensable pour un agent qui ouvre l'application hors couverture :
avec une valeur non nulle, il regarderait l'écran de démarrage pendant plusieurs
secondes avant de pouvoir travailler.

## `extra.apiUrl`

URL de l'API utilisée par l'APK compilé. **À remplacer par
`https://api.VOTRE-DOMAINE` avant de générer un APK de production.**

En développement, `EXPO_PUBLIC_API_URL` (fichier `.env`) prend le dessus.
Attention : sur un téléphone physique, `localhost` désigne le **téléphone**,
pas votre poste — utilisez l'adresse IP du poste sur le réseau local.

## `extra.eas.projectId`

Renseigné automatiquement par `eas init`, à lancer une seule fois avant le
premier build.

---

## Après toute modification de `app.json`

```bash
npx expo-doctor        # doit passer sans erreur de schéma
npx expo install --fix # aligne les modules natifs sur le SDK installé
```

## À propos de `npm audit`

`npm audit` signale une vingtaine de vulnérabilités sur ce projet, y compris
avec `--omit=dev`. Elles portent toutes sur la **chaîne de compilation**
(`metro`, `@expo/cli`, `postcss`…), que npm classe en dépendances de
production parce qu'elles sont tirées par le paquet `expo` lui-même.

Ces paquets ne sont **pas embarqués dans l'APK** : ils servent à le fabriquer.
`npm audit fix --force` casserait le SDK sans rien améliorer pour l'agent.

Ce qu'il faut surveiller, en revanche : les versions du SDK Expo. Une montée
de version majeure, une à deux fois par an, apporte les correctifs de sécurité
de toute la chaîne.
