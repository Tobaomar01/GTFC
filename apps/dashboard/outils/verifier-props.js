#!/usr/bin/env node
/**
 * Les propriétés passées aux composants existent-elles vraiment ?
 *
 *   node outils/verifier-props.js
 *
 * CE QUI A ÉTÉ CONSTATÉ le 09/09/2026, en écrivant la page des conflits.
 * Trois défauts, tous muets, dont deux vivaient dans le dépôt depuis
 * longtemps :
 *
 *   - <Bouton variante="principal"> — la variante s'appelle « primaire ». Le
 *     bouton recevait « undefined » dans sa classe et le filtre actif de la
 *     page des dérogations ne se distinguait pas des autres.
 *   - <EtatVide description="…"> — le composant attend « texte ». Le texte
 *     explicatif ne s'affichait jamais.
 *   - <Bouton disabled={…}> — le composant attend « desactive ». Le bouton
 *     restait cliquable.
 *
 * POURQUOI RIEN NE LES VOYAIT. En JSX, une propriété inconnue est du
 * JavaScript parfaitement valide : elle atterrit dans un objet que le
 * composant ne lit pas. Rien ne plante, rien ne s'écrit dans la console. La
 * page s'affiche, simplement amputée de ce qu'on croyait avoir demandé — et
 * c'est le pire des cas, parce qu'on ne va pas chercher ce qu'on croit avoir.
 *
 * Le contrôle lit les SIGNATURES des composants, il ne les recopie pas : une
 * propriété renommée dans ui.js fait immédiatement tomber ses appelants.
 *
 * Sortie non nulle si une propriété n'existe pas.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// espree lit le JSX, ce que `node --check` ne sait pas faire. Il est déclaré en
// devDependencies : il était d'abord arrivé par une dépendance transitive
// d'ESLint, ce qui aurait fait disparaître ce contrôle au premier `npm update`
// — avec un « Cannot find module » qui n'explique rien à qui le découvre.
let espree;
try {
  espree = require('espree');
} catch {
  console.error('\n  espree est absent. Ce contrôle en a besoin pour lire le JSX.\n'
    + '  Installez les dépendances de développement :  npm install\n');
  process.exit(1);
}

const RACINE = path.join(__dirname, '..');
const COMPOSANTS = path.join(RACINE, 'src', 'composants');

/**
 * Propriétés à ensemble FERMÉ.
 *
 * Le composant indexe un objet avec la valeur reçue ; toute autre valeur donne
 * `undefined`, silencieusement. On lit les clés autorisées DANS le composant —
 * les recopier ici les ferait diverger à la première évolution.
 */
const ENSEMBLES_FERMES = [
  { composant: 'Bouton', prop: 'variante', objet: 'variantes' },
  { composant: 'Bouton', prop: 'taille', objet: 'tailles' },
  { composant: 'Message', prop: 'type', objet: 'styles' },
];

/**
 * Les chaînes qu'une valeur d'attribut peut prendre, quand on peut le savoir.
 *
 * MA PREMIÈRE VERSION NE REGARDAIT QUE `prop="chaîne"`. Éprouvée sur le défaut
 * qui l'a fait écrire, elle ne l'a PAS vu : la page des dérogations écrit
 * `variante={filtre === cle ? 'principal' : 'secondaire'}`, un ternaire et non
 * un littéral. Le contrôle était aveugle sur son propre cas d'origine.
 *
 * On descend donc dans le ternaire et le « et » logique, dont les branches sont
 * des valeurs possibles. Toute autre forme — une variable, un appel — rend
 * `null` : on ne sait pas, on se tait, plutôt que de crier à tort.
 */
function chainesPossibles(noeud) {
  if (!noeud) return null;
  switch (noeud.type) {
    case 'Literal':
      return typeof noeud.value === 'string' ? [noeud.value] : null;
    case 'TemplateLiteral':
      return noeud.expressions.length === 0 ? [noeud.quasis[0].value.cooked] : null;
    case 'JSXExpressionContainer':
      return chainesPossibles(noeud.expression);
    case 'ConditionalExpression': {
      const a = chainesPossibles(noeud.consequent);
      const b = chainesPossibles(noeud.alternate);
      return a && b ? [...a, ...b] : null;
    }
    case 'LogicalExpression': {
      // `cond && 'x'` : seule la droite est une valeur. `a ?? 'x'` de même.
      const d = chainesPossibles(noeud.right);
      if (!d) return null;
      const g = chainesPossibles(noeud.left);
      return g ? [...g, ...d] : d;
    }
    default:
      return null;
  }
}

function analyser(source) {
  return espree.parse(source, {
    ecmaVersion: 2023,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  });
}

function fichiersJs(dossier, acc = []) {
  if (!fs.existsSync(dossier)) return acc;
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const complet = path.join(dossier, e.name);
    if (e.isDirectory()) fichiersJs(complet, acc);
    else if (/\.jsx?$/.test(e.name)) acc.push(complet);
  }
  return acc;
}

