# Tests d'intégration

Ces tests parlent à une **vraie base PostgreSQL**. C'est délibéré.

Quatre défauts de facturation ont échappé à la relecture et à l'analyseur
syntaxique de PostgreSQL, et n'ont été trouvés qu'en exécutant :

1. un seed violait une contrainte ajoutée par une migration, faisant tomber
   les quatre seeds suivants en cascade ;
2. la sélection des taxes ne retenait rien sur une période annuelle — un
   commerce recensé en cours d'année n'aurait jamais été facturé ;
3. la mise à l'échelle annuelle divisait au lieu de multiplier, sous-facturant
   d'un facteur douze ;
4. le prorata comptait depuis janvier, signalant en retard des redevables
   parfaitement à jour — et déclenchant des relances injustifiées.

Trois d'entre eux touchaient à l'argent. Un test qui simule la base ne les
aurait pas vus davantage qu'une relecture.

## Préparer la base

```bash
createdb gtfc_recette
DATABASE_URL=postgres://localhost/gtfc_recette ./db/migrate.sh
```

## Lancer

```bash
cd apps/api && npm run test:recette
```

Ou en visant une autre base :

```bash
DATABASE_URL_TEST=postgres://localhost/ma_base npm run test:recette
```

## Ce que ces tests verrouillent

Ils ne décrivent pas ce que le code fait : ils **verrouillent des décisions**.
Les faire échouer doit demander une décision, pas un correctif distrait.

| Fichier | Objet |
|---|---|
| `conformite.test.js` | Les six principes de la constitution et les décisions du commanditaire |
| `facturation.test.js` | Liquidation annuelle, prorata, solde — les quatre défauts ci-dessus |
| `ussd.test.js` | Confidentialité du canal USSD et contraintes d'encodage |

Le test le plus important est celui du **silence USSD** : une réponse qui
différerait entre un numéro inconnu et un numéro non vérifié permettrait
d'énumérer les redevables de la commune en composant au hasard.
