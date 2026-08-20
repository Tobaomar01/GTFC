# Données officielles de la commune — mode d'emploi

Ce dossier contient **six fichiers à remplir**. Ils remplacent les données
provisoires du jeu initial : noms de quartiers, catégories de commerces et
surtout **les barèmes de taxes**.

Tant qu'ils ne sont pas remplis et importés, aucun avis d'imposition ne doit
partir à un commerçant : la plateforme calcule juste, mais sur des tarifs
inventés.

---

## Comment procéder

### 1. Remettre les fichiers à la mairie

Les six `.csv` s'ouvrent directement dans Excel ou LibreOffice. Ils sont
**pré-remplis avec les valeurs provisoires** : le secrétaire général ou le
service des finances n'a qu'à corriger ce qui est faux, ligne par ligne.

C'est plus efficace qu'une demande écrite — on voit tout de suite ce qui est
attendu, et sous quelle forme.

> **En ouvrant dans Excel** : choisissez le séparateur **point-virgule** et
> l'encodage **UTF-8**. Enregistrez en `CSV UTF-8 (délimité par des
> points-virgules)`. Sinon les accents ressortent en caractères bizarres.

### 2. Vérifier avant d'appliquer

```bash
node db/importer-reel.js --verifier
```

Le script contrôle tout — codes inconnus, montants négatifs, quartiers
rattachés à une zone inexistante — et **n'écrit rien**. Corrigez, relancez
jusqu'à ce que tout soit vert.

### 3. Voir ce qui va changer

```bash
node db/importer-reel.js --apercu
```

Affiche, ligne par ligne, ce qui sera modifié : anciens noms → nouveaux noms,
anciens tarifs → nouveaux tarifs. **Relisez cet écran avec quelqu'un de la
mairie** avant de continuer.

### 4. Appliquer

```bash
node db/importer-reel.js --appliquer --date-effet 2026-09-01
```

Une sauvegarde est prise automatiquement avant toute écriture.

---

## Ce qui se passe pour les barèmes

Un tarif **n'est jamais modifié en place**. Le barème provisoire est **clos**
à la date d'effet, et le nouveau prend le relais le même jour.

```
Barème provisoire   [1er janvier 2026 ────────► 31 août 2026]
Barème officiel                                 [1er septembre 2026 ────────►
```

Conséquence : **les avis déjà émis gardent le tarif qui leur a été appliqué.**
Une quittance de juillet reste explicable en décembre. C'est ce qui permet de
répondre à un commerçant qui ressort un vieux papier.

La date d'effet ne peut pas être dans le passé si des avis ont déjà été émis
sur la période — le script refuse.

---

## Les six fichiers

| Fichier | Contenu | Qui peut le remplir |
|---|---|---|
| `1-zones.csv` | Les 3 zones | Service technique |
| `2-quartiers.csv` | Les 15 quartiers et leur zone | Service technique |
| `3-categories.csv` | Les 21 catégories de commerces | Service des finances |
| `4-parametres.csv` | Règles de facturation (échéance, pénalités, arrondi TODP) | **Délibération** |
| `5-baremes.csv` | **Tous les tarifs** | **Délibération** |
| `6-marches-emplacements.csv` | Marchés communaux et types d'emplacement | Service des marchés |

Les deux derniers doivent venir d'une **délibération du conseil municipal**,
pas d'un usage oral. Le numéro et la date de la délibération sont demandés :
ils figureront sur les quittances et permettront de justifier un montant.

---

## Ce que le script ne fait pas

**Les polygones de quartiers.** Ce sont des fichiers cartographiques
(GeoJSON, Shapefile, KML) fournis par la mairie ou l'ANAT. Sans eux, la
détection automatique du quartier par GPS reste approximative — l'agent
choisit dans une liste.

Quand vous les obtenez, chargez-les puis lancez :

```sql
SELECT * FROM app.recalculer_quartiers('<identifiant de la commune>');
```

Tous les commerces déjà recensés sont rerattachés d'après leurs coordonnées.
Ça fonctionne à n'importe quel moment, même après des mois de collecte.

**Le registre existant des commerces.** Si la mairie possède un fichier des
5 443 commerces, envoyez-le : c'est un import distinct, qui évite aux agents
de tout ressaisir sur le terrain.

---

## Questions fréquentes de la mairie

**« On n'a pas encore délibéré sur la TODP. »**
Laissez la ligne telle quelle et signalez-le. Le script refusera d'importer un
barème incomplet plutôt que d'inventer. Mieux vaut une taxe non facturée qu'une
taxe mal facturée.

**« Les tarifs changent au 1er janvier. »**
Parfait : importez maintenant avec `--date-effet 2027-01-01`. Le barème actuel
sera clos automatiquement à cette date, et le nouveau prendra le relais tout
seul. Rien à faire le jour venu.

**« Le tarif dépend de la rue, pas de la zone. »**
Dites-le-moi : la structure le permet (le barème TODP se module déjà par zone),
mais il faut alors découper les zones autrement, ou ajouter un niveau.

**« On veut exonérer certains commerces. »**
Ça ne passe pas par ce fichier : les exonérations sont accordées au cas par
cas depuis le tableau de bord, avec un motif et une trace au journal d'audit.
Le fichier `4-parametres.csv` définit seulement les **motifs** autorisés.
