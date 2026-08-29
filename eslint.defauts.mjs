/**
 * Chasse aux défauts, pas au style.
 *
 * Le seul défaut du tableau de bord trouvé jusqu'ici — une page entière hors
 * service — était un identifiant qui n'existait pas : `especes`, resté dans le
 * code après le retrait des espèces. Ni la compilation ni les tests ne
 * pouvaient le voir. `no-undef` l'aurait vu.
 *
 * Cette configuration ne retient donc que les règles qui désignent un DÉFAUT :
 * un identifiant inconnu, une constante réassignée, une clé en double, du code
 * inatteignable. Rien sur les points-virgules ni les guillemets — une liste
 * qui crie pour du style finit ignorée, et c'est le jour d'un vrai défaut que
 * personne ne la lira.
 *
 * Usage, sans rien installer dans le dépôt :
 *
 *     npx eslint@9 --config eslint.defauts.mjs \
 *       apps/api/src apps/api/scripts apps/api/tests \
 *       apps/dashboard/src apps/mobile/src apps/mobile/outils
 *
 * Ajoutez --quiet pour ne voir que les erreurs.
 */
import globals from 'globals';

const reglesDefauts = {
  'no-undef': 'error',
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-cond-assign': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-obj-calls': 'error',
  'no-sparse-arrays': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

/**
 * Les fichiers JSX portent des commentaires `eslint-disable` visant des règles
 * de plugins que cette configuration étroite ne charge pas. ESLint refuse de
 * démarrer sur une règle inconnue ; on la déclare donc sans effet plutôt que
 * de retirer des commentaires légitimes dans une configuration plus complète.
 */
const inerte = { create: () => ({}) };
const pluginsStub = {
  '@next/next': { rules: { 'no-img-element': inerte } },
  import: { rules: { 'no-extraneous-dependencies': inerte } },
  'react-hooks': { rules: { 'exhaustive-deps': inerte } },
};

// Les directives `eslint-disable` visant les greffons non chargés sont
// légitimes dans une configuration complète : ne pas les signaler comme
// inutiles ici, sous peine de bruit permanent.
const sansSignalerLesDirectives = { reportUnusedDisableDirectives: 'off' };

const jsx = {
  ecmaVersion: 2023,
  sourceType: 'module',
  parserOptions: { ecmaFeatures: { jsx: true } },
};

export default [
  {
    // `no-unused-vars` est volontairement absent des fichiers JSX : sans le
    // greffon React, ESLint ne voit pas qu'un composant importé est utilisé
    // dans le balisage, et signale des dizaines de faux positifs. Une liste
    // fausse aux trois quarts ne se lit plus.
    files: ['apps/dashboard/src/**/*.js'],
    languageOptions: { ...jsx, globals: { ...globals.browser, ...globals.node } },
    plugins: pluginsStub,
    linterOptions: sansSignalerLesDirectives,
    rules: reglesDefauts,
  },
  {
    files: ['apps/mobile/src/**/*.js', 'apps/mobile/outils/**/*.js'],
    languageOptions: { ...jsx, globals: { ...globals.browser, ...globals.node } },
    plugins: pluginsStub,
    linterOptions: sansSignalerLesDirectives,
    rules: reglesDefauts,
  },
  {
    files: ['apps/api/src/**/*.js', 'apps/api/scripts/**/*.js', 'apps/api/tests/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
    plugins: pluginsStub,
    linterOptions: sansSignalerLesDirectives,
    // Ici pas de JSX : l'inventaire des imports inutilisés est fiable, et un
    // import resté après un remaniement signale souvent un travail à moitié
    // fait.
    rules: { ...reglesDefauts, 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }] },
  },
];
