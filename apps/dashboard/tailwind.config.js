/**
 * Tailwind — les valeurs de couleur viennent de globals.css (variables CSS),
 * pas d'ici. Raison : le mode sombre change les hexadécimaux, et un seul
 * endroit doit en décider.
 *
 * La palette de statut a été VALIDÉE par le validateur de la méthode de
 * visualisation : bande de clarté, plancher de chroma, séparation daltonisme
 * (protanopie/deutéranopie), plancher vision normale et contraste — les six
 * contrôles passent dans les deux modes. Ne pas modifier un hexadécimal sans
 * relancer la validation. Détail dans docs/PHASE-6-dashboard.md.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  darkMode: ['class', '[data-theme="sombre"]'],
  theme: {
    extend: {
      colors: {
        // Chrome et encre
        surface: 'var(--surface)',
        'surface-alt': 'var(--surface-alt)',
        plan: 'var(--plan)',
        encre: 'var(--encre)',
        'encre-2': 'var(--encre-2)',
        'encre-attenuee': 'var(--encre-attenuee)',
        bordure: 'var(--bordure)',
        grille: 'var(--grille)',

        // Marque
        marque: 'var(--marque)',
        'marque-clair': 'var(--marque-clair)',

        // Statut fiscal — jamais réutilisées pour autre chose qu'un état
        'st-ajour': 'var(--st-ajour)',
        'st-partiel': 'var(--st-partiel)',
        'st-impaye': 'var(--st-impaye)',
        'st-exonere': 'var(--st-exonere)',
        'st-inconnu': 'var(--st-inconnu)',

        // Série unique pour les graphiques de magnitude (jamais un statut)
        serie: 'var(--serie)',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: { carte: '12px' },
      boxShadow: {
        carte: '0 1px 2px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.04)',
      },
    },
  },
  plugins: [],
};
