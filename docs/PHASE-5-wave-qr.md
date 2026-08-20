# Phase 5 — Paiement Wave, quittances et stickers QR

**Objectif** : la chaîne de recouvrement complète — lien de paiement Wave
regroupant toutes les taxes, traitement du webhook, quittance PDF avec QR de
vérification, planches de stickers imprimables, et facturation mensuelle
automatique.

**Vous n'avez pas encore de compte Wave Business.** La phase est donc livrée
avec un **simulateur** : tout fonctionne de bout en bout, seul l'appel réseau à
Wave est remplacé. Le jour où la clé sandbox arrive, deux lignes du `.env`
suffisent à basculer.

---

## Ce que j'ai généré

| Fichier | Rôle |
|---|---|
| `apps/api/src/services/pdf.service.js` | Quittance A5 et planches A4 de 4 stickers A6 |
| `apps/api/src/services/notification.service.js` | File de messages, canaux enfichables |
| `apps/api/src/routes/documents.routes.js` | Quittances, impression, campagnes, notifications |
| `apps/api/scripts/simuler-wave.js` | **Le simulateur** — joue le rôle de Wave |
| `apps/api/src/services/wave.service.js` | Étendu : mode simulation, campagne, relances |
| `apps/api/src/scheduler.js` | Étendu : 11 tâches, dont la facturation mensuelle |
| `docs/exemples/` | Une quittance, une planche de stickers, un sticker A6 |

Nouvelle dépendance : **pdfkit** (JavaScript pur, aucune compilation native).
`npm audit` : 0 vulnérabilité.

---

## Le simulateur — votre outil de travail d'ici l'ouverture du compte Wave

Sans `WAVE_API_KEY`, la plateforme fabrique elle-même les sessions de paiement,
avec un identifiant reconnaissable (`sim_…`). Le simulateur signe et envoie au
webhook **les mêmes événements que Wave**, avec la même signature HMAC.

Tout le reste est identique au mode réel : même table, même vérification de
signature, même rapprochement, même quittance, même carte.

```bash
cd apps/api

node scripts/simuler-wave.js liste
#   38 lien(s) de paiement en attente
#   sim_42168b20a5fe876485670867
#       GTFC-Z3-00014 — Boutique Ndiaye
#       15 000 FCFA · avis GTFC-2026-08-000058 · +221701000054

node scripts/simuler-wave.js payer sim_42168b20a5fe876485670867
node scripts/simuler-wave.js payer sim_4216…  8000     # paiement partiel
node scripts/simuler-wave.js echouer sim_…
node scripts/simuler-wave.js expirer sim_…

# Jeu de données réaliste avant une démonstration à la mairie :
# 60 % de payeurs, dont un tiers en paiement partiel
node scripts/simuler-wave.js tout-payer --commune GTFC --taux 0.6
```

La carte du dashboard affichera alors du vert, de l'orange et du rouge, et les
statistiques de recouvrement seront crédibles.

### Le jour où vous recevez la clé sandbox

```diff
- WAVE_API_KEY=
- WAVE_ACTIF=false
+ WAVE_API_KEY=wave_sn_sandbox_XXXXXXXX
+ WAVE_ACTIF=true
+ WAVE_SIMULER=false
```

`pm2 restart gtfc-api gtfc-scheduler`. Aucun code à modifier.

> **Un point à confirmer auprès de Wave** avant la production : le nom exact de
> l'en-tête de signature et son format. J'ai implémenté le schéma standard
> (`Wave-Signature: t=<timestamp>,v1=<hmac>` sur `<timestamp>.<corps brut>`).
> Si Wave utilise une autre convention, seul le découpage de l'en-tête est à
> ajuster, dans `verifierSignature()`.

---

## Les décisions qui comptent

### Le webhook ne fabrique pas de PDF

Il crée la **ligne** de quittance, pas le document. Générer un PDF exige MinIO ;
un stockage momentanément indisponible ferait échouer l'enregistrement d'un
paiement que Wave a déjà encaissé — le pire scénario possible. Le planificateur
produit les PDF manquants toutes les 10 minutes, et l'endpoint de
téléchargement les génère à la volée si un agent en a besoin tout de suite.

### Aucun opérateur SMS n'est raccordé — et c'est assumé

