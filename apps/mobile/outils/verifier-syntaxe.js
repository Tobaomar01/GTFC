#!/usr/bin/env node
/**
 * Contrôle de syntaxe de tous les fichiers source.
 *
 *   node outils/verifier-syntaxe.js
 *
 * `node --check` ne sait pas lire du JSX. On utilise donc @babel/parser avec
 * les mêmes extensions que Metro : sans cela, une faute de frappe dans un
 * écran ne se découvrirait qu'au chargement de l'application sur le
 * téléphone d'un agent.
 *
 * Contrôles complémentaires, propres à ce projet :
 *   - aucun import croisé entre écrans (source classique de cycles) ;
 *   - aucun appel réseau direct depuis un écran : tout passe par src/api ;
 *   - aucune chaîne « http:// » codée en dur hors des fichiers de config.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const RACINE = path.join(__dirname, '..');
const DOSSIERS = ['src', '.'];

let ok = 0;
let ko = 0;
const problemes = [];

function fichiersJs(dossier, acc = []) {
  for (const entree of fs.readdirSync(dossier, { withFileTypes: true })) {
    if (['node_modules', '.expo', 'android', 'ios', 'outils', 'assets'].includes(entree.name)) {
      continue;
    }
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) fichiersJs(complet, acc);
    else if (/\.jsx?$/.test(entree.name)) acc.push(complet);
  }
  return acc;
}

const fichiers = new Set();
for (const d of DOSSIERS) {
  const abs = path.join(RACINE, d);
  if (fs.existsSync(abs)) fichiersJs(abs).forEach((f) => fichiers.add(f));
}

console.log(`\nAnalyse de ${fichiers.size} fichiers\n`);

for (const fichier of [...fichiers].sort()) {
  const relatif = path.relative(RACINE, fichier);
  const source = fs.readFileSync(fichier, 'utf8');

  // --- Syntaxe ------------------------------------------------------------
  try {
    parser.parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator'],
    });
    ok += 1;
  } catch (err) {
    ko += 1;
    problemes.push(`  SYNTAXE  ${relatif}:${err.loc?.line ?? '?'} — ${err.message}`);
    continue;
  }

  // --- Règles du projet ---------------------------------------------------
  if (relatif.includes(`ecrans${path.sep}`)) {
    if (/\bfetch\s*\(/.test(source)) {
      problemes.push(`  RÈGLE    ${relatif} — appel fetch() direct depuis un écran, `
        + 'passez par src/api/client.js');
      ko += 1;
    }
  }

  const enDur = source.match(/['"`]https?:\/\/(?!localhost|192\.168|api\.exemple)[^'"`\s]+/g);
  if (enDur && !relatif.startsWith('src/api') && !relatif.includes('client.js')) {
    problemes.push(`  RÈGLE    ${relatif} — URL codée en dur : ${enDur[0]}`);
    ko += 1;
  }

  // --- Les imports relatifs pointent-ils vers un fichier existant ? -------
  // Metro ne le découvrirait qu'au chargement de l'écran concerné, sur le
  // téléphone de l'agent.
  for (const m of source.matchAll(/from\s+['"](\.[^'"]*)['"]/g)) {
    const cible = path.resolve(path.dirname(fichier), m[1]);
    const existe = ['', '.js', '.jsx', '/index.js']
      .some((suffixe) => fs.existsSync(cible + suffixe)
        && fs.statSync(cible + suffixe).isFile());
    if (!existe) {
      problemes.push(`  IMPORT   ${relatif} — « ${m[1] } » ne résout vers aucun fichier`);
      ko += 1;
    }
  }

  // Un import d'écran depuis un autre écran crée des cycles difficiles à
  // diagnostiquer sur Metro.
  if (relatif.includes(`ecrans${path.sep}`)) {
    const imports = source.match(/from\s+'\.\/[A-Za-z]+Ecran'/g);
    if (imports) {
      problemes.push(`  RÈGLE    ${relatif} — import croisé entre écrans : ${imports[0]}`);
      ko += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Cohérence des dépendances déclarées
// ---------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'));
const declarees = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

const utilisees = new Set();
for (const fichier of fichiers) {
  const source = fs.readFileSync(fichier, 'utf8');
  for (const m of source.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) {
    const nom = m[1].startsWith('@')
      ? m[1].split('/').slice(0, 2).join('/')
      : m[1].split('/')[0];
    utilisees.add(nom);
  }
}

const natives = new Set(['react', 'react-native']);
const manquantes = [...utilisees].filter((d) => !declarees.has(d) && !natives.has(d));
if (manquantes.length > 0) {
  problemes.push(`  DÉPENDANCE  non déclarée(s) dans package.json : ${manquantes.join(', ')}`);
  ko += manquantes.length;
}

console.log(problemes.length ? `${problemes.join('\n')}\n` : '  Aucun problème détecté\n');
console.log(`  ${ok} fichier(s) valide(s), ${ko} problème(s)\n`);
process.exit(ko === 0 ? 0 : 1);
