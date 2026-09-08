# Questions à la mairie — l'opérateur SMS

*Ouvert le 08/09/2026. Bloquant : rien ne part tant que ce point n'est pas tranché.*

## Ce que le SMS commande

Sans passerelle raccordée, trois choses ne fonctionnent pas :

- **Le portail du redevable.** Il s'ouvre par un code à usage unique envoyé par SMS.
  Sans envoi, le code s'afficherait dans la réponse HTTP — et connaître un numéro
  suffirait à ouvrir le dossier fiscal de son propriétaire. L'API **refuse de
  démarrer** en production dans cette configuration, et c'est voulu.
- **La vérification du numéro au recensement.** L'agent confirme le téléphone du
  commerçant par un code. Sans SMS, le numéro reste non vérifié, et un numéro non
  vérifié ne reçoit jamais rien.
- **La campagne mensuelle.** Chaque redevable reçoit un message portant sa facture
  consolidée et le lien de paiement. C'est le seul canal qui atteint un téléphone
  simple, et la population visée en est largement équipée.

---

## 1. Le choix : opérateur direct ou agrégateur ?

**Ce n'est pas un choix neutre côté logiciel.** Le système prévoit deux protocoles,
et un seul est en état de servir.

| | Agrégateur (`generique`) | Orange Developer (`orange`) |
|---|---|---|
| Protocole | `POST JSON { to, from, text }` | OAuth2 puis API SMS |
| État du code | **Terminé et éprouvé** | **Inachevé — refusé au démarrage** |
| Preuve | `scripts/repetition-generale.sh` fait sortir un vrai code par une passerelle parlant ce protocole, en configuration de production | aucune |
| Pour l'activer | trois lignes de `.env` | écrire d'abord l'échange OAuth2 |

Le pilote Orange pose la clé dans un en-tête `Bearer`, alors que l'API Orange
Developer attend un **jeton OAuth2 obtenu par échange de justificatifs**. Cet échange
n'est écrit nulle part. Et un jeton expire : même en collant un jeton valide à la
main, la campagne mensuelle — qui tourne la nuit — tomberait à la première expiration,
en silence.

Le système refuse donc `SMS_FOURNISSEUR=orange` au démarrage, en le disant, plutôt que
de laisser croire à un simple réglage.

**Question 1.1 :** la mairie a-t-elle déjà une convention, ou une préférence, avec un
opérateur ou un agrégateur ? Si c'est un agrégateur qui parle le protocole générique,
le raccordement ne demande aucun développement.

**Question 1.2 :** si Orange est imposé — par une convention existante, un tarif, ou
une exigence institutionnelle —, il faut le dire maintenant : le pilote reste à écrire,
et il ne peut pas être éprouvé sans un compte Orange Developer actif.

---

## 2. Ce qu'il faut obtenir de l'opérateur retenu

Quel qu'il soit :

- **L'adresse de la passerelle** (`SMS_BASE_URL`) et la **clé** (`SMS_API_KEY`).
- **Le nom d'expéditeur** (`SMS_EXPEDITEUR`) : c'est ce que le commerçant voit à la
  place d'un numéro. Il doit être déposé auprès de l'opérateur, et sa longueur est
  limitée — souvent onze caractères. « MAIRIE » est la valeur provisoire.
- **Un compte d'essai**, pour raccorder sans envoyer à de vrais numéros.

**Question 2.1 :** quel nom d'expéditeur la mairie souhaite-t-elle déposer ? Il
apparaîtra sur chaque message reçu par un commerçant.

---

## 3. Le coût, qui n'est pas qu'un tarif unitaire

Le volume n'est pas anodin : **5 443 commerces** au registre visé, un message par
redevable et par mois pour la facture, plus les codes à usage unique à chaque
consultation du portail, plus les relances.

**Question 3.1 :** quel est le tarif au message négocié, et existe-t-il un palier
au-delà d'un certain volume ?

**Question 3.2 :** qui paie — la commune, ou le partenaire privé au titre du contrat
de partenariat ? La réponse change qui doit ouvrir le compte.

**Question 3.3 :** un message non délivré est-il facturé ? Le système journalise
chaque envoi ; il faut savoir ce qu'on rapproche de la facture de l'opérateur.

---

## 4. Ce que le message contient — un écart à trancher

**C'est le point le plus délicat de ce document, et il ne peut pas être tranché par un
technicien.**

FR-081 de la spécification dit que le flux sortant vers l'opérateur SMS porte
« numéro et code uniquement ». Le message réellement produit aujourd'hui porte
davantage :

> Mairie: taxes **Boutique X** = **100000 FCFA**, a payer avant le 31/12/2026.
> Payez par Wave: https://…

Le nom du commerce et le montant dû partent donc vers les serveurs d'un opérateur
privé, et s'affichent sur un écran que d'autres personnes peuvent voir — un téléphone
posé sur un comptoir, prêté, ou consulté par un proche.

Le code, lui, ne refuse aujourd'hui que deux choses : un identifiant interne et un
numéro d'avis. Ni le montant, ni le nom. La documentation affirmait le contraire ; elle
a été corrigée le 08/09/2026.

**Les deux lectures se défendent :**

- *Envoyer le montant* : le redevable a le droit de connaître sa dette, le message est
  plus clair, et le taux de paiement en dépend probablement.
- *Ne pas l'envoyer* : c'est ce que la spécification a écrit, c'est ce qui protège le
  commerçant si son téléphone est vu par un tiers, et c'est ce qui tiendra devant la
  Commission de protection des données. Le lien Wave suffit à porter le montant, sur
  une page que seul le destinataire ouvre.

**Question 4.1 :** la mairie veut-elle que le SMS porte le montant et le nom du
commerce, ou seulement « votre facture est disponible » avec le lien ?

**Question 4.2 :** si la réponse est « seulement le lien », faut-il aussi retirer le
montant du SMS de relance et du reçu de paiement, qui les portent également ?

*La réponse commande une modification du code, pas un réglage. Elle est attendue avant
le premier envoi réel : un message parti ne se rattrape pas.*

---

## Ce qui est déjà tranché

- **Le canal de référence est le SMS**, pas l'application ni le web : la population
  visée est en grande partie équipée de téléphones simples. Concevoir pour le
  smartphone exclurait ceux dont le recouvrement dépend.
- **Aucun code à usage unique ne part vers un numéro non vérifié**, et une demande
  émanant d'un numéro inconnu reçoit exactement la même réponse qu'un numéro connu —
  sinon composer des numéros au hasard permettrait d'énumérer les redevables.