Le cahier des charges n'en mentionne aucun et aucun compte n'existe. Plutôt
qu'inventer une intégration à refaire, les messages sont **mis en file** avec
des canaux enfichables. Par défaut, ils attendent d'être transmis par les
agents :

```
GET /notifications/a-transmettre?zone_id=…
```

Le superviseur imprime la liste par zone, les agents la distribuent pendant leur
tournée, puis `POST /notifications/remis`. Brancher Orange SMS API plus tard ne
demandera que d'écrire une fonction dans `CANAUX`.

Les messages sont composés **sans accent** et sous 160 caractères : les
passerelles GSM qui ne gèrent pas l'UTF-8 basculent sinon en encodage 16 bits,
divisant par deux le nombre de caractères utiles et doublant la facture.

### Les stickers s'impriment sur du papier ordinaire

La question posée était : comment une mairie imprime-t-elle 5 443 stickers ?
Réponse : sur du papier autocollant A4, avec l'imprimante du service. D'où des
planches **A4 de 4 stickers A6**, avec traits de découpe pointillés et numéro de
planche. Chaque planche est un PDF distinct — si le bac à papier se vide, on ne
perd pas 200 pages.

### La quittance est vérifiable par n'importe qui

Le QR imprimé encode une URL publique. Un commerçant, un contrôleur, ou un agent
d'une autre commune peut s'assurer que la quittance a bien été émise et n'a pas
été fabriquée. Le détail des taxes est reproduit ligne par ligne, avec la base
de calcul — c'est ce qui permet de justifier un montant contesté au guichet.

---

## Ce que vous devez faire

### Étape 1 — Déployer

```powershell
scp -r apps db docs .env.template gtfc@<serveur>:~/gtfc-platform/
```

```bash
cd ~/gtfc-platform/apps/api && npm ci --omit=dev && cd ../..
```

### Étape 2 — Compléter le `.env`

Une seule variable est **obligatoire** dès maintenant :

```bash
openssl rand -base64 32     # -> WAVE_WEBHOOK_SECRET
```

Même en simulation, le secret protège le webhook : sans lui, n'importe qui
pourrait déclarer un paiement. Laissez `WAVE_API_KEY` vide.

```bash
pm2 restart gtfc-api gtfc-scheduler
pm2 logs gtfc-scheduler --lines 20
# Attendu : "Wave en SIMULATION : les liens sont fabriqués localement"
```

### Étape 3 — Dérouler un cycle complet

```bash
# 1. Période et avis (ou attendez le 1er du mois : c'est automatique)
curl -X POST https://api.VOTRE-DOMAINE/periodes \
  -H "Authorization: Bearer $JETON" -H 'Content-Type: application/json' \
  -d '{"annee":2026,"mois":9}'

curl -X POST https://api.VOTRE-DOMAINE/periodes/<id>/generer -H "Authorization: Bearer $JETON"
curl -X POST https://api.VOTRE-DOMAINE/periodes/<id>/emettre -H "Authorization: Bearer $JETON"

# 2. Campagne : liens de paiement + notifications
curl -X POST https://api.VOTRE-DOMAINE/campagnes/<id>/lancer -H "Authorization: Bearer $JETON"

# 3. Simuler des paiements
cd apps/api && node scripts/simuler-wave.js tout-payer --taux 0.6

# 4. Vérifier
curl -s https://api.VOTRE-DOMAINE/stats/recouvrement -H "Authorization: Bearer $JETON" | jq
```

### Étape 4 — Imprimer les stickers

```bash
# Une planche A4 (4 stickers), directement imprimable
curl -s "https://api.VOTRE-DOMAINE/impression/stickers/planche?numero=1&sans_sticker=true" \
  -H "Authorization: Bearer $JETON" -o planche-1.pdf
```

Testez d'abord sur du papier ordinaire pour vérifier l'alignement de votre
imprimante, **avant** d'engager le papier autocollant.

### Étape 5 — Les messages à transmettre

```bash
curl -s "https://api.VOTRE-DOMAINE/notifications/a-transmettre" \
  -H "Authorization: Bearer $JETON" | jq '.donnees.messages[] | {commerce_code, contenu, checkout_url}'
```

---

## Critères de validation de la phase 5

