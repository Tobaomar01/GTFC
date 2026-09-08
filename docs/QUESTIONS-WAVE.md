# Questions à la mairie — le compte Wave

*Ouvert le 08/09/2026. Bloquant : aucun paiement réel ne peut être encaissé.*

## Où en est le paiement aujourd'hui

Le chemin complet est écrit et éprouvé, **contre une passerelle factice** : création
du lien de paiement, signature du rappel (*webhook*), imputation idempotente,
quittance. La répétition générale du 08/09/2026 a créé 61 sessions de paiement par le
vrai chemin HTTP, sans jamais sortir vers Internet.

Ce qui manque n'est pas du code : c'est **un compte marchand Wave Business** au nom de
la commune, et ses clés.

---

## 1. Le compte

**Question 1.1 :** le compte Wave Business est-il ouvert au nom de la **commune**, ou
du partenaire privé ? La réponse engage : c'est sur ce compte que les deniers publics
arrivent avant reversement, et la constitution du projet pose que la commune est seule
propriétaire de ses données et de son assiette. Un compte au nom du partenaire rendrait
la réversibilité théorique.

**Question 1.2 :** qui, à la mairie, détient les identifiants et peut les révoquer ?

## 2. Ce qu'il faut obtenir

- La **clé d'API** (`WAVE_API_KEY`) et le **secret de signature des rappels**
  (`WAVE_WEBHOOK_SECRET`). Le second protège l'encaissement : sans lui, n'importe qui
  connaissant l'adresse du rappel pourrait déclarer un paiement.
- L'**identifiant marchand**. Il ne se pose pas dans le `.env` mais en base, sur la
  commune (`app.commune_parametre.wave_marchand_id`) : chaque commune a le sien, et il
  peut changer sans redéploiement.
- Un **environnement d'essai** (*sandbox*), pour raccorder sans mouvementer d'argent
  réel.

**Question 2.1 :** Wave fournit-il un environnement d'essai à la commune, et sous quel
délai ?

## 3. Le rapprochement — ce qui est fait, ce qui reste

La constitution est catégorique : « En cas de désaccord entre le système et l'opérateur
de mobile money, l'encaissement DOIT être bloqué et présenté comme en attente. Il NE
DOIT jamais être présumé. »

Encore faut-il savoir reconnaître un désaccord. **Rien ne le faisait avant le
08/09/2026.** Un rappel se perd — tout opérateur en perd. Wave encaisse, le système
n'impute rien, et le commerçant a payé tout en restant débiteur sur le papier. Un agent
se présente alors chez lui pour réclamer une somme déjà réglée, dont il a le reçu sur
son téléphone. C'est la pire visite possible, et elle était invisible côté mairie.

**Ce qui est en place** : le rapprochement **local**, que la base fait seule, sans
interroger Wave. Il désigne trois désaccords, et le contrôle de cohérence quotidien de
6h30 les remonte :

| Anomalie | Gravité | Ce que cela veut dire |
|---|---|---|
| Encaissement non imputé | **erreur** | Wave a confirmé, aucun paiement ne correspond |
| Paiement annulé, encaissement maintenu | **erreur** | La mairie a annulé ; l'argent est chez l'opérateur |
| Trop-perçu non imputé | avertissement | Wave a encaissé plus que le reste dû |

**Ce qui reste à faire, et qui demande le compte** : interroger Wave sur les sessions
qu'il dit payées et que nous ignorons totalement. Le rapprochement local ne voit que
les transactions dont nous avons trace ; si le lien de paiement a été créé mais que le
rappel n'est jamais arrivé ET que la session a expiré chez nous, seul Wave sait.

Ce client d'API n'est **pas** écrit, délibérément : écrire une intégration qu'on ne peut
pas éprouver serait pire que de ne rien écrire — cela ressemblerait à un contrôle.

**Question 3.1 :** à quelle fréquence la mairie veut-elle ce rapprochement avec
l'opérateur — quotidien, hebdomadaire ? Il conditionne le délai maximal pendant lequel
un commerçant peut être relancé à tort.

**Question 3.2 :** un trop-perçu — le commerçant paie plus que son solde — donne-t-il
lieu à remboursement, ou à un avoir sur l'échéance suivante ? Le système sait le
détecter ; il ne sait pas quoi en faire.

## 4. Le passage en production

**Question 4.1 :** qui décide de la bascule, et sur quelle preuve ? Aujourd'hui
`WAVE_SIMULER` vaut vrai tant que `WAVE_API_KEY` est vide : le système fabrique des
sessions locales et la chaîne entière fonctionne, sans qu'un franc ne bouge. Il faut un
moment décidé où l'on cesse de simuler, et quelqu'un qui l'assume.

---

## Ce qui est déjà tranché

- **Zéro espèce.** L'encaissement en liquide a été retiré de l'application de terrain :
  un agent ne manipule pas d'argent, et le bouton n'existe plus.
- **Wave est le seul canal du pilote.** Orange Money est écarté pour éviter un second
  rapprochement et un second mode de panne.
- **Ce qui sort vers Wave** : un numéro de téléphone et un montant. Jamais le nom du
  commerce, ni celui du gérant, ni le détail des taxes.
