# Phase 2 — Base de données

**Objectif** : un schéma multi-communes et multi-taxes complet, avec ses migrations
versionnées, ses fonctions PostGIS et un jeu de données de démonstration
permettant de tester toute la chaîne avant même que l'API n'existe.

**Durée estimée** : 2 heures côté développeur (l'essentiel est automatisé).

---

## Ce que j'ai généré

### Migrations — `db/migrations/`

| Fichier | Contenu |
|---|---|
| `0001_extensions_schemas.sql` | Extensions, schémas `app` / `ref` / `audit`, fonctions utilitaires |
| `0002_types_enumeres.sql` | 12 types énumérés (statuts, modes de calcul, actions d'audit) |
| `0003_communes_territoire.sql` | Communes, paramètres fiscaux, zones, quartiers, marchés |
| `0004_referentiels.sql` | Types de taxes, catégories de commerces, emplacements, motifs d'exonération |
| `0005_utilisateurs.sql` | Utilisateurs (4 rôles), affectations, sessions |
| `0006_commerces.sql` | Commerces, photos, QR codes, journal des scans |
| `0007_baremes_taxes.sql` | Barèmes versionnés, tranches, taxes par commerce, exonérations |
| `0008_avis_paiements.sql` | Périodes fiscales, avis, lignes, paiements, transactions Wave, quittances |
| `0009_terrain_synchronisation.sql` | Visites, positions GPS, lots de synchronisation, conflits, imports |
| `0010_audit.sql` | Journal inaltérable, connexions, exports |
| `0011_fonctions_postgis.sql` | Détection du quartier par GPS, commerces proches, distances |
| `0012_fonctions_metier.sql` | Calcul des taxes, génération des avis, pénalités, statut fiscal |
| `0013_triggers.sql` | Audit automatique, report des paiements, contrôles de cohérence |
| `0014_isolation_multi_communes.sql` | Row Level Security sur toutes les tables |
| `0015_vues.sql` | 10 vues : carte, statistiques, recouvrement, audit, tableau de bord |
| `0016_droits_finaux.sql` | Droits applicatifs, statistiques étendues, contrôles de cohérence |

**55 tables** au total (37 dans `app`, 6 dans `ref`, 12 dans `audit` — partitions
mensuelles comprises).

### Données initiales — `db/seeds/`

| Fichier | Contenu | Statut |
|---|---|---|
| `0001_types_taxes.sql` | Les 5 taxes | **Réel** (définitions du cahier des charges) |
| `0002_commune_gtfc.sql` | Commune, 3 zones, 15 quartiers, marché, emplacements, motifs | **Provisoire** |
| `0003_categories_commerces.sql` | 21 catégories + taxes appliquées d'office | **Provisoire** |
| `0004_baremes.sql` | Les 5 barèmes et 49 tranches tarifaires | **Provisoire — montants inventés** |
| `0005_utilisateurs_demo.sql` | 6 comptes (super-admin, admin, superviseur, 3 agents) | **Démonstration** |
| `0006_commerces_demo.sql` | 60 commerces, avis du mois, paiements simulés | **Démonstration** |

### Outil — `db/migrate.sh`

Applique les fichiers dans l'ordre, une transaction par fichier, enregistre une
empreinte SHA-256 de chacun. Un fichier déjà appliqué qui serait modifié plus tard
est signalé au lieu d'être ignoré en silence.

---

## Les données provisoires

Vous m'avez demandé de générer le schéma avec des données factices : **98
enregistrements** sont marqués comme tels. Ils sont tous listés par une seule requête :

```sql
SELECT * FROM app.v_donnees_a_remplacer;
```

| Ce qui est provisoire | Combien | Ce qui est réel |
|---|---|---|
| Noms des zones | 3 | Le nombre : 3 |
| Noms et polygones des quartiers | 15 | Le nombre : 15 |
| Libellés des catégories | 21 | Le nombre : 21 |
| **Montants des barèmes** | 5 + 49 tranches | La liste des 5 taxes |
| Emplacements de marché, motifs d'exonération, marché | 5 | — |

Les **polygones des quartiers** sont une grille arbitraire de 5 × 3 rectangles
découpant l'emprise de la commune. Ils ne correspondent à aucune limite
administrative réelle, mais ils permettent de tester dès maintenant la détection
automatique du quartier par GPS. Le jour où la mairie fournit le vrai fond de carte,
une seule commande rerattache tous les commerces déjà recensés :

```sql
SELECT * FROM app.recalculer_quartiers('<commune_id>');
```

### Remplacer un barème sans casser l'historique

Un barème n'est jamais modifié en place : il est **clos**, et un nouveau prend le
relais à sa date d'effet. Les quittances déjà émises conservent le tarif qui leur a
été appliqué.

```sql
-- 1. Clore les tarifs provisoires
UPDATE app.bareme_taxe SET date_fin = '2026-09-01' WHERE a_remplacer;

-- 2. Insérer le tarif officiel
INSERT INTO app.bareme_taxe (commune_id, type_taxe_id, libelle, mode_calcul,
                             periodicite, montant_unitaire, unite, date_effet,
                             delib_reference, a_remplacer)
SELECT c.id, t.id, 'TODP — tarif au m² par mois', 'par_m2', 'mensuelle',
       750, 'm²', '2026-09-01', 'Délibération n° 2026-14', false
FROM app.commune c, ref.type_taxe t
WHERE c.code = 'GTFC' AND t.code = 'todp';
```

La contrainte `bareme_pas_de_chevauchement` refusera tout tarif qui en recouvrirait
un autre sur la même période. C'est une garantie de la base, pas une convention.

---

## Ce que vous devez faire

### Étape 1 — Copier les nouveaux fichiers sur le serveur

```powershell
# Depuis Windows
scp -r "C:\Users\DELL\Desktop\GTFC\db" gtfc@192.168.1.50:~/gtfc-platform/
```

```bash
ssh gtfc@192.168.1.50
cd ~/gtfc-platform
dos2unix db/migrate.sh 2>/dev/null || true
```

### Étape 2 — Appliquer les migrations et les données de démonstration

```bash
bash db/migrate.sh --seed
```

Attendu : 16 migrations `OK`, puis 6 seeds `OK`, et un récapitulatif du nombre de
tables par schéma.

Pour appliquer **uniquement** le schéma, sans aucune donnée de démonstration :

```bash
bash db/migrate.sh
```

### Étape 3 — Vérifier

```bash
# Etat des migrations
bash db/migrate.sh --status

# Contrôles de cohérence métier
make psql
```

```sql
-- Combien de tables ?
SELECT table_schema, count(*) FROM information_schema.tables
 WHERE table_schema IN ('app','ref','audit') AND table_type='BASE TABLE'
 GROUP BY 1;

-- La détection du quartier par GPS fonctionne-t-elle ?
SELECT * FROM app.detecter_quartier(
    (SELECT id FROM app.commune WHERE code='GTFC'), -17.4470, 14.6870);

-- Les couleurs de la carte
SELECT statut_fiscal, count(*) FROM app.commerce GROUP BY 1;

-- Un avis multi-taxes, ligne par ligne
SELECT l.libelle, l.mode_calcul, l.base_calcul, l.montant_unitaire, l.montant
FROM app.avis_ligne l
JOIN app.avis_imposition a ON a.id = l.avis_id
ORDER BY a.montant_total DESC, l.ordre LIMIT 5;

-- Le détail d'un calcul TODP, opposable en cas de contestation
SELECT jsonb_pretty(l.detail_calcul)
FROM app.avis_ligne l JOIN ref.type_taxe t ON t.id = l.type_taxe_id
WHERE t.code = 'todp' LIMIT 1;

-- Tableau de bord
SELECT * FROM app.v_tableau_bord;

-- Contrôles de cohérence
SELECT * FROM app.verifier_coherence();

-- Tout ce qui reste provisoire
SELECT entite, count(*) FROM app.v_donnees_a_remplacer GROUP BY 1;
```

### Étape 4 — Vérifier l'isolation entre communes

C'est le contrôle le plus important de cette phase : il valide la promesse
« les données d'une mairie ne se mélangent jamais avec celles d'une autre ».

```bash
GID=$(docker exec gtfc-postgres psql -tAX -U postgres -d gtfc_taxes \
      -c "SELECT id FROM app.commune WHERE code='GTFC';")

# Sans contexte : le rôle applicatif ne voit RIEN
docker exec gtfc-postgres psql -tAX -U gtfc_app -d gtfc_taxes \
  -c "SELECT count(*) FROM app.commerce;"            # attendu : 0

# Contexte GTFC : il voit les 60 commerces
docker exec gtfc-postgres psql -tAX -U gtfc_app -d gtfc_taxes \
  -c "BEGIN; SET LOCAL gtfc.commune_id='$GID'; SELECT count(*) FROM app.commerce; COMMIT;"

# Le journal d'audit est inaltérable
docker exec gtfc-postgres psql -tAX -U gtfc_app -d gtfc_taxes \
  -c "UPDATE audit.journal SET motif='x';"           # attendu : permission denied
```

### Étape 5 — Sauvegarder

```bash
bash scripts/backup-postgres.sh --verify
```

---

## Critères de validation de la phase 2

- [ ] `bash db/migrate.sh --status` : 16 migrations et 6 seeds `appliqué`
- [ ] 55 tables réparties sur `app`, `ref` et `audit`
- [ ] `app.detecter_quartier(..., -17.4470, 14.6870)` renvoie un quartier, méthode `polygone`
- [ ] 60 commerces, répartis entre les statuts `a_jour`, `partiel` et `impaye`
- [ ] Un avis multi-taxes affiche patente + TODP + TEOM sur des lignes distinctes
- [ ] `detail_calcul` d'une ligne TODP montre la surface mesurée, l'arrondi et le tarif au m²
- [ ] `SELECT count(*) FROM audit.journal;` > 700 — l'audit se remplit tout seul
- [ ] Sans `gtfc.commune_id`, le rôle `gtfc_app` voit **0** commerce
- [ ] `UPDATE audit.journal` échoue avec `permission denied`
- [ ] `SELECT * FROM app.v_donnees_a_remplacer;` renvoie 98 lignes

---

## Ce qui a été vérifié de mon côté

J'ai appliqué l'intégralité des migrations et des seeds dans un conteneur
`postgis/postgis:16-3.4` jetable, puis exécuté les contrôles ci-dessus. Résultats
observés :

- 16 migrations et 6 seeds appliqués sans erreur, base recréée de zéro
- 55 tables, 60 commerces répartis en 22 à jour / 10 partiels / 28 impayés
- détection du quartier par polygone confirmée sur un point au centre de la commune
- calcul TODP vérifié à la main : 9,70 m² → arrondi supérieur 10 m² → × 400 XOF
  (tarif zone 3) = 4 000 XOF, conforme au barème provisoire
- 158 lignes d'avis générées sur 60 avis, 32 paiements simulés
- isolation multi-communes confirmée : 0 ligne sans contexte, 60 avec le bon
  contexte, 0 avec un autre
- `UPDATE` et `DELETE` sur `audit.journal` refusés, `DROP TABLE` refusé au rôle applicatif

Trois défauts ont été trouvés et corrigés au passage, tous invisibles à la simple
relecture : une clause `WHEN` interdite sur une table à colonnes générées, deux
`CASE` textuels non convertis en type énuméré, et un tirage aléatoire dédoublé qui
produisait des visites terminées avant d'avoir commencé.

---

## Nettoyage avant la mise en production

```sql
-- Supprimer les 60 commerces de démonstration et tout ce qui en dépend
SELECT * FROM app.supprimer_donnees_demo();

-- Désactiver les comptes de test
UPDATE app.utilisateur SET actif = false, archive_le = now()
 WHERE matricule LIKE 'DEMO-%';

-- Contrôle final : cette requête doit ne rien renvoyer
SELECT * FROM app.v_donnees_a_remplacer;
```

Le journal d'audit, lui, conserve la trace du passage des données de démonstration.
C'est voulu : il n'est effaçable par personne, y compris par nous.

---

## Ensuite

Quand les critères de validation sont cochés, dites-le-moi : je génère la
**phase 3 — API Node.js** (authentification JWT à 4 rôles, endpoints REST,
génération des QR codes, envoi vers MinIO, audit automatique, webhook Wave).

Les questions métier de [`QUESTIONS-PHASE-2.md`](QUESTIONS-PHASE-2.md) restent
ouvertes. Elles ne bloquent plus le développement — le schéma est prêt à les
recevoir — mais elles bloqueront la **mise en production réelle** : aucun avis
d'imposition ne doit être émis avec les montants inventés du seed 0004.