/** Parcours générique de l'arbre : espree ne fournit pas de visiteur. */
function parcourir(noeud, visiter) {
  if (!noeud || typeof noeud !== 'object') return;
  if (Array.isArray(noeud)) {
    for (const n of noeud) parcourir(n, visiter);
    return;
  }
  if (typeof noeud.type === 'string') visiter(noeud);
  for (const cle of Object.keys(noeud)) {
    if (cle === 'parent') continue;
    parcourir(noeud[cle], visiter);
  }
}

// ---------------------------------------------------------------------------
//  Ce que chaque composant accepte vraiment
// ---------------------------------------------------------------------------
const connus = new Map();   // nom -> { props:Set, rest:boolean, fichier }
const valeurs = new Map();  // "Composant.prop" -> Set des valeurs permises

for (const fichier of fichiersJs(COMPOSANTS)) {
  const source = fs.readFileSync(fichier, 'utf8');
  let arbre;
  try { arbre = analyser(source); } catch (err) {
    console.log(`  SYNTAXE  ${path.relative(RACINE, fichier)} — ${err.message}`);
    process.exit(1);
  }

  parcourir(arbre, (n) => {
    const estComposant = (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
      || n.type === 'ArrowFunctionExpression')
      && n.id && /^[A-Z]/.test(n.id.name);
    if (!estComposant) return;

    const premier = n.params[0];
    // Un composant qui reçoit `props` en bloc, sans destructuration, ne peut
    // pas être contrôlé : on ne sait pas ce qu'il lit. On ne prétend pas.
    if (!premier || premier.type !== 'ObjectPattern') return;

    const props = new Set();
    let rest = false;
    for (const p of premier.properties) {
      if (p.type === 'RestElement') { rest = true; continue; }
      if (p.key?.name) props.add(p.key.name);
      else if (p.key?.value) props.add(String(p.key.value));
    }
    connus.set(n.id.name, { props, rest, fichier });

    // Les ensembles fermés de CE composant.
    for (const e of ENSEMBLES_FERMES.filter((x) => x.composant === n.id.name)) {
      parcourir(n.body, (m) => {
        if (m.type !== 'VariableDeclarator') return;
        if (m.id?.name !== e.objet) return;
        if (m.init?.type !== 'ObjectExpression') return;
        const permises = new Set();
        for (const p of m.init.properties) {
          if (p.key?.name) permises.add(p.key.name);
          else if (p.key?.value) permises.add(String(p.key.value));
        }
        valeurs.set(`${e.composant}.${e.prop}`, permises);
      });
    }
  });
}

// ---------------------------------------------------------------------------
//  Ce que les pages leur passent
// ---------------------------------------------------------------------------
const problemes = [];
const fichiers = fichiersJs(path.join(RACINE, 'src'));

for (const fichier of fichiers) {
  const relatif = path.relative(RACINE, fichier);
  const source = fs.readFileSync(fichier, 'utf8');
  let arbre;
  try { arbre = analyser(source); } catch (err) {
    problemes.push(`  SYNTAXE  ${relatif} — ${err.message}`);
    continue;
  }

  parcourir(arbre, (n) => {
    if (n.type !== 'JSXOpeningElement') return;
    if (n.name?.type !== 'JSXIdentifier') return;
    const composant = connus.get(n.name.name);
    if (!composant) return;

    // `{...props}` : on ne sait plus ce qui est passé, on se tait plutôt que
    // de crier à tort.
    if (n.attributes.some((a) => a.type === 'JSXSpreadAttribute')) return;

    for (const a of n.attributes) {
      if (a.type !== 'JSXAttribute' || a.name?.type !== 'JSXIdentifier') continue;
      const nom = a.name.name;

      if (nom !== 'key' && !composant.props.has(nom) && !composant.rest) {
        const proches = [...composant.props].join(', ');
        problemes.push(
          `  PROPRIÉTÉ  ${relatif} — <${n.name.name} ${nom}=…> n'existe pas. `
          + `Ce composant lit : ${proches}`);
      }

      const permises = valeurs.get(`${n.name.name}.${nom}`);
      if (permises) {
        for (const valeur of chainesPossibles(a.value) ?? []) {
          if (permises.has(valeur)) continue;
          problemes.push(
            `  VALEUR  ${relatif} — <${n.name.name} ${nom}="${valeur}"> ne correspond `
            + `à rien. Valeurs possibles : ${[...permises].join(', ')}`);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
console.log(`\n  ${connus.size} composant(s) lus dans src/composants · `
  + `${fichiers.length} fichier(s) analysés\n`);

if (problemes.length === 0) {
  console.log('  Toutes les propriétés passées existent.\n');
  process.exit(0);
}

console.log(`${problemes.join('\n')}\n`);
console.log(`  ${problemes.length} propriété(s) sans effet. En JSX elles ne plantent pas :\n`
  + '  elles atterrissent dans un objet que personne ne lit, et la page s\'affiche\n'
  + '  amputée de ce qu\'on croyait avoir demandé.\n');
process.exit(1);
