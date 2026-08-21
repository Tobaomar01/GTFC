#!/usr/bin/env node
/**
 * Constitution du référentiel des rues à partir d'OpenStreetMap.
 *
 *   node db/importer-rues-osm.js --extraire        télécharge et prépare
 *   node db/importer-rues-osm.js --apercu          ce qui sera importé
 *   node db/importer-rues-osm.js --importer        envoie à l'API
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  CE QUE CET OUTIL FAIT, ET CE QU'IL NE FAIT PAS
 *
 *  Il fournit LA MOITIÉ du travail de la phase 0. Le document demande de
 *  croiser trois sources : OpenStreetMap, la carte du PDC 2021-2025, et le
 *  plan de voirie communal. Celui-ci ne connaît que la première.
 *
 *  Les rues du PDC absentes d'OpenStreetMap — et il y en aura — devront être
 *  ajoutées à la main. Inversement, OSM contient des voies que la commune ne
 *  reconnaît peut-être pas comme des rues.
 *
 *  LA VALIDATION REVIENT À LA MAIRIE. Le document est explicite : sans elle,
 *  les statistiques par rue seront contestables. Chaque rue importée est
 *  donc marquée à valider, et apparaît dans l'inventaire des données à
 *  compléter jusqu'à ce que quelqu'un les ait relues.
 *
 *  RIEN N'EST INVENTÉ. Ce fichier ne contient aucun nom de rue écrit par
 *  moi : tout vient d'OSM, et ce qui n'y est pas reste absent.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  LA RÉCONCILIATION DES GRAPHIES
 *
 *  OpenStreetMap contient « Rocade Fann Bel Air », « Rocade Fann Bel-Air »
 *  et « Rocade Fann-Bel Air » — trois tronçons de la même rocade, saisis par
 *  trois contributeurs. Les importer tels quels donnerait trois rues, et le
 *  taux de collecte de cette voie serait réparti entre elles.
 *
 *  Les noms sont donc rapprochés sur leur forme normalisée — sans accents,
 *  sans ponctuation, sans casse. La graphie la plus fréquente est retenue,
 *  les autres deviennent des variantes de recherche : l'agent qui tape ce
 *  qu'il lit sur la plaque retrouve la rue quand même.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const RACINE = path.resolve(__dirname, '..');
const SORTIE = path.join(__dirname, 'donnees-reelles', 'rues-osm.json');

// Relation OpenStreetMap de la commune, trouvée par :
//   relation["boundary"="administrative"]["name"~"Gueule.*Tap"];
const RELATION_OSM = Number(process.env.OSM_RELATION || 12989254);
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

const C = {
  gras: (t) => `\x1b[1m${t}\x1b[0m`,
  vert: (t) => `\x1b[32m${t}\x1b[0m`,
  rouge: (t) => `\x1b[31m${t}\x1b[0m`,
  jaune: (t) => `\x1b[33m${t}\x1b[0m`,
  gris: (t) => `\x1b[90m${t}\x1b[0m`,
};

/** Forme de comparaison : sans accents, sans ponctuation, sans casse. */
const normaliser = (t) => String(t ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const TYPES_VOIE = [
  [/^(autoroute)\b/, 'route'],
  [/^(boulevard|bd)\b/, 'boulevard'],
  [/^(avenue|av)\b/, 'avenue'],
  [/^(allees?|allee)\b/, 'rue'],
  [/^(impasse|impass)\b/, 'impasse'],
  [/^(place|rond point|rondpoint)\b/, 'place'],
  [/^(rocade|route)\b/, 'route'],
  [/^(ruelle)\b/, 'ruelle'],
  [/^(rue)\b/, 'rue'],
];

/**
 * Sépare le type de voie du reste du nom.
 *
 * « Rue CO-40 » donne { type: 'rue', noyau: 'co 40' } et « CO-40 » donne
 * { type: null, noyau: 'co 40' } : les deux se rapprochent alors, ce qui est
 * bien le même axe écrit deux fois.
 */
function decomposer(nom) {
  let reste = normaliser(nom);
  let type = null;

  for (const [motif, valeur] of TYPES_VOIE) {
    const m = reste.match(motif);
    if (m) { type = valeur; reste = reste.slice(m[0].length).trim(); break; }
  }

  // Articles et particules : ils varient d'un contributeur à l'autre et ne
  // distinguent jamais deux voies réelles.
  const noyau = reste.split(' ')
    .filter((mot) => !['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au'].includes(mot))
    .join(' ')
    .trim();

  return { type, noyau: noyau || reste };
}

/**
 * Code court et STABLE, dérivé du nom.
 *
 * Stable parce qu'une réextraction ne doit pas renuméroter les rues : les
 * commerces déjà recensés y sont rattachés, et un compteur séquentiel
 * casserait ce lien au premier réimport.
 *
 * Lisible parce que l'agent le voit dans sa liste et l'entend au téléphone :
 * « FA-24 » se transmet, « VOIE-17 » ne dit rien.
 */
function codeDepuisNom(nom, pris) {
  const { type, noyau } = decomposer(nom);
  let base;

  // Les voies déjà codifiées à la manière du PDC : « FA-24 », « CO 40 »,
  // « FA-15-03 ». Le sous-numéro fait partie de la désignation : c'est lui
  // qui distingue deux tronçons voisins sur le terrain.
  const codifie = noyau.match(/\b([a-z]{2})[ -]?(\d{1,3})(?:[ -](\d{1,3}))?\b/);
  // Une rue désignée par son seul numéro : « Rue 34 ».
  const numerote = noyau.match(/^(\d{1,3})$/);

  if (codifie) {
    base = `${codifie[1].toUpperCase()}-${codifie[2].padStart(2, '0')}`;
    if (codifie[3]) base += `-${codifie[3].padStart(2, '0')}`;
  } else if (numerote) {
    // Préfixe R pour « rue » : sans lui, « 34 » se confondrait avec un
    // numéro de séquence dans les exports.
    base = `R-${numerote[1].padStart(2, '0')}`;
  } else {
    const mots = noyau.split(' ').filter((m) => m.length > 2);
    const abrege = mots.slice(0, 2).map((m) => m.slice(0, 4)).join('-').toUpperCase();
    const prefixe = { boulevard: 'BD', avenue: 'AV', route: 'RT', place: 'PL', impasse: 'IMP' }[type];
    base = prefixe ? `${prefixe}-${abrege}` : (abrege || 'VOIE');
  }

  let code = base;
  let n = 2;
  while (pris.has(code)) { code = `${base}-${n}`; n += 1; }
  pris.add(code);
  return code;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
async function extraire() {
  const requete = `[out:json][timeout:180];
area(${3600000000 + RELATION_OSM})->.commune;
way["highway"]["name"](area.commune);
out tags geom;`;

  console.log(`\n${C.gras('Extraction OpenStreetMap')}`);
  console.log(`  ${C.gris(`relation ${RELATION_OSM} · ${OVERPASS}`)}\n`);

  const reponse = await fetch(OVERPASS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Overpass est un service bénévole et partagé : il refuse par un 406
      // les appels qui ne s'identifient pas. Un message d'erreur qui ne dit
      // rien, pour une règle qui se comprend — on ne consomme pas
      // anonymement une ressource offerte.
      'User-Agent': 'GTFC-referentiel-rues/1.0 (plateforme de collecte des taxes locales)',
    },
    body: new URLSearchParams({ data: requete }),
  });

  if (!reponse.ok) {
    throw new Error(`Overpass a répondu ${reponse.status}. Réessayez dans quelques minutes : `
      + 'le service est partagé et limite les requêtes.');
  }

  const brut = await reponse.json();
  const segments = brut.elements ?? [];
  if (segments.length === 0) {
    throw new Error('Aucune voie trouvée. Vérifiez OSM_RELATION.');
  }
  console.log(`  ${segments.length} tronçon(s) nommé(s) reçus`);

  // --- Regroupement par nom normalisé -------------------------------------
  const groupes = new Map();
  for (const s of segments) {
    const nom = s.tags?.name;
    if (!nom) continue;
    // Le noyau ET le type servent de clé : « Rue de Fann » et « Route de
    // Fann » ne sont PAS rapprochées, parce que ce sont peut-être deux voies
    // distinctes et que trancher revient à la mairie. En revanche « CO-40 »
    // rejoint « Rue CO-40 », l'un des deux n'ayant pas de type.
    const { type, noyau } = decomposer(nom);
    const cle = noyau;
    if (!groupes.has(cle)) groupes.set(cle, { graphies: new Map(), troncons: [], types: new Set() });
    const g = groupes.get(cle);
    g.graphies.set(nom, (g.graphies.get(nom) ?? 0) + 1);
    if (type) g.types.add(type);
    if (Array.isArray(s.geometry) && s.geometry.length >= 2) {
      g.troncons.push(s.geometry.map((p) => [p.lon, p.lat]));
    }
  }

  // --- Une rue par groupe --------------------------------------------------
  const pris = new Set();
  const rues = [];

  for (const [, g] of [...groupes.entries()].sort((a, b) => a[0].localeCompare(b[0], 'fr'))) {
    // La graphie la plus fréquente l'emporte. À égalité, la plus longue :
    // « Rocade Fann Bel-Air » est plus informative que « Rocade Fann ».
    const classees = [...g.graphies.entries()]
      .sort((a, b) => (b[1] - a[1])
        // À fréquence égale, la graphie qui nomme le type de voie l'emporte :
        // « Rue CO-40 » se lit mieux que « CO-40 » dans une liste.
        || (Number(Boolean(decomposer(b[0]).type)) - Number(Boolean(decomposer(a[0]).type)))
        || (b[0].length - a[0].length));
    const [retenu] = classees[0];
    const variantes = classees.slice(1).map(([v]) => v);

    rues.push({
      code: codeDepuisNom(retenu, pris),
      nom: retenu,
      type_voie: decomposer(retenu).type ?? 'rue',
      variantes,
      nb_troncons: g.troncons.length,
      geometrie: g.troncons.length > 0
        ? { type: 'MultiLineString', coordinates: g.troncons }
        : undefined,
    });
  }

  fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
  fs.writeFileSync(SORTIE, JSON.stringify({
    source: 'osm',
    relation_osm: RELATION_OSM,
    extrait_le: new Date().toISOString(),
    rues,
  }, null, 2), 'utf8');

  const avecVariantes = rues.filter((r) => r.variantes.length > 0);
  console.log(`  ${C.vert(`${rues.length} voie(s) distincte(s)`)}`);
  console.log(`  ${avecVariantes.length} avec plusieurs graphies réconciliées`);
  console.log(`  ${rues.filter((r) => r.geometrie).length} avec tracé\n`);
  console.log(`  Écrit dans ${C.gris(path.relative(RACINE, SORTIE))}\n`);
  console.log(`  Étape suivante : ${C.gras('node db/importer-rues-osm.js --apercu')}\n`);

  return rues;
}

