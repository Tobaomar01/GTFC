# Politique de confidentialité — GTFC Collecte

**Commune de Gueule Tapée–Fass–Colobane, Dakar, Sénégal**

*Version 1.0 — projet soumis à la validation de la mairie. Date d'entrée en
vigueur : à compléter.*

> **Ce document n'a pas encore été validé.** Il a été rédigé à partir de ce que
> le logiciel collecte réellement — tables et colonnes vérifiées une à une — et
> non à partir d'un modèle générique. Il doit être relu par la mairie, qui est
> seule responsable du traitement, et vraisemblablement déclaré à la Commission
> de Protection des Données Personnelles avant toute mise en service. Les
> mentions en italique appellent une décision ou une information que seule la
> mairie détient.

---

## 1. Qui est responsable de ces données

La **commune de Gueule Tapée–Fass–Colobane** est responsable du traitement.
Les données sont hébergées sur un serveur situé *dans les locaux de la mairie*
et n'en sortent pas.

*À compléter : adresse postale de la mairie, nom et coordonnées de la personne
à contacter pour toute question relative aux données.*

Deux applications relèvent de cette politique :

- **GTFC Collecte**, installée sur les téléphones des agents de terrain ;
- le **portail du redevable**, page web sur laquelle un commerçant consulte son
  dossier fiscal.

---

## 2. Ce qui est collecté, et pourquoi

### 2.1 Sur les commerçants recensés

| Donnée | Pourquoi elle est nécessaire |
|---|---|
| Nom et prénom du gérant | Identifier le redevable d'une imposition |
| Numéro de téléphone | Envoyer l'avis d'imposition et le lien de paiement ; ouvrir l'accès au portail |
| Numéro de téléphone de paiement | Rapprocher un versement du bon dossier |
| NINEA, le cas échéant | Rattacher le commerce au registre national |
| Enseigne, adresse, catégorie, surfaces | Établir l'assiette de la taxe |
| Position géographique du commerce | Rattacher le commerce à sa rue et à son quartier, et éviter les doublons |
| Photographies de la devanture, de l'enseigne, du trottoir occupé | Attester du recensement et de la surface facturée, et permettre au commerçant de contester sur pièce |

**Les photographies sont prises depuis la voie publique et cadrent un local
commercial.** Elles n'ont pas vocation à montrer des personnes. Si une personne
y figure de façon incidente, elle peut en demander le retrait (section 6).

### 2.2 Sur les agents de la commune

| Donnée | Pourquoi |
|---|---|
| Nom, prénom, téléphone, courriel | Ouvrir un compte et le rattacher à ses actes |
| Position au moment d'une visite ou d'une photo | Attester qu'un relevé a bien été fait sur place |
| Adresse IP de connexion | Sécurité des comptes, détection des accès anormaux |

**Aucun suivi de déplacement n'est effectué.** C'est une décision inscrite dans
la spécification du projet et vérifiée dans le code : la position d'un agent
n'est enregistrée qu'aux **instants précis** où il valide un recensement, une
visite ou une photographie. Entre deux relevés, rien n'est enregistré. Le
logiciel ne comporte aucune fonction de localisation continue, et la permission
Android de localisation en arrière-plan est explicitement **bloquée**.

### 2.3 Sur les visiteurs du portail

Le portail demande un **numéro de téléphone** et envoie un code à usage unique.
Il conserve le numéro, la date de la demande et **deux adresses IP** — celle
qui a demandé le code, celle qui l'a utilisé — le temps nécessaire à repérer un
usage abusif. **Ces enregistrements sont effacés trente jours après expiration
du code**, automatiquement, chaque nuit.

Les pages publiques accessibles par QR code enregistrent le fait qu'un scan a
eu lieu, **sans identifier qui a scanné** : l'adresse et le navigateur du
lecteur sont effacés au bout de **trente jours**, automatiquement. L'événement
lui-même subsiste — savoir qu'un sticker a été lu, quand, sur quel commerce,
sert à repérer un autocollant arraché ou recopié.

---

## 3. Ce qui n'est pas collecté

Pour éviter toute ambiguïté, voici ce que le logiciel **ne fait pas** :

- il n'accède pas aux **contacts** du téléphone ;
- il n'accède pas au **microphone** — la permission est bloquée ;
- il ne suit pas la position en **arrière-plan** ;
- il ne collecte aucune donnée **publicitaire** et ne comporte aucun traceur ;
- il ne transmet **rien à un tiers** à des fins commerciales ;
- il n'enregistre **aucune donnée bancaire** : les paiements passent par Wave,
  qui reçoit le numéro de téléphone et le montant, et rien d'autre.

---

## 4. Qui peut voir quoi

L'accès est cloisonné par rôle, et par commune :

