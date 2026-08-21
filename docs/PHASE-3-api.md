# Phase 3 — API Node.js / Express

**Objectif** : l'API complète — authentification JWT à 4 rôles, endpoints REST,
génération des QR codes, envoi des photos vers MinIO, journal d'audit automatique,
webhook Wave, et le protocole de synchronisation hors-ligne dont dépendra l'app
Android de la phase 4.

---

## Ce que j'ai généré

### Application — `apps/api/`

```
apps/api/
├── package.json               15 dépendances, 0 vulnérabilité
├── src/
│   ├── server.js              Démarrage, arrêt propre, signal PM2
│   ├── scheduler.js           7 tâches planifiées (processus séparé)
│   ├── app.js                 Assemblage Express
│   ├── config/
│   │   ├── env.js             Chargement + validation stricte du .env
│   │   ├── database.js        Pool PostgreSQL + contexte de sécurité
│   │   └── logger.js          Journalisation, champs sensibles masqués
│   ├── middleware/
│   │   ├── auth.js            JWT, 4 rôles, hiérarchie des droits
│   │   ├── validation.js      Schémas zod réutilisables
│   │   ├── erreurs.js         Erreurs PostgreSQL → messages métier
│   │   └── limites.js         Limitation de débit par compte
│   ├── services/
│   │   ├── auth.service.js    Connexion, rotation des jetons, verrouillage
│   │   ├── commerce.service.js  Recensement, conflits de version
│   │   ├── qr.service.js      QR codes + sticker A6 en SVG
│   │   ├── stockage.service.js  MinIO, URL pré-signées, anti-doublon
│   │   ├── sync.service.js    Lots hors-ligne, idempotence, conflits
│   │   └── wave.service.js    Signature HMAC, webhook, lien de paiement
│   ├── routes/                10 fichiers, ~70 endpoints
│   └── utils/
└── scripts/
    └── creer-utilisateur.js   Création du premier compte, en ligne de commande
```

### Migrations ajoutées

| Fichier | Rôle |
|---|---|
| `0017_fonctions_authentification.sql` | 9 fonctions `SECURITY DEFINER` : le seul contournement autorisé du RLS |
| `0018_vue_audit_entite.sql` | Correction : `entite_id` manquait dans la vue du journal d'audit |

---

## Trois décisions qui structurent tout le reste

### 1. L'isolation multi-communes vit dans la base, pas dans le code

À chaque requête, après vérification du JWT, l'API pose le contexte :

```sql
SET LOCAL gtfc.commune_id     = '<commune de l'utilisateur>';
SET LOCAL gtfc.utilisateur_id = '<utilisateur>';
```

`SET LOCAL` disparaît à la fin de la transaction : une connexion rendue au pool
ne garde jamais l'identité de la requête précédente. **Un oubli de clause `WHERE`
dans un endpoint ne peut pas exposer les données d'une autre mairie** — PostgreSQL
filtre avant.

Corollaire volontaire : sans contexte, le rôle applicatif ne voit **rien**. Un
défaut de configuration se traduit par « aucune donnée », jamais par « toutes ».

C'est aussi pourquoi l'API refuse de démarrer si elle se connecte en
superutilisateur : cela désactiverait silencieusement toutes les politiques.

### 2. Le journal d'audit se remplit tout seul

Aucun `INSERT INTO audit.journal` dans le code applicatif. Ce sont les
déclencheurs de la phase 2 qui écrivent, en lisant `gtfc.utilisateur_id`. Une
correction faite à chaud depuis `psql` laisse donc exactement la même trace
qu'une action de l'application.

### 3. La synchronisation ne perd jamais rien

Trois garanties, vérifiées par les tests :

- **idempotence** : l'identifiant de lot est généré par le téléphone. Renvoyé
  après une coupure réseau, le lot n'est pas réappliqué — le résultat d'origine
  est renvoyé tel quel ;
- **tolérance** : chaque opération est traitée dans sa propre transaction. Une
  fiche invalide n'annule pas les 40 autres ; la réponse est un `207` détaillant
  le sort de chacune ;
- **aucun écrasement silencieux** : si la fiche a changé côté serveur, l'API
  renvoie un conflit avec les valeurs des deux côtés, qu'un superviseur tranche
  depuis le dashboard.

---

## Endpoints

