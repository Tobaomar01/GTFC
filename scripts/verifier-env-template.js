#!/usr/bin/env node
/**
 * Le modèle .env dit-il la même chose que le code ?
 *
 *   node scripts/verifier-env-template.js
 *
 * CE QUI A ÉTÉ CONSTATÉ le 09/09/2026, en préparant l'installation sur
 * serveur. Deux écarts, dans les deux sens :
 *
 *   - .env.template demandait NEXT_PUBLIC_API_URL. AUCUNE ligne de code ne la
 *     lisait. L'opérateur la renseignait avec son domaine, croyait avoir
 *     branché le tableau de bord, et n'avait rien branché du tout.
 *   - API_URL, que le tableau de bord lit vraiment, ne figurait nulle part —
 *     ni dans le modèle, ni dans docker-compose.yml. Elle retombait sur son
 *     défaut, correct par chance.
 *
 * Aucun test ne pouvait le voir : le fichier .env du poste de développement
 * existe depuis des mois et contient ce qu'il faut. L'écart n'apparaît que sur
 * une machine NEUVE, remplie à partir du modèle — c'est-à-dire en production,
 * le jour de l'installation, par quelqu'un qui n'a pas écrit le code.
 *
 * C'est la même famille que la migration qui ne s'exécute que sur la base du
 * développeur : le défaut n'est pas dans un fichier, il est dans l'écart entre
 * deux fichiers que personne ne lit ensemble.
 *
 * DEUX SENS, ET ILS NE SE VÉRIFIENT PAS DE LA MÊME FAÇON.
 *
 * « Inerte » — le modèle demande une variable que rien ne lit — se vérifie par
 * simple présence du nom ailleurs dans le dépôt. Un nom qui n'apparaît QUE
 * dans le modèle et la documentation ne peut avoir aucun effet.
 *
 * « Absente » — le code lit une variable que le modèle tait — ne se vérifie
 * honnêtement que sur le JavaScript, où la lecture s'écrit explicitement. Une
 * première version balayait aussi les scripts shell : elle a réclamé au modèle
 * cent quatre-vingts variables LOCALES à ces scripts, dont ROUGE et TOTAL. Un
 * contrôle qui crie faux finit par ne plus être lu du tout, et c'est pire que
 * pas de contrôle.
 *
 * Sortie non nulle si le modèle et le code divergent.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..');
const MODELE = path.join(RACINE, '.env.template');

/**
 * L'application mobile a son PROPRE modèle.
 *
 * Ses variables sont incrustées dans l'APK au moment de la compilation, pas
 * lues sur le serveur : elles n'ont rien à faire dans le .env d'installation,
 * et tout à faire dans celui du téléphone. Les deux fichiers forment ensemble
 * ce que l'opérateur doit renseigner.
 */
const MODELE_MOBILE = path.join(RACINE, 'apps', 'mobile', '.env.example');

/**
 * Variables présentes dans un modèle, commentées ou non.
 * Une ligne commentée compte : elle documente un réglage facultatif, et c'est
 * exactement ce qu'on veut pouvoir écrire sans le subir.
 *
 * Le motif accepte les noms de DEUX lettres. Une première version exigeait
 * trois caractères et manquait donc `TZ`, présente ligne 18 du modèle : elle
 * la réclamait comme absente. Un contrôle se trompe comme le reste.
 */
function variablesDuFichier(chemin) {
  const noms = new Set();
  if (!fs.existsSync(chemin)) return noms;
  for (const ligne of fs.readFileSync(chemin, 'utf8').split('\n')) {
    const m = ligne.match(/^\s*#?\s*([A-Z][A-Z_0-9]+)\s*=/);
    if (m) noms.add(m[1]);
  }
  return noms;
}

/** Fichiers d'un dossier, récursivement, filtrés par extension. */
function collecter(dossier, filtre, acc = []) {
  if (!fs.existsSync(dossier)) return acc;
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const complet = path.join(dossier, e.name);
    if (e.isDirectory()) collecter(complet, filtre, acc);
    else if (filtre.test(e.name)) acc.push(complet);
  }
  return acc;
}

/**
 * Variables que le JavaScript de production lit explicitement.
 *
 * L'API par ses aides de configuration, le tableau de bord et l'application
 * mobile par `process.env`. On ne balaie ni les tests ni les scripts de
 * recette : leurs variables leur appartiennent et n'ont rien à faire dans le
 * modèle d'installation.
 */
