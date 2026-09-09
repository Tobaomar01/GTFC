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

  // Ce que la règle vise : un point d'appel écrit en dur, qui enverrait
  // l'application ailleurs que là où le client la dirige.
  //
  // Deux chaînes ressemblent à des URL sans en être. L'espace de noms SVG est
  // un IDENTIFIANT, jamais appelé ; et le lien d'attribution de Leaflet ouvre
  // le navigateur du téléphone si l'agent le touche — l'application ne le
  // sollicite pas. On les écarte NOMMÉMENT plutôt que d'exempter le fichier
  // entier : une URL vraiment nouvelle dans le bundle régénéré sera toujours
  // refusée.
  //
  // Sans cela le contrôle échouait à CHAQUE exécution, sur ces deux chaînes.
  // Un contrôle qui ne peut pas passer finit par ne plus être lu.
  // Des prefixes, et non des expressions rationnelles : plus simples a lire,
  // et impossibles a rendre trop permissives par une echappement de travers.
  const INERTES = [
    'http://www.w3.org/',    // espaces de noms XML et SVG
    'https://leafletjs.com', // attribution obligatoire de Leaflet
  ];
  const enDur = (source.match(/['"`]https?:\/\/(?!localhost|192\.168|api\.exemple)[^'"`\s]+/g) ?? [])
    .map((m) => m.slice(1))
    .filter((u) => !INERTES.some((inerte) => u.startsWith(inerte)));

  if (enDur.length && !relatif.startsWith('src/api') && !relatif.includes('client.js')) {
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

  // --- Un composant employé sans être importé ni défini ? -----------------
  //
  // Une balise JSX dont le nom ne désigne rien est du JavaScript PARFAITEMENT
  // valide à l'analyse : c'est une variable, et l'erreur n'arrive qu'au moment
  // où React tente de rendre `undefined`. Donc seulement quand cette
  // branche-là s'affiche — la feuille de route périmée, l'écran d'erreur, le
  // cas qu'on n'a pas rejoué à la main.
  //
  // Le cas s'est produit le 09/09/2026 : un <Message> ajouté dans
  // FeuilleRouteEcran sans toucher à sa ligne d'import.
  {
    // Les objets globaux de JavaScript : « a <Math.min(b) » est une
    // COMPARAISON, pas une balise, et la règle criait dessus. Un contrôle qui
    // crie faux finit par ne plus être lu.
    const declares = new Set(['React', 'Fragment',
      'Math', 'JSON', 'Date', 'Number', 'String', 'Boolean', 'Object', 'Array',
      'Promise', 'Set', 'Map', 'WeakMap', 'RegExp', 'Error', 'Infinity', 'NaN',
      'Intl', 'Symbol', 'BigInt']);
    for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
      declares.add(m[1]);
    }
    for (const m of source.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) {
      declares.add(m[1]);
    }
    for (const m of source.matchAll(/import\s*\{([^}]+)\}/g)) {
      for (const brut of m[1].split(',')) {
        // « X as Y » : c'est Y qu'on emploie.
        const nom = brut.trim().split(/\s+as\s+/).pop().trim();
        if (nom) declares.add(nom);
      }
    }
    for (const m of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Z][\w$]*)/g)) {
      declares.add(m[1]);
    }
    for (const m of source.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var|class)\s+([A-Z][\w$]*)/g)) {
      declares.add(m[1]);
    }

    const inconnus = new Set();
    for (const m of source.matchAll(/<([A-Z][\w$]*)/g)) {
      // <Onglets.Screen> : seule la racine doit exister.
      if (!declares.has(m[1])) inconnus.add(m[1]);
    }
    for (const nom of inconnus) {
      problemes.push(`  COMPOSANT  ${relatif} — <${nom}> n'est ni importé ni défini : `
        + 'la page tombera au moment où cette branche s\'affichera');
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
// Les cibles de navigation existent-elles, et sont-elles atteignables ?
//
// CE QUI A ÉTÉ CONSTATÉ le 09/09/2026, sur un vrai téléphone, en terminant un
// recensement : « The action 'NAVIGATE' with payload {"name":"Accueil"} was
// not handled by any navigator. » La fiche était enregistrée, mais l'agent
// restait bloqué sur le formulaire, bandeau rouge en travers de l'écran.
//
// La cause : « Accueil » est un ONGLET, déclaré dans le navigateur imbriqué
// « Principal ». React Navigation remonte vers les PARENTS pour retrouver un
// nom ; il ne descend jamais dans un navigateur enfant. Depuis un écran de la
// pile, la seule forme valable est
//
//     navigation.navigate('Principal', { screen: 'Accueil' })
//
// Rien ne le signalait : ni Babel, ni Metro, ni un test. Le nom est une
// chaîne, elle est syntaxiquement irréprochable, et l'erreur ne se produit
// qu'au doigt posé sur le bouton. Deux contrôles, donc — une cible qui
// n'existe nulle part, et un onglet appelé depuis la pile.
// ---------------------------------------------------------------------------
const NAVIGATION = path.join(RACINE, 'src', 'navigation.js');
if (fs.existsSync(NAVIGATION)) {
  const nav = fs.readFileSync(NAVIGATION, 'utf8');

  const nomsDeclares = (motif) => new Set(
    [...nav.matchAll(motif)].map((m) => m[1]),
  );
  const onglets = nomsDeclares(/<Onglets\.Screen\s+name="([^"]+)"/g);
  const pile = nomsDeclares(/<Pile\.Screen\s+name="([^"]+)"/g);
  const toutes = new Set([...onglets, ...pile]);

  // Les fichiers qui SONT des onglets : eux peuvent nommer un onglet frère
  // directement, c'est le même navigateur.
  const composantsOnglets = new Set(
    [...nav.matchAll(/<Onglets\.Screen\s+name="[^"]+"\s+component=\{(\w+)\}/g)].map((m) => m[1]),
  );
  const fichiersOnglets = new Set();
  for (const m of nav.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const noms = m[1].split(',').map((n) => n.trim());
    if (noms.some((n) => composantsOnglets.has(n))) {
      fichiersOnglets.add(path.resolve(path.dirname(NAVIGATION), `${m[2]}.js`));
    }
  }

  if (toutes.size === 0) {
    problemes.push('  NAVIGATION  aucun écran déclaré dans src/navigation.js — '
      + 'le contrôle des cibles ne vérifie plus rien');
    ko += 1;
  }

  for (const fichier of [...fichiers].sort()) {
    if (fichier === NAVIGATION) continue;
    const relatif = path.relative(RACINE, fichier);
    const source = fs.readFileSync(fichier, 'utf8');

    // navigate('X') ou replace('X'), sans second argument nommant un écran
    // imbriqué : c'est cette forme-là qui n'est pas traitée.
    for (const m of source.matchAll(/\.(navigate|replace)\(\s*'([A-Za-z]\w*)'\s*[,)]/g)) {
      const cible = m[2];
      if (!toutes.has(cible)) {
        problemes.push(`  NAVIGATION  ${relatif} — « ${cible} » n'est déclaré par aucun `
          + "navigateur : l'action ne sera traitée par personne");
        ko += 1;
      } else if (onglets.has(cible) && !pile.has(cible) && !fichiersOnglets.has(fichier)) {
        problemes.push(`  NAVIGATION  ${relatif} — « ${cible} » est un onglet imbriqué, `
          + `inatteignable depuis la pile : navigate('Principal', { screen: '${cible}' })`);
        ko += 1;
      }
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
