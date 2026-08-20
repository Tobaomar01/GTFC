# Plateforme de digitalisation de la collecte des taxes locales

**Commune de Gueule Tapée-Fass-Colobane (GTFC) — Dakar, Sénégal**
Projet pilote, architecture multi-communes, 100 % auto-hébergé.

---

## Le problème

La commune (2 km², ~52 000 habitants, 5 443+ commerces) collecte ses taxes
entièrement à la main : pas de registre centralisé, aucune traçabilité des
paiements, encaissements en espèces, plusieurs taxes par commerce suivies de façon
incohérente. Résultat : un taux de recouvrement faible qui prive la commune de ses
ressources propres.

## La solution

| Composant | Pour qui | Quoi |
|---|---|---|
| **App Android** | Agents de terrain | Recensement GPS + photos, multi-taxes, scan QR, **fonctionne hors ligne** |
| **Dashboard web** | Mairie, superviseurs | Carte vert/orange/rouge, statistiques, journal d'audit, exports |
| **Paiement Wave** | Commerçants | Un seul lien mensuel regroupant toutes les taxes dues, quittance PDF |

Chaque commune est un **locataire isolé** : ses agents, commerces, taxes et
paiements ne se mélangent jamais avec ceux d'une autre commune. GTFC est la commune
pilote ; l'ajout d'une nouvelle commune ne demande ni nouveau serveur ni nouveau code.

---

## Architecture

```
                        Internet
                            │
                    ┌───────┴───────┐
                    │  Nginx + TLS  │   Let's Encrypt, renouvellement auto
                    └───────┬───────┘
        ┌───────────────────┼───────────────────┐
        │                   │                   │
   api.domaine        gtfc.domaine          s3.domaine
        │                   │                   │
  ┌─────┴─────┐      ┌──────┴──────┐      ┌─────┴─────┐
  │ API Node  │      │  Next.js    │      │   MinIO   │
  │  Express  │      │  Dashboard  │      │  photos   │
  │   (PM2)   │      │    (PM2)    │      │ (Docker)  │
  └─────┬─────┘      └──────┬──────┘      └───────────┘
        │                   │
        └─────────┬─────────┘
                  │
        ┌─────────┴──────────┐
        │ PostgreSQL 16      │   PostGIS : détection du quartier par GPS
        │ + PostGIS (Docker) │   Schémas : app / ref / audit
        └────────────────────┘

  Sortant vers l'extérieur — et rien d'autre :
    • Wave Sénégal  → numéro de téléphone + montant, jamais de donnée fiscale
    • OpenStreetMap → tuiles de carte uniquement
```

**Tout le reste reste sur le serveur physique de la commune.**

---

## État d'avancement

| Phase | Contenu | État |
|---|---|---|
| **1** | Configuration serveur — Docker, PostgreSQL+PostGIS, MinIO, Nginx, SSL, PM2, sauvegardes | ✅ **Livrée** |
| **2** | Base de données — 55 tables, migrations versionnées, PostGIS, RLS multi-communes, seed GTFC | ✅ **Livrée** — données métier provisoires ([questions](docs/QUESTIONS-PHASE-2.md)) |
| **3** | API Node.js — JWT 4 rôles, ~70 endpoints, QR, MinIO, audit, sync hors-ligne, webhook Wave | ✅ **Livrée** — 74 tests de bout en bout |
| **4** | App Android Expo — GPS, photos, scan QR, hors-ligne + synchronisation | ✅ **Livrée** — 56 tests (schéma SQLite + protocole) |
| **5** | Paiement Wave + QR — checkout, webhook, quittance PDF, planificateur, sticker A6 | ✅ **Livrée** — 38 tests · mode simulation en attendant la clé Wave |
| **6** | Dashboard Next.js — carte OSM, statistiques, audit, multi-communes, exports | ✅ **Livrée** — 42 tests + 14 captures d'écran |
| 7 | Tests terrain + déploiement — APK signé, Wave sandbox→prod, Google Play | 📋 **Checklists prêtes** — le reste est du terrain |

---

## Démarrage rapide (sur le serveur Ubuntu)

Un seul script enchaîne les 6 phases, avec une vérification avant et après
chaque étape :

```bash
sudo bash scripts/install-ubuntu.sh   # une fois — puis se déconnecter/reconnecter
cp .env.template .env && nano .env    # remplir les valeurs A_REMPLIR
chmod 600 .env

bash scripts/deployer.sh              # les 12 étapes, jusqu'au bout
bash scripts/recette.sh               # la plateforme fait-elle son travail ?
```

Le déploiement est **idempotent** : relancé après une coupure, il reprend là
où il en était. Il **s'arrête à la première erreur** et dit quoi faire.

```bash
bash scripts/deployer.sh --etat        # où en est-on ?
bash scripts/deployer.sh --simulation  # montrer le plan sans rien exécuter
bash scripts/deployer.sh --depuis 6    # reprendre à une étape précise
bash scripts/deployer.sh --sans-seed   # sans les données de démonstration
```

**Procédures détaillées, phase par phase :**
[`docs/PHASE-1-serveur.md`](docs/PHASE-1-serveur.md) ·
[`docs/PHASE-2-base-de-donnees.md`](docs/PHASE-2-base-de-donnees.md) ·
[`docs/PHASE-3-api.md`](docs/PHASE-3-api.md) ·
[`docs/PHASE-4-application-android.md`](docs/PHASE-4-application-android.md) ·
[`docs/PHASE-5-wave-qr.md`](docs/PHASE-5-wave-qr.md) ·
[`docs/PHASE-6-dashboard.md`](docs/PHASE-6-dashboard.md)