// ---------------------------------------------------------------------------
// Aperçu
// ---------------------------------------------------------------------------
function apercu() {
  if (!fs.existsSync(SORTIE)) {
    console.error(C.rouge('\n  Rien à afficher. Lancez d\'abord --extraire\n'));
    process.exit(1);
  }
  const { rues, extrait_le: extraitLe } = JSON.parse(fs.readFileSync(SORTIE, 'utf8'));

  console.log(`\n${C.gras(`${rues.length} voies`)}  ${C.gris(`extraites le ${new Date(extraitLe).toLocaleString('fr-FR')}`)}\n`);

  for (const r of rues) {
    const trace = r.geometrie ? '' : C.jaune('  (sans tracé)');
    console.log(`  ${C.gras(r.code.padEnd(10))} ${r.nom}${trace}`);
    if (r.variantes.length > 0) {
      console.log(`  ${' '.repeat(10)} ${C.gris(`aussi écrit : ${r.variantes.join(' · ')}`)}`);
    }
  }

  const doublons = rues.filter((r) => r.variantes.length > 0);
  console.log(`\n${C.gras('À relire par la mairie')}`);
  console.log(`  · ${doublons.length} voie(s) avaient plusieurs graphies dans OpenStreetMap.`);
  console.log(`    La plus fréquente a été retenue ; les autres restent`);
  console.log('    consultables et servent à la recherche des agents.');
  console.log('  · Les rues du PDC absentes d\'OpenStreetMap ne sont PAS ici.');
  console.log('    Comparez avec la carte du PDC avant de valider.\n');
  console.log(`  Étape suivante : ${C.gras('node db/importer-rues-osm.js --importer')}\n`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function importer() {
  if (!fs.existsSync(SORTIE)) {
    console.error(C.rouge('\n  Rien à importer. Lancez d\'abord --extraire\n'));
    process.exit(1);
  }
  const { rues } = JSON.parse(fs.readFileSync(SORTIE, 'utf8'));

  const api = process.env.API_URL || 'http://127.0.0.1:4000';
  const identifiant = process.env.RECETTE_TEL;
  const motDePasse = process.env.RECETTE_MDP;

  if (!identifiant || !motDePasse) {
    console.error(C.rouge('\n  Identifiants manquants.'));
    console.error(C.gris('  RECETTE_TEL=+221... RECETTE_MDP=... node db/importer-rues-osm.js --importer\n'));
    process.exit(1);
  }

  const co = await fetch(`${api}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ telephone: identifiant, mot_de_passe: motDePasse }),
  });
  if (!co.ok) {
    console.error(C.rouge(`\n  Connexion refusée (${co.status})\n`));
    process.exit(1);
  }
  const session = await co.json();
  const jeton = session.donnees.jeton_acces ?? session.donnees.acces;

  // L'API plafonne un lot à 2 000 rues ; on découpe par prudence sur une
  // connexion lente, où une requête trop longue expire.
  const LOT = 200;
  let crees = 0; let traces = 0; let inchangees = 0;

  for (let i = 0; i < rues.length; i += LOT) {
    const tranche = rues.slice(i, i + LOT).map(({ nb_troncons: _n, ...r }) => r);
    const r = await fetch(`${api}/rues/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jeton}` },
      body: JSON.stringify({ source: 'osm', rues: tranche }),
    });
    const corps = await r.json().catch(() => null);
    if (!r.ok) {
      console.error(C.rouge(`\n  Import refusé (${r.status})`));
      console.error(`  ${JSON.stringify(corps?.erreur ?? corps).slice(0, 300)}\n`);
      process.exit(1);
    }
    crees += corps.donnees.crees;
    traces += corps.donnees.traces_completes;
    inchangees += corps.donnees.inchangees;
    process.stdout.write(`  ${Math.min(i + LOT, rues.length)}/${rues.length}\r`);
  }

  console.log(`\n\n  ${C.vert(`${crees} rue(s) créée(s)`)}`);
  console.log(`  ${traces} tracé(s) complété(s) · ${inchangees} inchangée(s)\n`);
  console.log(`  ${C.gras('Ensuite :')}`);
  console.log('    1. Faire relire la liste par la mairie — c\'est elle qui tranche');
  console.log('       les libellés, faute de quoi les statistiques par rue');
  console.log('       seront contestables.');
  console.log('    2. Ajouter les rues du PDC absentes d\'OpenStreetMap.');
  console.log('    3. Rattacher les objets déjà recensés :');
  console.log(`       ${C.gris('POST /rues/recalculer-rattachements')}\n`);
}

// ---------------------------------------------------------------------------
(async () => {
  const mode = process.argv[2];
  try {
    if (mode === '--extraire') await extraire();
    else if (mode === '--apercu') apercu();
    else if (mode === '--importer') await importer();
    else {
      console.log(`
${C.gras('Référentiel des rues depuis OpenStreetMap')}

  node db/importer-rues-osm.js --extraire     télécharge et réconcilie
  node db/importer-rues-osm.js --apercu       affiche ce qui sera importé
  node db/importer-rues-osm.js --importer     envoie à l'API

${C.gris('Ne fournit que la moitié de la phase 0 : les rues du PDC absentes')}
${C.gris('d\'OpenStreetMap doivent être ajoutées à la main, et la mairie doit')}
${C.gris('valider les libellés retenus.')}
`);
    }
  } catch (err) {
    console.error(C.rouge(`\n  ${err.message}\n`));
    process.exit(1);
  }
})();
