# Les pages du tableau de bord s'ouvrent-elles ?

```bash
# Les deux services doivent tourner
cd apps/api       && DB_NAME=gtfc_recette npm start
cd apps/dashboard && npx next start

# Puis, dans un troisième terminal
cd apps/dashboard && npm test
```

## Pourquoi un vrai navigateur

Le seul défaut qu'on avait trouvé dans ce tableau de bord mettait une page
entière hors service : une variable retirée avec les espèces, dont l'usage
était resté. La compilation passait. L'analyse statique ne voyait rien. Le
défaut ne survenait qu'**après le chargement des données**, quand le composant
atteignait enfin la ligne fautive.

Un rendu simulé n'exécute pas les effets, donc ne charge rien, donc n'atteint
jamais ce code. Il fallait un navigateur.

## Ce que ces tests exigent

Deux choses, et la seconde a été apprise à ses dépens.

**Que la page s'ouvre** : aucune exception, aucune erreur en console, et le
chargement se termine. Une page qui reste en chargement pour toujours échoue —
c'est ainsi que la page des rues s'est trahie, après avoir déballé deux fois
l'enveloppe des réponses.

**Qu'elle porte des données**. « S'affiche sans erreur » est trop faible : la
page des redevables faisait la même erreur de déballage et rendait une liste
VIDE, sans la moindre alerte. Un premier jet de ce test la déclarait bonne.
Chaque page a donc un repère à trouver dans son texte, et pour les listes ce
repère exige un compte NON NUL — « 0 redevable » satisfaisait la version
précédente.

Une page qui s'ouvre sur rien n'est pas une page qui marche.

## Les comptes utilisés

Ceux du jeu de démonstration, mot de passe `GtfcDemo2026!` :

| Profil | Numéro | Ce qu'il éprouve |
|---|---|---|
| Chef de projet | `+221700000004` | il voit tout le dispositif |
| Administrateur | `+221700000002` | paramètres et communes |
| Maire | `+221700000005` | consultation seule, pas de paramètres |

En cas d'échec, une capture d'écran et une trace sont écrites dans
`test-results/`. La trace s'ouvre avec `npx playwright show-trace`.

## Le portail du redevable

`portail.spec.js` éprouve les deux surfaces qu'un commerçant — ou un passant —
atteint sans qu'aucun agent ne soit présent.

Ce qui y est vérifié n'est pas que le portail « marche », mais qu'il **ne
s'ouvre pas quand il ne devrait pas** : un numéro inconnu reçoit exactement la
même réponse qu'un numéro connu, un code faux n'ouvre rien, et l'adresse du
dossier ne suffit pas sans session.

Le portail exige un numéro VÉRIFIÉ par un agent. Le jeu de démonstration n'en
comptait aucun, si bien que la fonctionnalité entière restait derrière une
porte que rien n'ouvrait — le seed 0014 en vérifie cinq.

Pour la page publique d'un sticker, fournir un jeton :

```bash
QR_JETON=$(psql -q gtfc_recette -At -c "SELECT jeton FROM app.qr_code WHERE actif LIMIT 1") \
  npx playwright test
```