| Domaine | Principaux endpoints |
|---|---|
| **Authentification** | `POST /auth/login` · `/refresh` · `/logout` · `GET /auth/moi` · `POST /auth/mot-de-passe` · `GET/DELETE /auth/sessions` |
| **Commerces** | `GET/POST /commerces` · `GET /commerces/carte` · `GET /commerces/proches` · `GET/PATCH/DELETE /commerces/:id` · `POST /commerces/:id/photos` · `GET/POST /commerces/:id/qr` · `GET /commerces/:id/sticker` · `POST /commerces/:id/visite` |
| **Territoire** | `GET/POST /communes` · `PATCH /communes/:id/parametres` · `GET /zones` · `GET /quartiers` · `POST /quartiers/:id/geometrie` · `POST /quartiers/recalculer` · `GET /marches` · `GET/PATCH /categories` |
| **Taxes** | `GET /taxes/types` · `GET/POST /taxes/baremes` · `POST /taxes/baremes/:id/cloturer` · `GET /taxes/simuler/:commerceId` · `GET/POST/PATCH` taxes d'un commerce · `GET/POST /taxes/exonerations` |
| **Fiscalité** | `GET/POST /periodes` · `POST /periodes/:id/generer` · `/emettre` · `/cloturer` · `POST /periodes/penalites` · `GET /avis` · `GET /avis/:id` · `POST /avis/:id/annuler` · `POST /avis/:id/lien-paiement` |
| **Paiements** | `GET/POST /paiements` · `POST /paiements/verser` · `POST /paiements/:id/annuler` |
| **Agents** | `GET/POST /agents` · `PATCH /agents/:id` · `POST /agents/:id/reinitialiser-mot-de-passe` · `/deverrouiller` · affectations · `GET /agents/:id/activite` · `GET /agents/positions/dernieres` |
| **Synchronisation** | `GET /sync/paquet` · `POST /sync/batch` · `GET /sync/lots` · `GET /sync/conflits` · `POST /sync/conflits/:id/resoudre` |
| **Statistiques** | `GET /stats/tableau-bord` · `/zones` · `/quartiers` · `/recouvrement` · `/taxes` · `/agents` · `/especes-non-versees` · `/coherence` · `/donnees-a-remplacer` |
| **Audit** | `GET /audit` · `GET /audit/entite/:entite/:id` · `GET /audit/connexions` |
| **Public (sans jeton)** | `GET /public/commune/:slug` · `GET /c/:jeton` · `GET /public/quittance/:jeton` |
| **Webhooks** | `POST /webhooks/wave` |

`GET /` renvoie l'inventaire complet des routes.

**Format de réponse uniforme** :

```json
{ "succes": true,  "donnees": …, "pagination": { "page": 1, "limite": 50, "total": 60 } }
{ "succes": false, "erreur": { "code": "CONFLIT_SYNCHRONISATION", "message": "…", "requete": "3f2a1b04" } }
```

Le champ `requete` est l'identifiant renvoyé aussi dans l'en-tête `X-Request-Id` :
un agent peut le lire à voix haute pour qu'on retrouve la ligne dans les journaux.

---

## Ce que vous devez faire

### Étape 1 — Déployer le code

```powershell
scp -r "C:\Users\DELL\Desktop\GTFC\apps" "C:\Users\DELL\Desktop\GTFC\db" gtfc@<serveur>:~/gtfc-platform/
```

```bash
ssh gtfc@<serveur>
cd ~/gtfc-platform
bash db/migrate.sh            # applique les migrations 0017 et 0018
cd apps/api && npm ci --omit=dev && cd ../..
```

> `npm ci` plutôt que `npm install` : il installe exactement les versions du
> `package-lock.json`, sans surprise entre votre poste et le serveur.

### Étape 2 — Compléter le `.env`

Les variables de la phase 1 suffisent. Vérifiez seulement :

```bash
grep -E '^(JWT_SECRET|DB_USER|DB_PASSWORD|MINIO_ACCESS_KEY|CORS_ORIGINS)=' .env
```

- `DB_USER` doit valoir **`gtfc_app`**, jamais `postgres` — l'API refusera de
  démarrer avec un superutilisateur ;
- `JWT_SECRET` : 48 octets minimum (`openssl rand -base64 48`) ;
- `CORS_ORIGINS` : les domaines du dashboard, séparés par des virgules.

### Étape 3 — Créer le premier compte

Aucun compte n'existe encore, et il faut un compte pour en créer un. D'où ce
script en ligne de commande :

```bash
cd apps/api
node scripts/creer-utilisateur.js --role super_admin \
     --nom Diop --prenom Amadou --telephone +221771234567

node scripts/creer-utilisateur.js --role admin_commune --commune GTFC \
     --nom Ndiaye --prenom Fatou --telephone +221771234568
```