- [ ] `pm2 logs gtfc-scheduler` annonce le mode SIMULATION
- [ ] `POST /campagnes/:id/lancer` crée des liens et des notifications
- [ ] Relancer la campagne ne crée **aucun doublon**
- [ ] `node scripts/simuler-wave.js liste` affiche les liens en attente
- [ ] `payer <session>` → « Webhook accepté », montant imputé
- [ ] Rejouer le même paiement → « déjà payée », pas de double encaissement
- [ ] `GET /quittances/:id/pdf` renvoie un PDF A5 lisible, avec QR
- [ ] `GET /impression/stickers/planche?numero=1` renvoie une planche A4
- [ ] `GET /commerces/carte` montre vert, orange et rouge
- [ ] `GET /stats/recouvrement` affiche un taux cohérent

---

## Ce que j'ai vérifié

**38 tests de bout en bout, tous verts**, contre l'API réellement démarrée avec
PostgreSQL + PostGIS + MinIO en conteneurs, sur une base rechargée à neuf.

Le cycle complet : période → avis → émission → campagne → liens → notifications
→ webhook signé → encaissement → quittance PDF → carte → statistiques. Plus les
cas limites : rejeu du webhook, échec de paiement, expiration, relances,
idempotence de la campagne.

Contrôles sur les documents produits :

- quittance : **A5 confirmé** (419,53 × 595,28 pt), 8,8 Ko, QR embarqué, accents
  français corrects ;
- planche de stickers : **A4 confirmé** (595,28 × 841,89 pt), 50 Ko pour 4 stickers ;
- sticker A6 seul : 105 × 148 mm, code `GTFC-Z1-00001` et tracé QR présents.

**Trois exemplaires sont dans [`docs/exemples/`](exemples/)** — ouvrez-les, c'est
ce que verront le commerçant et la mairie.

Non-régression : les 53 tests de la phase 3, les 14 tests photos et les 28 tests
du protocole mobile passent toujours.

### Trois défauts trouvés et corrigés

1. **Le webhook Wave échouait sur un typage ambigu.** Le paramètre `$2` servait
   à la fois d'énuméré et de texte dans la même requête ; PostgreSQL refusait
   avec « inconsistent types deduced for parameter $2 ». Jamais atteint en
   phase 3, où le test portait sur une session inexistante : la fonction sortait
   avant. **Aucun paiement Wave n'aurait été rapproché.**
2. **`scripts/creer-utilisateur.js` était bloqué par le RLS.** Il interrogeait la
   base sans poser de contexte de sécurité, donc voyait zéro ligne et ne pouvait
   rien insérer. C'est le script qui crée le **tout premier compte** de la
   plateforme : il aurait échoué au premier déploiement réel.
3. Même défaut sur `simuler-wave.js`, découvert en premier.

---

## Le planificateur, désormais complet

| Quand | Tâche |
|---|---|
| **1er du mois, 03h30** | **Facturation mensuelle** : période, avis, émission, liens, notifications |
| Lundi 08h00 | Relance des impayés (une par avis et par semaine) |
| Toutes les 15 min | File de notifications |
| Toutes les 10 min | Quittances PDF manquantes |
| Toutes les heures | Expiration des liens non honorés |
| 25 du mois | Partitions + période suivante |
| Tous les jours | Pénalités, statuts fiscaux, contrôle de cohérence |
| Dimanche | Purge des sessions |

La facturation mensuelle est **idempotente** : si le serveur tombe au milieu —
coupure de courant à Dakar — relancer la tâche reprend là où elle en était sans
rien facturer deux fois.

---

## Ce qu'il reste à obtenir

| Élément | Bloquant pour | Où le renseigner |
|---|---|---|
| Compte Wave Business + clé sandbox | Paiements réels | `WAVE_API_KEY` |
| Format exact de la signature webhook | Production | à confirmer auprès de Wave |
| Opérateur SMS *(facultatif)* | Envoi automatique | `SMS_FOURNISSEUR` |
| **Barèmes officiels** | **Toute émission réelle d'avis** | `db/seeds/0004_baremes.sql` |

Le dernier point reste le plus important : la chaîne calcule et facture
correctement — sur des tarifs inventés. Aucun avis ne doit partir à un
commerçant avant d'avoir les délibérations du conseil municipal.

---

## Ensuite

La **phase 6 — dashboard web Next.js** : carte OpenStreetMap vert/orange/rouge,
statistiques par zone et par taxe, suivi des agents, journal d'audit, gestion
multi-communes, exports Excel et PDF. C'est l'écran que verra la mairie.
