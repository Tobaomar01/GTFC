# Questions à la mairie — mémoire des situations et indicateur de risque

*Ouvert le 08/09/2026. À trancher avant la fin de la phase bêta.*

La plateforme sait désormais garder, à chaque clôture de période, une photographie
figée de la situation de chaque commerce facturé, et en tirer un indicateur de risque
de défaut de paiement. Cet indicateur sert à **ordonner les visites d'accompagnement**,
rien d'autre : il ne déclenche aucun acte administratif, ne descend pas sur le téléphone
des agents et n'apparaît dans aucun message au redevable (FR-092).

Les valeurs livrées ci-dessous sont **provisoires**. Elles sont posées en base, dans
`app.commune_parametre`, précisément pour que la mairie puisse les changer par
délibération sans redéploiement (FR-090). Tant qu'elles n'ont pas été validées, elles
n'engagent que le pilote.

---

## 1. Ce qui constitue un risque, et ce qui n'en constitue pas

L'indicateur repose sur cinq facteurs observés. Chacun porte un poids.

| Facteur | Ce qu'il constate | Poids provisoire |
|---|---|---|
| Jamais rien réglé | Aucun versement sur aucune période observée | 40 |
| Règlement interrompu | A réglé, puis plus rien sur la dernière période close | 25 |
| Retard habituel | Règle après la date d'exigibilité plus souvent qu'avant | 15 |
| Règlement partiel répété | Solde restant dû à la clôture, plusieurs périodes de suite | 15 |
| Relances répétées | Nombre moyen de relances par période au-dessus du seuil | 5 |

**Questions :**

1.1 Ces cinq facteurs sont-ils les bons ? En manque-t-il un que les agents constatent sur
le terrain et que la base ne voit pas — un commerce saisonnier, un marché hebdomadaire,
une activité qui ferme pendant l'hivernage ?

1.2 Les poids ci-dessus ordonnent-ils correctement la gravité, du point de vue de la
mairie ? Un commerçant qui n'a jamais rien réglé est-il vraiment le cas le plus
prioritaire, ou celui qui réglait et s'est arrêté l'est-il davantage ?

1.3 **Un règlement systématiquement en retard mais toujours complet doit-il compter ?**
C'est un choix de politique : la trésorerie de la commune en souffre, mais la créance
finit par rentrer.

## 2. Les seuils

| Paramètre | Valeur provisoire | Ce qu'il commande |
|---|---|---|
| Périodes observées minimales | 2 | En deçà, l'indicateur répond « indéterminé » plutôt qu'un chiffre (FR-091) |
| Seuil « attention » | 30 | À partir de ce total, le commerce remonte dans la liste |
| Seuil « élevé » | 60 | À partir de ce total, il est proposé en priorité sur la feuille de route |
| Relances tolérées par période | 1 | Au-delà, le facteur « relances répétées » s'applique |

**Questions :**

2.1 Deux périodes observées suffisent-elles pour se prononcer ? Le pilote portant sur des
périodes mensuelles, deux mois est court. Trois ?

2.2 Les deux seuils correspondent-ils à ce que la mairie est en mesure d'absorber ? Un
seuil bas désigne beaucoup de commerces et sature les tournées ; un seuil haut n'en
désigne presque aucun. La bonne valeur dépend du nombre d'agents et de la taille des
tournées, pas d'un principe.

## 3. Ce qui doit être neutralisé

3.1 Un commerce **exonéré** ou couvert par une **décision dérogatoire** doit-il être
écarté du calcul, ou compté comme à jour ? Le code livré l'écarte : une exonération est
une décision de la mairie, pas un comportement du commerçant.

3.2 Une **contestation en cours** doit-elle suspendre l'indicateur pour la période
contestée ? Le code livré la traite comme un motif de neutralisation : tant que le
montant est discuté, le non-paiement n'est pas un défaut. À confirmer.

3.3 Un commerce **archivé** en cours de période — fermé, déménagé — doit-il conserver ses
observations passées ? Le code les conserve : elles décrivent une réalité qui a eu lieu.

## 4. Durée de conservation

4.1 Combien de temps la mairie souhaite-t-elle garder les observations mensuelles ? Elles
sont nominatives par rattachement au commerce et au redevable. La minimisation (principe
VI de la constitution) demande une durée bornée et justifiée, pas une conservation
indéfinie par défaut.

4.2 Un commerçant qui demande à consulter ce que le système retient de lui doit-il obtenir
la liste de ses observations ? Le portail ne l'expose pas aujourd'hui.

---

## Ce qui a déjà été tranché

- **Périmètre** (08/09/2026, commanditaire) : mairie seule, pour ordonner les visites.
  L'agent de terrain continue de voir un *motif* de visite en clair — « paiement
  interrompu » — jamais une note. Un agent qui lit « risque élevé » sur son téléphone ne
  parle pas de la même façon au commerçant qu'il visite.
- **Méthode** (08/09/2026, commanditaire) : règles explicites et pondérations en base.
  Pas de modèle appris : il n'y a rien à apprendre sur une seule période, et un modèle
  appris n'explique pas sa sortie au commerçant qui conteste.
