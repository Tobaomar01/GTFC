# Guide de la mairie — le cycle mensuel

*Pour l'administrateur de la commune et les superviseurs.*

---

## Le cycle en un coup d'œil

```
  1er du mois, 03h30    →  AUTOMATIQUE : période, avis, émission,
                            liens de paiement, notifications
  Dans la matinée       →  Vous vérifiez, vous distribuez les messages
  Tous les lundis 08h   →  AUTOMATIQUE : relance des impayés
  En continu            →  Encaissements, quittances, suivi de la carte
  Fin de mois           →  État de recouvrement pour le conseil municipal
```

**L'essentiel se fait tout seul.** Votre travail consiste à vérifier, à
distribuer, et à traiter les cas qui sortent du cadre.

---

## Le 1er du mois — ce qui s'est passé sans vous

À 03h30, le serveur a :

1. créé la période fiscale du mois,
2. calculé un avis d'imposition par commerce actif, regroupant toutes ses taxes,
3. émis ces avis (ils deviennent exigibles),
4. créé un lien de paiement Wave par avis,
5. préparé une notification par commerçant.

### Ce que vous faites en arrivant

Ouvrez **Recouvrement**. Vérifiez trois chiffres :

| Chiffre | Ce qu'il doit valoir |
|---|---|
| **Avis émis** | Proche du nombre de commerces actifs |
| **Montant attendu** | Cohérent avec le mois précédent |
| **Sans téléphone** | Le plus bas possible — ces commerçants ne recevront pas de lien |

Si la facturation ne s'est pas déclenchée (coupure de courant la nuit du 1er),
relancez-la à la main avec les trois boutons, dans l'ordre :

> **1. Générer les avis** → **2. Émettre** → **3. Lancer la campagne**

Ces opérations sont **sans risque** : relancées, elles ne facturent jamais deux
fois. C'est garanti par la base, pas par une précaution d'usage.

---

## Distribuer les demandes de paiement

Tant qu'aucun opérateur SMS n'est raccordé, les messages attendent d'être
transmis par les agents.

**Recouvrement → « X messages à transmettre »**

Imprimez la liste, découpez-la par zone, remettez-la aux agents le matin. Ils
montrent le lien de paiement au commerçant sur leur téléphone, ou lui dictent.

Quand un agent vous confirme avoir transmis, marquez les messages comme remis.

---

## Suivre le recouvrement

### La carte — le coup d'œil quotidien

**Carte** → filtrez par zone.

| Couleur | Signification |
|---|---|
| **Vert** | À jour |
| **Orange** | A payé une partie |
| **Rouge** | N'a rien payé |
| Gris | Exonéré |
| Bleu | Pas encore facturé |

Une zone qui vire au rouge en quelques jours mérite un appel à l'agent
responsable : soit les commerçants ne reçoivent pas les demandes, soit
l'agent ne passe plus.

### Les deux alertes à ne jamais ignorer

**« Espèces non versées en caisse »** — page Agents. Un encaissement en espèces
qui n'a pas été remis depuis plus de 3 jours s'affiche en rouge. C'est le
contrôle anti-détournement le plus direct du dispositif. Rapprochez avec la
caisse **avant** de relancer l'agent : une erreur de saisie est plus fréquente
qu'une malversation.

**« Visites à vérifier »** — page Agents. La position relevée était à plus de
100 m du commerce. Un signal GPS faible suffit à l'expliquer. **Ce n'est un
signal d'alerte qu'en cas de répétition sur le même agent.**

---

## Les cas particuliers

### Accorder une exonération

Une exonération engage la commune. Elle exige un motif, souvent un
justificatif, et laisse une trace nominative dans le journal d'audit.
Réservez-la aux cas prévus par la délibération.

### Annuler un paiement

Un paiement ne se supprime jamais — il se contre-passe, avec un motif. La
quittance émise reste valable jusqu'à annulation explicite ; la page publique
de vérification affichera alors « Paiement annulé ».

### Arbitrer un conflit de synchronisation

Quand un agent et la mairie ont modifié la même fiche, le serveur ne tranche
pas tout seul : il marque un conflit. **Recouvrement → conflits.** Vous voyez
les deux versions champ par champ, et vous choisissez.

### Un commerce disparaît

Ne le supprimez pas. Passez son état à **« Cessation d'activité »** avec un
motif. Rien n'est jamais effacé : le registre doit rester reconstituable.

---

## Fin de mois — le conseil municipal

**Vue d'ensemble → « État de recouvrement (PDF) »**

Trois tableaux : recouvrement par période, situation par zone, répartition par
taxe. C'est le document à présenter.

Pour un travail plus fin, les exports Excel — commerces et paiements — ouvrent
directement dans un tableur.

> Le montant recouvré **par taxe** est une estimation proportionnelle : un
> paiement Wave règle l'avis dans son ensemble, pas une taxe en particulier.
> Le total, lui, est exact. Dites-le si la question vient en séance.

---

## Le journal d'audit

Chaque action est enregistrée : qui, quoi, quand, depuis quelle adresse, et le
détail de ce qui a changé. **Personne ne peut modifier ni effacer une ligne** —
ni un agent, ni vous, ni l'informaticien. C'est garanti par la base de données.

C'est là qu'on regarde quand un commerçant conteste, quand un montant a changé
sans explication, ou quand il faut prouver qu'une décision a bien été prise.

Cliquez un enregistrement : l'avant et l'après s'affichent côte à côte.

---

## Ce qui doit rester à zéro

| Indicateur | Où | Si ce n'est pas zéro |
|---|---|---|
| **Données provisoires** | Vue d'ensemble | **Aucun avis ne doit être émis.** Les barèmes ne sont pas ceux de la commune |
| Taxes sans barème en vigueur | Paramètres | La génération des avis échouera pour ces commerces |
| Espèces non versées > 3 jours | Agents | À rapprocher avec la caisse |
| Conflits de synchronisation | Recouvrement | Du travail d'agent reste en attente d'arbitrage |

---

## Créer un compte

**Agents** : un compte par agent, jamais de compte partagé — le journal
d'audit perdrait tout intérêt. Le mot de passe communiqué à l'oral est
provisoire : l'agent devra le changer à sa première connexion.

Un agent ne peut **pas** se connecter au tableau de bord, et un administrateur
n'a rien à faire sur l'application de terrain. C'est volontaire.

---

## Quand quelque chose ne va pas

| Symptôme | Première chose à regarder |
|---|---|
| Un agent ne peut pas se connecter | Page Agents : compte verrouillé après 5 échecs ? désactivé ? |
| Les avis ne sont pas partis le 1er | Recouvrement : relancer les 3 boutons à la main |
| Un montant semble faux | Fiche du commerce → « Calculer les montants dus » → le détail du calcul |
| La carte est vide | Les commerces sans coordonnées GPS n'y figurent pas — voir la page Commerces |
| Quelque chose d'inexplicable | Journal d'audit, filtré sur l'enregistrement concerné |

Pour un problème technique, sur le serveur :

```bash
bash scripts/healthcheck.sh      # les services sont-ils debout ?
bash scripts/recette.sh          # la plateforme fait-elle son travail ?
pm2 logs --lines 50              # les journaux applicatifs
```
