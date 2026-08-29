#!/usr/bin/env node
/**
 * Fige Leaflet dans un module JavaScript, pour que la carte fonctionne sans
 * réseau et sans script distant.
 *
 * Charger Leaflet depuis un CDN reviendrait à rendre la carte dépendante
 * d'un serveur étranger — ce que la souveraineté des données interdit, et ce
 * qui la rendrait de toute façon inutilisable hors ligne, où l'agent en a
 * précisément le plus besoin.
 *
 *   node outils/generer-leaflet-embarque.js
 *
 * À relancer après toute mise à jour du paquet leaflet.
 */
const fs = require('node:fs');
const path = require('node:path');

const dist = path.resolve(__dirname, '../node_modules/leaflet/dist');
const sortie = path.resolve(__dirname, '../src/composants/leaflet-embarque.js');

const css = fs.readFileSync(path.join(dist, 'leaflet.css'), 'utf8');
const js = fs.readFileSync(path.join(dist, 'leaflet.js'), 'utf8');
const version = require(path.resolve(__dirname, '../node_modules/leaflet/package.json')).version;

// Les images d'interface de Leaflet sont référencées en chemin relatif dans
// son CSS. Hors serveur, elles ne se résolvent pas : on les neutralise et on
// dessine nos propres commandes.
const cssNettoye = css.replace(/url\((['"]?)images\/[^)]+\1\)/g, 'none');

const echapper = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

fs.writeFileSync(sortie, `/**
 * Leaflet ${version}, figé pour l'embarquement.
 *
 * FICHIER GÉNÉRÉ — ne pas modifier à la main.
 * Régénérer : node outils/generer-leaflet-embarque.js
 *
 * Pourquoi embarquer plutôt que charger depuis un CDN : la carte doit
 * fonctionner hors ligne, là où l'agent en a le plus besoin, et sans
 * dépendre d'un serveur étranger.
 */
export const LEAFLET_VERSION = '${version}';
export const LEAFLET_CSS = \`${echapper(cssNettoye)}\`;
export const LEAFLET_JS = \`${echapper(js)}\`;
`);

const ko = Math.round(fs.statSync(sortie).size / 1024);
console.log(`  ✓ leaflet-embarque.js — Leaflet ${version}, ${ko} Ko`);
