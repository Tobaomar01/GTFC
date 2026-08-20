# Ressources graphiques

Les trois PNG de ce dossier sont des **aplats verts provisoires**. Ils
permettent à `expo start` et à `eas build` de fonctionner — Expo refuse de
démarrer si un fichier référencé dans `app.json` est absent — mais ils ne
constituent pas une identité visuelle.

| Fichier | Usage | Dimensions attendues |
|---|---|---|
| `icone.png` | Icône de l'application | 1024 × 1024 px, sans transparence |
| `icone-adaptative.png` | Avant-plan de l'icône adaptative Android | 1024 × 1024 px, **motif centré dans un cercle de 660 px** |
| `splash.png` | Écran de démarrage | 1284 × 2778 px ou logo centré sur fond uni |

## À faire avant le dépôt sur Google Play

Remplacez ces fichiers par le visuel officiel de la commune :

1. demandez à la mairie son logo en vectoriel (SVG ou AI) ;
2. exportez aux dimensions ci-dessus, fond vert `#0B5D2B` ;
3. pour `icone-adaptative.png`, gardez le motif dans le cercle central :
   Android rogne les bords selon le lanceur du téléphone, et un logo qui
   touche les bords se retrouve amputé sur certains appareils ;
4. relancez `npx expo prebuild --clean` puis un nouveau build EAS.

Google Play refuse une application dont l'icône est un aplat uni : ce
remplacement est donc **bloquant pour la phase 7**, pas seulement esthétique.