**Pour les utilisateurs :**
[`docs/GUIDE-AGENT.md`](docs/GUIDE-AGENT.md) — mémo de terrain, à imprimer ·
[`docs/GUIDE-MAIRIE.md`](docs/GUIDE-MAIRIE.md) — le cycle mensuel ·
[`docs/PHASE-7-recette-terrain.md`](docs/PHASE-7-recette-terrain.md) — la journée de test

> Les données métier du seed (noms de quartiers, catégories, **barèmes**) sont
> provisoires et marquées `À_REMPLACER`. Inventaire :
> `SELECT * FROM app.v_donnees_a_remplacer;`

---

## Commandes courantes

```bash
make help            # liste toutes les commandes
make up / make down  # démarrer / arrêter l'infrastructure
make health          # contrôle de santé complet
make logs S=nginx    # suivre les journaux d'un service
make psql            # session SQL sur la base
make backup          # sauvegarde immédiate
make restore         # restauration guidée (destructif)
make commune SLUG=parcelles   # ajouter le sous-domaine d'une commune
```

---

## Structure du dépôt

```
.
├── docker-compose.yml          Infrastructure : Postgres, MinIO, Nginx, Certbot
├── ecosystem.config.js         PM2 : API, dashboard, planificateur
├── Makefile                    Raccourcis d'exploitation
├── .env.template               Toutes les variables de configuration
│
├── infra/
│   ├── postgres/               postgresql.conf + scripts d'initialisation
│   ├── minio/                  Création des buckets et de la politique d'accès
│   ├── nginx/                  Configuration, modèles d'hôtes, snippets TLS
│   └── certbot/                Certificats (généré, non versionné)
│
├── scripts/
│   ├── deployer.sh             Déploiement complet, 12 étapes vérifiées
│   ├── recette.sh              Recette fonctionnelle de bout en bout
│   └── ...                     Installation, SSL, sauvegarde, restauration, santé
│
├── db/
│   ├── migrate.sh              Gestionnaire de migrations (transactionnel, empreintes)
│   ├── migrations/             18 fichiers SQL versionnés
│   └── seeds/                  Données initiales — provisoires, marquées À_REMPLACER
│
├── docs/
│   ├── PHASE-1-serveur.md          Procédure de déploiement détaillée
│   ├── PHASE-2-base-de-donnees.md  Schéma, migrations, validation
│   ├── PHASE-3-api.md              Endpoints, déploiement, validation
│   ├── PHASE-4-application-android.md  App terrain, mode hors-ligne, APK
│   ├── PHASE-5-wave-qr.md          Paiement, quittances, stickers, simulateur
│   ├── PHASE-6-dashboard.md        Dashboard, palette validée, exports
│   ├── PHASE-7-recette-terrain.md  Journée de test, Wave prod, Google Play
│   ├── GUIDE-AGENT.md              Mémo terrain — à imprimer recto-verso
│   ├── GUIDE-MAIRIE.md             Cycle mensuel pour la mairie
│   ├── exemples/                   Quittance et planche de stickers réelles
│   └── QUESTIONS-PHASE-2.md        Données métier à fournir par la mairie
│
└── apps/
    ├── api/                    Node.js + Express — livré
    │   ├── src/config/         Environnement, base (contexte RLS), journaux
    │   ├── src/middleware/     JWT, validation zod, erreurs, débit
    │   ├── src/services/       Auth, commerces, QR, MinIO, sync, Wave
    │   ├── src/routes/         ~70 endpoints
    │   └── scripts/            Premier compte, simulateur Wave
    ├── dashboard/              Next.js 16 + Tailwind — livré
    │   ├── src/app/api/proxy/  Mandataire : le navigateur ne voit jamais le jeton
    │   ├── src/composants/     Graphiques faits main, carte Leaflet
    │   └── src/app/(prive)/    7 pages · /c/ et /q/ publiques
    └── mobile/                 React Native + Expo — livré
        ├── src/bdd/            SQLite locale : 10 tables, file de synchronisation
        ├── src/services/       Synchronisation, GPS, photos
        ├── src/ecrans/         Connexion, recensement, commerces, scanner, outils
        └── outils/             Vérification du schéma et de la syntaxe
```

---

## Sécurité

- PostgreSQL et MinIO écoutent **uniquement sur `127.0.0.1`** — jamais exposés à Internet
- Le rôle applicatif ne peut **ni supprimer une table ni modifier le schéma**
- Le schéma `audit` est en **ajout seulement** : aucune ligne du journal ne peut être
  modifiée ou supprimée par l'application
- Aucun bucket n'est public : les photos ne sont servies que via des **URL pré-signées**
  générées après vérification du JWT
- Versioning MinIO activé : une photo de devanture ne peut pas être écrasée en silence
- Limitation de débit sur l'authentification (5 tentatives/minute) et sur l'API
- Pare-feu UFW (22/80/443 uniquement), fail2ban, mises à jour de sécurité automatiques
- **Wave ne reçoit qu'un numéro de téléphone et un montant.** Aucune donnée fiscale
  ou nominative ne sort du serveur.

## Sauvegardes

| Quoi | Quand | Rétention |
|---|---|---|
| Base PostgreSQL | 03h15 tous les jours | 14 quotidiennes, 8 hebdomadaires, 12 mensuelles |
| Photos MinIO | 03h45 tous les jours | Miroir incrémental, sans suppression |
| Test de restauration réel | Dimanche 04h30 | — |
| Copie sur disque externe | Après chaque sauvegarde | Miroir complet |

Chaque archive est vérifiée (`pg_restore --list`) et accompagnée d'une somme
SHA-256. Une sauvegarde jamais testée n'est pas une sauvegarde : c'est pourquoi une
restauration complète est rejouée automatiquement chaque dimanche.

---

*Document et code confidentiels — projet pilote commune de Gueule Tapée-Fass-Colobane.*