Le mot de passe est généré et affiché **une seule fois** si vous n'en fournissez
pas. Notez-le immédiatement.

> Si vous avez chargé le jeu de démonstration de la phase 2, six comptes de test
> existent déjà (mot de passe `GtfcDemo2026!`). **Désactivez-les avant la mise en
> production** : `UPDATE app.utilisateur SET actif=false, archive_le=now() WHERE matricule LIKE 'DEMO-%';`

### Étape 4 — Démarrer sous PM2

```bash
cd ~/gtfc-platform
pm2 startOrRestart ecosystem.config.js --only gtfc-api,gtfc-scheduler
pm2 save                      # l'état est restauré après une coupure de courant
pm2 status
pm2 logs gtfc-api --lines 50
```

### Étape 5 — Vérifier

```bash
# Sonde simple
curl -s http://127.0.0.1:4000/healthz

# Sonde approfondie : teste réellement PostgreSQL et MinIO
curl -s http://127.0.0.1:4000/pret | jq

# À travers Nginx, en HTTPS
curl -s https://api.VOTRE-DOMAINE/healthz

# Connexion
curl -s -X POST https://api.VOTRE-DOMAINE/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"telephone":"+221771234568","mot_de_passe":"<le mot de passe>"}' | jq
```

Le `502 Bad Gateway` de la phase 1 sur `api.VOTRE-DOMAINE` doit maintenant avoir
disparu.

### Étape 6 — Configurer le webhook Wave (préparation phase 5)

Dans le tableau de bord Wave Business, déclarez :

```
https://api.VOTRE-DOMAINE/webhooks/wave
```

Vérifiez que l'URL répond :

```bash
curl -s https://api.VOTRE-DOMAINE/webhooks/wave | jq
# → { "endpoint": "actif", "signature_configuree": true, ... }
```

Tant que `WAVE_ACTIF=false`, aucun lien de paiement n'est créé — mais le webhook
est déjà opérationnel et refuse toute requête mal signée.

---

## Critères de validation de la phase 3

- [ ] `pm2 status` : `gtfc-api` et `gtfc-scheduler` en `online`
- [ ] `curl /pret` renvoie `"statut":"pret"` avec base **et** stockage `ok`
- [ ] `https://api.VOTRE-DOMAINE/` renvoie l'inventaire des routes
- [ ] La connexion renvoie un `jeton_acces` et un `jeton_rafraichissement`
- [ ] `GET /commerces` sans jeton → `401` ; avec jeton → la liste
- [ ] Une URL inconnue renvoie `404` (et non `401`)
- [ ] `GET /stats/tableau-bord` renvoie les chiffres de la commune
- [ ] `GET /audit` montre des entrées créées **sans aucun code applicatif**
- [ ] Un agent (`role=agent`) reçoit `403` sur `GET /audit`
- [ ] `sudo reboot` → PM2 relance l'API et le planificateur tout seuls

---

## Ce que j'ai vérifié de mon côté

J'ai monté un environnement complet — PostgreSQL 16 + PostGIS et MinIO en
conteneurs, les 18 migrations, les 6 jeux de données — puis exécuté **74 tests de
bout en bout** contre l'API réellement démarrée. Tous passent.

**Authentification et droits** — connexion, message d'erreur identique que le
compte existe ou non, rotation du jeton de rafraîchissement, détection de
réutilisation d'un jeton révoqué (toutes les sessions sont coupées), hiérarchie
des 4 rôles.

**Isolation multi-communes** — création d'une seconde commune, puis vérification
qu'un admin de GTFC ne voit qu'une commune là où le super-admin en voit deux,
qu'il reçoit `404` sur la fiche de l'autre, et qu'un en-tête `X-Commune-Id` forgé
reste sans effet.

**Métier** — recensement complet avec détection du quartier par GPS, génération du
code `GTFC-Z1-00061`, rattachement automatique des taxes, QR code. Calcul TODP
recontrôlé à la main : 6,4 m² → arrondi supérieur 7 m² × tarif de zone, avec le
détail JSON opposable au guichet. Rejet des coordonnées latitude/longitude
inversées.

**Photos** — téléversement vers MinIO, URL pré-signée qui sert bien le fichier,
accès **refusé** sans signature, détection d'une photo recyclée d'un commerce à
l'autre, rejet d'un script shell déguisé en `.jpg` (le contenu réel est inspecté,
pas le `Content-Type` déclaré).

**Synchronisation** — lot mixte valide/invalide → `207` avec 1 appliquée et
1 rejetée ; même lot renvoyé → reconnu, non réappliqué ; conflit de version
détecté et refusé.

