# Tuiles cartographiques servies par la commune

La carte du tableau de bord et celle de l'application agent chargent leurs
tuiles depuis **le serveur communal**, jamais depuis un service étranger.

## Pourquoi

Trois raisons, dans l'ordre où elles mordent.

**La politique d'usage d'OpenStreetMap proscrit l'usage systématique** de ses
serveurs de tuiles par une application. Un système en production, avec des
agents qui ouvrent la carte des centaines de fois par jour, s'y ferait
bloquer — par mesure, pas par principe.

**Chaque affichage révélerait à un tiers où et quand la commune inspecte.**
L'adresse de l'agent et les coordonnées consultées partiraient à l'étranger.
Sur un système fiscal, c'est une fuite d'information opérationnelle.

**Sans lien international, la carte serait blanche.** À Dakar, ce lien n'est
pas garanti, et l'application agent doit fonctionner hors ligne.

Les **données** restent celles d'OpenStreetMap, sous licence ODbL, avec
l'attribution qu'elle impose. Ce sont les **tuiles** qui deviennent locales.

## Ce qui se passe sans tuiles

Rien de grave, et c'est délibéré. Les rues et les commerces se dessinent
quand même — ce sont nos données, pas celles du serveur de tuiles. Le
tableau de bord affiche un bandeau discret, l'application agent le dit
également. Le recensement n'est jamais bloqué par un fond de plan absent.

## Produire les tuiles

```bash
bash infra/tuiles/generer.sh
```

Le script fait tout : extrait régional, découpe sur l'emprise de la commune,
rendu, découpe en fichiers. Il vérifie d'abord que les outils sont là et
refuse de commencer sinon — un échec à mi-parcours laisserait 800 Mo d'extrait
et pas une tuile.

Il bascule le nouveau jeu en une fois et conserve l'ancien : personne ne voit
un arbre à moitié écrit, et le retour en arrière tient en un `mv`.

Prérequis, sur Ubuntu :

```bash
sudo apt-get install -y curl osmium-tool tilemaker
pip3 install mbutil
```

Zoom 14 à 19 par défaut. Pour 2 km², compter quelques centaines de mégaoctets.
L'emprise et les zooms se règlent par variables d'environnement — voir
l'en-tête du script.

### Depuis une orthophoto — précision de 2 à 5 cm

Le jour où la commune disposera d'une orthophoto par drone :

```bash
gdal2tiles.py -z 14-21 --xyz orthophoto.tif /var/www/tuiles
```

**Rien à changer dans le code** : c'est la même URL, un autre contenu.

## Servir

```nginx
location /tuiles/ {
    alias /var/www/tuiles/;
    expires 30d;
    add_header Cache-Control "public, immutable";
    try_files $uri =204;   # une tuile absente n'est pas une erreur
}
```

Le `204` compte : une tuile manquante en bordure de zone ne doit pas remplir
le journal d'erreurs ni alarmer l'utilisateur.

## Configuration

| Variable | Où | Valeur |
|---|---|---|
| `NEXT_PUBLIC_TUILES_URL` | tableau de bord | `/tuiles/{z}/{x}/{y}.png` |
| `EXPO_PUBLIC_TUILES_URL` | application agent | `https://gtfc.domaine.sn/tuiles/{z}/{x}/{y}.png` |

L'application agent peut rester sans tuiles : elle dessine le tracé des rues,
embarqué hors ligne, qui pèse 22 ko pour toute la commune.