- un **agent** voit les commerces de son secteur, et ne voit jamais ceux d'une
  autre commune ;
- un **superviseur** voit l'ensemble de sa commune ;
- le **maire** consulte la recette de sa commune sans pouvoir la modifier ;
- une **remise de dette** exige deux personnes distinctes : celle qui la
  prépare ne peut pas la valider.

Toute consultation et toute modification sont inscrites dans un **journal
d'audit inaltérable** : chaque entrée est scellée à la précédente, de sorte
qu'aucune ne peut être retirée ou modifiée sans que cela se voie.

---

## 5. Combien de temps les données sont conservées

*Les durées ci-dessous sont proposées et doivent être arrêtées par la mairie,
en cohérence avec les obligations de conservation des pièces fiscales.*

| Donnée | Durée proposée |
|---|---|
| Dossier fiscal d'un commerce (avis, paiements, quittances) | *10 ans, durée usuelle de conservation des pièces fiscales* |
| Photographies de recensement | *Jusqu'à la radiation du commerce, puis 1 an* |
| Comptes d'agents | Durée de la mission, puis archivage |
| Codes à usage unique du portail, et adresses IP associées | **30 jours après expiration** — purge automatique nocturne |
| Sessions du portail du redevable | **30 jours après expiration** — purge automatique nocturne |
| Sessions des agents et du tableau de bord | Purge automatique hebdomadaire |
| Adresse et navigateur d'une lecture publique de QR | **30 jours** — anonymisation automatique nocturne |
| Journal d'audit | *10 ans — c'est la pièce qui rend un contrôle opposable* |

**Rien n'est effacé physiquement** : une écriture comptable ne disparaît pas,
elle est archivée. C'est une exigence du dispositif anti-fraude, et cela
signifie qu'une donnée « supprimée » à votre demande est rendue inaccessible et
inutilisable, mais reste dans le journal des opérations passées.

---

## 6. Vos droits

Conformément à la **loi n° 2008-12 du 25 janvier 2008** portant sur la
protection des données à caractère personnel au Sénégal, vous pouvez :

- **accéder** aux données qui vous concernent ;
- en demander la **rectification** si elles sont inexactes — une surface mal
  mesurée, un numéro erroné ;
- vous **opposer** à un traitement pour un motif légitime ;
- demander le retrait d'une **photographie** sur laquelle vous figurez.

Une part de ces droits s'exerce directement : le portail du redevable vous
donne accès à votre dossier, et la **contestation d'un avis** y est prévue.

Pour le reste, écrivez à *[adresse à compléter]* ou présentez-vous à la mairie.
Une réponse vous sera apportée dans un délai d'un mois.

**Limite à connaître** : le droit à l'effacement ne s'étend pas aux données
nécessaires à l'établissement de l'impôt ni au journal d'audit. Une dette
fiscale ne s'efface pas parce qu'on demande la suppression de ses données.

**Recours** : vous pouvez saisir la **Commission de Protection des Données
Personnelles (CDP)** du Sénégal si vous estimez vos droits méconnus.

---

## 7. Où sont les données, et comment elles sont protégées

Les données sont hébergées **sur un serveur appartenant à la commune**, situé
dans ses locaux. Elles ne sont ni exportées, ni confiées à un prestataire
étranger, ni hébergées dans un nuage commercial.

Mesures en place :

- chiffrement des échanges entre les téléphones, le serveur et les navigateurs ;
- mots de passe stockés sous forme d'empreintes irréversibles ;
- cloisonnement strict par commune, appliqué par la base de données elle-même ;
- journal d'audit scellé, vérifié automatiquement ;
- sauvegardes quotidiennes, dont la restauration est éprouvée périodiquement.

Un seul tiers reçoit des données : **Wave Sénégal**, pour l'exécution des
paiements — numéro de téléphone du payeur et montant. Wave applique sa propre
politique de confidentialité.

*Si un opérateur SMS est raccordé, il recevra également les numéros
destinataires ; son nom sera mentionné ici.*

---

## 8. Les enfants

Le service s'adresse à des commerçants et à des agents municipaux. Il n'est pas
destiné aux mineurs et ne collecte pas sciemment leurs données.

---

## 9. Modifications

Toute modification de cette politique sera publiée à cette adresse, avec sa
date. Les changements substantiels seront portés à la connaissance des
redevables par les moyens habituels de la commune.

---

## 10. Nous écrire

*À compléter : adresse postale de la mairie, adresse électronique dédiée,
numéro de téléphone.*

---

### Note technique — publication

Google Play exige que cette politique soit accessible à une **URL publique**,
sans authentification. Elle sera publiée à
`https://gtfc.<domaine>/confidentialite` une fois le serveur en service, et
cette adresse sera déclarée dans la fiche de l'application.
