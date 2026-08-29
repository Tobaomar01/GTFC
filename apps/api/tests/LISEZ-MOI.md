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
| `parcours-terrain.test.js` | La chaîne complète, par l'API réelle : du lot synchronisé au QR et à l'avis |

Le test le plus important est celui du **silence USSD** : une réponse qui
différerait entre un numéro inconnu et un numéro non vérifié permettrait
d'énumérer les redevables de la commune en composant au hasard.

## Sur quelle base

L'API ne lit **pas** `DATABASE_URL` : elle compose sa connexion à partir de
`DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Les tests, eux, lisent
`DATABASE_URL_TEST`. Poser l'un sans l'autre dirige les tests vers une base et
l'application vers une autre — la panne qui s'ensuit ressemble à une violation
de clé étrangère, et non à ce qu'elle est. `aide.js` refuse désormais de
démarrer dans ce cas.

Les deux connexions sont volontairement distinctes : les tests lisent avec un
compte privilégié pour voir au-delà des politiques d'isolation, l'application
se connecte comme en production.

```bash
cd apps/api
DATABASE_URL_TEST=postgres://localhost/gtfc_recette \
DB_NAME=gtfc_recette \
node --test $(find tests -name '*.test.js')
```

## Avant un déploiement

```bash
bash scripts/verifier-installation-neuve.sh
```

Rejoue une installation depuis une base vide — extensions, rôles, toutes les
migrations, tous les seeds — puis le jeu de tests complet. C'est le seul moyen
de voir ce qu'une base de travail cache : elle porte des états qu'un serveur
neuf n'aura jamais. La première exécution a trouvé un seed qui entrait en
collision avec un déclencheur ajouté après lui.

## Chasse aux défauts dans le code

```bash
npx eslint@9 --config eslint.defauts.mjs \
  apps/api/src apps/api/scripts apps/api/tests \
  apps/dashboard/src apps/mobile/src apps/mobile/outils
```

Ne cherche pas le style : uniquement les défauts qu'aucun test ne peut voir —
un identifiant qui n'existe pas, une constante réassignée, une clé en double,
du code inatteignable.

Le tableau de bord n'a aucun test, et le seul défaut qu'on y a trouvé mettait
une page entière hors service : `especes`, resté dans le code après le retrait
des espèces. La compilation passait, l'écran plantait à l'ouverture. C'est
cette famille-là que ce contrôle rattrape.

La sortie doit rester **vide**. Un avertissement connu qu'on laisse traîner
enterre celui qui viendra ensuite.