**Webhook Wave** — sans signature `401` ; correctement signé `200` ; rejeu avec un
horodatage d'une heure `401`.

### Cinq défauts trouvés et corrigés au passage

Aucun n'était visible à la relecture :

1. **Les routeurs montés sur `/` authentifiaient toute l'API.** Une URL inconnue
   répondait `401` au lieu de `404`, et la route racine était inatteignable.
   L'authentification est désormais restreinte aux préfixes de chaque routeur.
2. **`entite_id` manquait dans la vue du journal d'audit** — impossible de
   répondre à « qui a touché à cette fiche ? ». Corrigé par la migration 0018.
3. **Le compteur de version renvoyé à la création était déjà périmé** :
   l'enregistrement de la visite incrémente le commerce juste après. La première
   modification envoyée par l'app échouait sur un faux conflit.
4. **Un `CASE` textuel non converti en type énuméré** faisait échouer toute
   création de commerce venue de la synchronisation hors-ligne.
5. **La génération du QR dépendait de MinIO.** Stockage indisponible = pas de QR
   du tout, alors que seul le jeton compte. L'image est maintenant optionnelle.

### Dépendances

`npm audit` : **0 vulnérabilité**. Deux substitutions en cours de route :

- `bcrypt` → **`bcryptjs`** : supprime la chaîne `node-pre-gyp`/`tar` (une
  vulnérabilité critique) *et* le besoin d'un compilateur C++ sur le Mini PC.
  Coût mesuré : 250 ms par hachage, sans conséquence pour quelques connexions
  par jour ;
- `multer` 1.x → **2.x**, et `node-cron` 3.x → **4.x** (l'ancienne version
  embarquait un `uuid` vulnérable).

---

## Tâches planifiées

`gtfc-scheduler` tourne en **une seule instance** — l'API, elle, est en mode
cluster. Si le planificateur y vivait, chaque worker enverrait sa propre facture
au même commerçant.

| Quand | Tâche |
|---|---|
| 25 du mois, 01h00 | Création des partitions mensuelles (audit, positions) |
| 25 du mois, 01h30 | Préparation de la période fiscale du mois suivant |
| Tous les jours 02h00 | Application des pénalités de retard |
| Tous les jours 02h30 | Recalcul des statuts fiscaux (couleurs de la carte) |
| Dimanche 03h00 | Purge des sessions expirées |
| Toutes les heures | Expiration des liens de paiement non honorés |
| Tous les jours 06h30 | Contrôle de cohérence, avant l'arrivée des agents |

> Les partitions sont créées **trois mois à l'avance**. Sans partition
> disponible, toute écriture d'audit ou de position échouerait — d'où aussi une
> création immédiate au démarrage, utile après un arrêt prolongé.

---

## En cas de problème

| Symptôme | Cause | Correctif |
|---|---|---|
| `CONFIGURATION INVALIDE` au démarrage | Variable manquante ou restée à `A_REMPLIR` | Le message liste précisément quoi corriger |
| `L'API est connectée en superutilisateur` | `DB_USER=postgres` | Mettre `gtfc_app` |
| Toutes les listes sont vides | Compte sans commune, ou contexte non posé | `SELECT role, commune_id FROM app.utilisateur WHERE telephone='…'` |
| `502` derrière Nginx | API arrêtée | `pm2 logs gtfc-api --err --lines 100` |
| Photos en erreur, reste fonctionnel | MinIO arrêté | `docker compose up -d minio` — l'API tourne en mode dégradé |
| `Aucun barème en vigueur` | Barème absent ou périmé | `GET /taxes/types` → colonne `bareme_en_vigueur` |
| `429` en synchronisation | Plafond atteint | Normal après 200 lots en 5 min ; aucune donnée n'est perdue |

---

## Ensuite

La **phase 4 — application Android** consomme exactement cette API :
`POST /auth/login`, `GET /sync/paquet` au démarrage, `POST /commerces` en ligne,
`POST /sync/batch` au retour du réseau.

Dites-moi quand les critères ci-dessus sont validés sur votre serveur.

Rappel qui vaudra jusqu'à la mise en production : les **barèmes du seed 0004 sont
inventés**. L'API calcule correctement — sur des tarifs qui ne sont pas ceux de la
commune. Les questions de [`QUESTIONS-PHASE-2.md`](QUESTIONS-PHASE-2.md) restent
ouvertes, et le tarif TODP au m² reste la donnée la plus importante à obtenir.
