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

### Depuis OpenStreetMap — gratuit, immédiat

```bash
# 1. Extrait de la région, puis découpe sur la commune
wget https://download.geofabrik.de/africa/senegal-latest.osm.pbf
osmium extract -b -17.47,14.67,-17.42,14.71 senegal-latest.osm.pbf -o gtfc.osm.pbf

# 2. Rendu en tuiles vectorielles puis raster (tilemaker, ou un rendu mapnik)
tilemaker --input gtfc.osm.pbf --output tuiles.mbtiles

# 3. Découpe en fichiers servis directement par Nginx
mb-util --image_format=png tuiles.mbtiles /var/www/tuiles
```

Zoom 14 à 19. Pour 2 km², compter quelques centaines de mégaoctets.

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
