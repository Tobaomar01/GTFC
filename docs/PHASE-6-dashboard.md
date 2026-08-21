# Phase 6 — Tableau de bord web

**Objectif** : l'écran que voit la mairie — carte OpenStreetMap vert/orange/rouge,
statistiques par zone, quartier, agent et type de taxe, suivi des agents, journal
d'audit, gestion multi-communes, exports Excel et PDF.

**Deux captures d'écran sont dans [`exemples/`](exemples/)** — regardez-les
avant de lire la suite.

---

## Ce que j'ai généré

```
apps/dashboard/                  Next.js 16 + Tailwind — 22 fichiers
├── src/app/
│   ├── api/session/             Connexion / déconnexion (pose les cookies)
│   ├── api/proxy/[...chemin]/   Mandataire vers l'API
│   ├── connexion/
│   ├── (prive)/                 7 pages authentifiées
│   ├── c/[jeton]/               Scan public d'un QR — sans compte
│   └── q/[jeton]/               Vérification publique d'une quittance
├── src/composants/              ui · graphiques · Carte (Leaflet) · Coquille
└── src/lib/                     session (serveur) · api (client) · format

apps/api/src/services/export.service.js   Excel et PDF
apps/api/src/routes/documents.routes.js   4 routes d'export ajoutées
```

Nouvelle dépendance côté API : **exceljs**. `npm audit` : **0 vulnérabilité**
sur les deux applications.

---

## Trois décisions qui structurent le reste

### 1. Le navigateur ne voit jamais le jeton

Le dashboard ne parle **jamais** directement à l'API. Le navigateur appelle le
serveur Next.js (même origine), qui garde les jetons dans des cookies
`httpOnly` et les transmet à l'API sur `127.0.0.1`.

Une faille XSS dans le dashboard ne permet donc pas de voler une session : du
JavaScript ne peut pas lire un cookie `httpOnly`. Sur une application fiscale,
c'est décisif. Bénéfices secondaires : plus aucune question de CORS, et le
rafraîchissement du jeton est invisible pour l'interface.

Le mandataire **refuse explicitement** de relayer `/auth/login` et
`/auth/refresh` : sinon l'interface pourrait récupérer un jeton en clair, ce
que toute l'architecture cherche à empêcher.

Coût : un saut réseau de plus, sur la même machine. Négligeable.

### 2. Les exports sont produits par l'API, pas par le dashboard

L'isolation multi-communes est déjà garantie côté API par les politiques RLS.
La refaire dans le dashboard serait une seconde occasion de se tromper. Et
chaque export est tracé dans `audit.export` : une liste de commerces avec les
montants dus quitte le système, cela doit laisser une trace.

Le dashboard ne fait que déclencher le téléchargement ; le nom du fichier vient
de l'API.

### 3. Les couleurs ont été calculées, pas choisies

Les couleurs de statut sont imposées par le cahier des charges (vert / orange /
rouge). Je les ai **validées** au lieu de les supposer bonnes :

| Rôle | Clair | Sombre |
|---|---|---|
| À jour | `#1D7A45` | `#37A46B` |
| Paiement partiel | `#CF8000` | `#C68200` |
| Impayé | `#B3261E` | `#D4455C` |

Les six contrôles passent dans les **deux modes**, sans bande d'avertissement :

```
clair  (surface #FFFFFF) — daltonisme ΔE 10,1 · vision normale ΔE 20,1
sombre (surface #1A1A19) — daltonisme ΔE  8,3 · vision normale ΔE 16,9
```

L'orange d'origine (`#C77700`) échouait : ΔE 7,7 contre le vert sous
protanopie, sous le seuil de 8. Un pas plus clair — `#CF8000` — le fait passer
à 10,1 sans perdre le contraste. **L'application Android a été alignée sur cette
valeur** : les deux écrans doivent raconter la même chose.

Le mode sombre n'est pas une inversion automatique : ce sont des pas choisis
pour la surface sombre, puis validés comme un ensemble.

Pour revalider après une modification :

```bash
node <chemin-du-validateur>/validate_palette.js "#1D7A45,#CF8000,#B3261E" \
     --mode light --surface "#FFFFFF"
node <chemin-du-validateur>/validate_palette.js "#37A46B,#C68200,#D4455C" \
     --mode dark  --surface "#1A1A19"
```

**Et la couleur ne porte jamais seule.** Chaque statut est accompagné d'un
symbole (`✓ ◐ !`) et de son libellé, une légende est présente dès deux séries,
et chaque graphique a sa **vue tableau**. L'écran reste lisible par un
daltonien, en impression noir et blanc et en contraste forcé.

### Les formes ont été choisies avant les couleurs

- un chiffre isolé est une **tuile**, jamais un graphique à une barre ;
- le taux de recouvrement est le **chiffre phare** de la page ;
- la situation par zone est une part-à-tout → **barre empilée**, aux couleurs
  de statut parce que les segments signifient bon/mauvais ;
- la répartition par taxe est une comparaison de grandeurs → barres d'une
  **seule teinte**. Les colorer selon leur valeur ré-encoderait leur longueur
  et gaspillerait le seul canal libre.

---

## Ce que vous devez faire

### Étape 1 — Déployer et compiler

```powershell
scp -r apps docs ecosystem.config.js gtfc@<serveur>:~/gtfc-platform/
```

```bash
cd ~/gtfc-platform/apps/api && npm ci --omit=dev && cd ../..
cd apps/dashboard && npm ci && npm run build && cd ../..
```

> `npm run build` est **obligatoire** : PM2 lance `next start`, qui refuse de
> démarrer sans build de production. À refaire à chaque mise à jour du code.