function variablesLuesParLeJs() {
  const noms = new Set();

  const envApi = fs.readFileSync(
    path.join(RACINE, 'apps', 'api', 'src', 'config', 'env.js'), 'utf8');
  for (const m of envApi.matchAll(
    /(?:obligatoire|optionnel|entier|booleen)\('([A-Z][A-Z_0-9]+)'/g)) {
    noms.add(m[1]);
  }

  const fichiers = [
    ...collecter(path.join(RACINE, 'apps', 'dashboard', 'src'), /\.(js|jsx|mjs)$/),
    ...collecter(path.join(RACINE, 'apps', 'mobile', 'src'), /\.(js|jsx|mjs)$/),
  ];
  for (const f of fichiers) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/process\.env\.([A-Z][A-Z_0-9]+)/g)) {
      // NODE_ENV est posé par l'exécution, pas par l'opérateur.
      if (m[1] !== 'NODE_ENV') noms.add(m[1]);
    }
  }

  return noms;
}

/**
 * Le nom apparaît-il ailleurs que dans le modèle et la documentation ?
 *
 * On cherche partout où un .env peut être consommé : le code, les scripts, la
 * composition Docker, les modèles nginx, les migrations. Peu importe COMMENT
 * la variable est lue — `${NOM}`, `$NOM`, `process.env.NOM`, `os.environ` — on
 * ne demande que la preuve qu'elle est nommée quelque part.
 */
function consommeeQuelquePart(nom, corpus) {
  const motif = new RegExp(`\\b${nom}\\b`);
  return corpus.some((texte) => motif.test(texte));
}

/**
 * CE FICHIER S'EXCLUT DU CORPUS, et ce n'est pas une coquetterie.
 *
 * Sa première version ne le faisait pas. Éprouvée en remettant
 * NEXT_PUBLIC_API_URL dans le modèle — le défaut d'origine — elle ne l'a PAS
 * signalée : le nom figure dans son propre commentaire d'en-tête, et le
 * contrôle s'était lu lui-même. Il aurait passé au vert sur le défaut exact
 * qui l'a fait écrire.
 *
 * Limite assumée qui demeure : une variable seulement CITÉE dans un
 * commentaire, ailleurs dans le dépôt, passera pour vivante. Le contrôle
 * attrape l'oubli franc, pas la mention distraite.
 */
const MOI = path.join(RACINE, 'scripts', 'verifier-env-template.js');

const modele = variablesDuFichier(MODELE);
const modeleMobile = variablesDuFichier(MODELE_MOBILE);
const declarees = new Set([...modele, ...modeleMobile]);
const luesParLeJs = variablesLuesParLeJs();

const fichiersConsommateurs = [
  ...collecter(path.join(RACINE, 'apps', 'api', 'src'), /\.(js|mjs)$/),
  ...collecter(path.join(RACINE, 'apps', 'dashboard', 'src'), /\.(js|jsx|mjs)$/),
  ...collecter(path.join(RACINE, 'apps', 'mobile', 'src'), /\.(js|jsx|mjs)$/),
  ...collecter(path.join(RACINE, 'scripts'), /\.(sh|js|py)$/),
  ...collecter(path.join(RACINE, 'infra'), /\.(conf|template|env|yml|yaml)$/),
  ...collecter(path.join(RACINE, 'db'), /\.(sh|sql)$/),
  ...['docker-compose.yml', 'docker-compose.prod.yml', 'ecosystem.config.js', 'Makefile']
    .map((f) => path.join(RACINE, f))
    .filter((f) => fs.existsSync(f)),
];
const corpus = fichiersConsommateurs
  .filter((f) => path.resolve(f) !== path.resolve(MOI))
  .map((f) => fs.readFileSync(f, 'utf8'));

// Les mémos assumés : écrits dans le modèle pour que la valeur à saisir
// ailleurs — chez Wave, chez l'opérateur SMS — soit rangée avec le reste.
// Chacun porte son explication dans le modèle lui-même.
const MEMOS = new Set(['WAVE_WEBHOOK_URL']);

const problemes = [];

for (const v of [...luesParLeJs].sort()) {
  if (!declarees.has(v)) {
    problemes.push(`  ABSENTE DU MODÈLE  ${v} — le code la lit, personne ne saura la renseigner`);
  }
}

for (const v of [...modele].sort()) {
  if (!MEMOS.has(v) && !consommeeQuelquePart(v, corpus)) {
    problemes.push(`  INERTE  ${v} — le modèle la demande, rien dans le dépôt ne la nomme`);
  }
}

console.log(`\n.env.template : ${modele.size} · mobile/.env.example : ${modeleMobile.size}`
  + ` · lues par le JavaScript : `
  + `${luesParLeJs.size} · fichiers consommateurs examinés : ${fichiersConsommateurs.length}\n`);

if (problemes.length === 0) {
  console.log('  Le modèle et le code disent la même chose.\n');
  process.exit(0);
}

console.log(`${problemes.join('\n')}\n`);
console.log(`  ${problemes.length} écart(s). Une variable inerte trompe l'opérateur ;\n`
  + '  une variable absente le laisse deviner. Les deux se paient en production.\n');
process.exit(1);