### Étape 2 — Démarrer

```bash
pm2 startOrRestart ecosystem.config.js
pm2 save
pm2 status          # gtfc-api, gtfc-dashboard, gtfc-scheduler en « online »
```

Le `502` de la phase 1 sur `gtfc.VOTRE-DOMAINE` doit maintenant avoir disparu.

### Étape 3 — Vérifier

Ouvrez `https://gtfc.VOTRE-DOMAINE` et connectez-vous avec un compte
**superviseur ou administrateur** — un compte agent est refusé, avec un message
qui renvoie vers l'application Android.

Parcours de contrôle :

1. **Vue d'ensemble** : taux de recouvrement, tuiles, situation par zone
2. **Carte** : les marqueurs sont colorés et groupés ; cliquez-en un
3. Filtrez par zone → la carte ET le tableau se réduisent ensemble
4. Basculez le thème (bouton en haut à droite) : trois états — système, clair,
   sombre
5. **Recouvrement** : générez, émettez, lancez la campagne
6. **Journal d'audit** : cliquez un enregistrement → l'avant/après s'affiche
7. Un export Excel se télécharge, un PDF s'ouvre dans un onglet

### Étape 4 — La page publique des QR codes

L'URL imprimée sur les stickers pointe vers ce dashboard :

```
https://gtfc.VOTRE-DOMAINE/c/<jeton>
```

Scannez un sticker avec l'appareil photo d'un téléphone, **sans être
connecté**. La page doit s'afficher et ne montrer **aucune** donnée fiscale :
ni montant, ni situation de paiement, ni nom du gérant. Un passant ne doit pas
pouvoir savoir qui est en retard en scannant les devantures d'une rue.

---

## Critères de validation de la phase 6

- [ ] `pm2 status` : les trois services en `online`
- [ ] `https://gtfc.VOTRE-DOMAINE` affiche l'écran de connexion avec le nom de la commune
- [ ] Un compte **agent** est refusé avec un message clair
- [ ] La carte affiche les marqueurs groupés, colorés, avec la légende
- [ ] Les filtres cadrent la carte **et** le tableau
- [ ] Le thème sombre s'applique (y compris aux tuiles de la carte)
- [ ] Chaque graphique bascule en vue tableau
- [ ] L'export Excel des commerces se télécharge et s'ouvre
- [ ] `/c/<jeton>` fonctionne **sans session** et ne divulgue rien de fiscal
- [ ] Après déconnexion, une page protégée redirige vers la connexion

---

## Ce que j'ai vérifié

**42 tests de bout en bout, tous verts**, contre le dashboard réellement
compilé et démarré, relié à l'API et à une base peuplée (60 commerces,
38 liens de paiement, 26 paiements simulés).

Sécurité de session : aucun jeton dans la réponse envoyée au navigateur, cookie
`httpOnly` et `SameSite`, mandataire refusant `/auth/login` et `/auth/refresh`,
`401` sans session, redirection après déconnexion.

Palette : les hexadécimaux validés sont bien présents dans la feuille compilée,
dans les deux modes, et le mode sombre couvre à la fois le réglage système et
la bascule explicite.

**Et j'ai regardé le résultat.** 14 captures d'écran (7 pages × 2 thèmes, plus
une largeur tablette), avec contrôle automatique du débordement horizontal et
du texte rogné : **0 débordement, 0 erreur de chargement**.

### Trois défauts trouvés — dont un que seule la capture révélait

1. **La vérification d'une quittance inconnue affichait « Paiement annulé ».**
   L'API distingue bien les trois cas ; la page les confondait. Quelqu'un
   présentant un faux document aurait lu l'inverse du message attendu.
2. **La page Recouvrement faisait 5 834 px de haut** : la liste des messages à
   transmettre affichait 38 lignes avec l'URL de paiement complète. Ramenée à
   15 lignes et un lien abrégé — 2 559 px. Invisible dans les tests, évident
   sur la capture.
3. **`output: 'standalone'` était incompatible avec `next start`**, que PM2
   lance. Le service serait resté en erreur au premier démarrage réel.

### Deux points corrigés au passage

- **Next.js envoyait de la télémétrie anonyme** — contraire au « 100 %
  auto-hébergé » du cahier des charges. Coupée dans les scripts et dans PM2.
- **Next 15 embarquait un `postcss` et un `sharp` vulnérables.** Passage à
  Next 16 : 0 vulnérabilité.

Non-régression : les 53 tests de la phase 3, les 14 tests photos, les 28 du
protocole mobile et les 38 de la phase 5 passent toujours.

---

## Ce que le dashboard n'appelle pas

Un seul appel sortant : les **tuiles OpenStreetMap**. La politique de sécurité
de contenu (`next.config.js`) l'inscrit explicitement et interdit tout le
reste — ni police distante, ni script tiers, ni service d'analyse.

En mode sombre, les tuiles sont assombries par un filtre CSS plutôt que par un
second fond de carte : aucun appel réseau supplémentaire.

---

## Ensuite

La **phase 7 — tests terrain et déploiement** : APK Android signé, tests avec
les 3 agents pilotes, passage de Wave en production, dépôt sur Google Play,
impression et distribution des stickers, formation des agents.

Rappel qui vaut toujours : les barèmes du jeu initial sont inventés. Le
dashboard affiche d'ailleurs le compte des données provisoires en tête de la
vue d'ensemble, et la page Paramètres en donne le détail. **98 lignes** à
remplacer avant qu'un seul avis ne parte à un commerçant.
