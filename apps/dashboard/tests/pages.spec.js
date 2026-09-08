// @ts-check
/**
 * Toutes les pages s'ouvrent-elles ?
 *
 * Le tableau de bord n'avait aucun test, et le seul défaut qu'on y a trouvé
 * mettait une page entière hors service : une variable retirée avec les
 * espèces, dont l'usage était resté. La compilation passait, l'analyse
 * statique ne voyait rien — l'erreur ne survenait qu'après le CHARGEMENT DES
 * DONNÉES, quand le composant atteignait enfin la ligne fautive.
 *
 * C'est pourquoi ce test passe par un vrai navigateur plutôt que par un rendu
 * simulé : les effets doivent s'exécuter, les requêtes partir, et la page se
 * peindre avec de vraies données. C'est le seul moyen d'atteindre le code qui
 * ne s'exécute qu'une fois les données là.
 *
 * Prérequis : l'API sur 4000 et le tableau de bord sur 3000.
 *   cd apps/api && DB_NAME=gtfc_recette npm start
 *   cd apps/dashboard && npx next start
 */
const { test, expect } = require('@playwright/test');

const MDP = process.env.RECETTE_MDP ?? 'GtfcDemo2026!';

/**
 * Chaque profil ne voit pas les mêmes pages. On se connecte avec celui qui
 * voit le plus — le chef de projet — sauf pour les pages réservées.
 */
const COMPTES = {
  chef_projet: '+221700000004',
  admin: '+221700000002',
  maire: '+221700000005',
};

/**
 * Pour chaque page : son adresse, et un repère qui prouve qu'elle porte
 * vraiment des données.
 *
 * « S'affiche sans erreur » est un contrôle trop faible. La page des
 * redevables déballait deux fois l'enveloppe des réponses : elle rendait une
 * liste VIDE, sans la moindre erreur, et ce test la déclarait bonne. Une page
 * qui s'ouvre sur rien n'est pas une page qui marche.
 *
 * Le repère est un motif attendu dans le texte, calibré sur le jeu de
 * démonstration : soixante commerces, cent rues, soixante-trois redevables.
 */
const PAGES = [
  { chemin: '/tableau-bord', porte: /commerce|recouvr/i },
  { chemin: '/carte', porte: /commerce|rue/i },
  { chemin: '/rues', porte: /\b(1\d\d|\d\d)\s*(rue|voie)|couverture/i },
  // Un compte NON NUL : avec le défaut de double déballage, la page affichait
  // « 0 redevable(s) » — ce qu'un motif « \\d+ redevable » aurait accepté.
  { chemin: '/redevables', porte: /[1-9]\d* redevable/i },
  { chemin: '/commerces', porte: /GTFC-/ },
  { chemin: '/contestations', porte: /contestation/i },
  { chemin: '/recouvrement', porte: /recouvr|FCFA|XOF/i },
  { chemin: '/agents', porte: /agent/i },
  { chemin: '/audit', porte: /audit|action|journal/i },
  { chemin: '/derogations', porte: /dérogation|exonération|montant/i },
  // Réservée à la mairie (FR-092). Le repère accepte l'état vide : tant que
  // la mémoire est mince, tout est « indéterminé » — et c'est une réponse.
  { chemin: '/accompagnement', porte: /accompagnement|indétermin|commerce/i },
];

/** Pages réservées à l'administrateur de la commune ou au super-admin. */
const PAGES_ADMIN = ['/parametres', '/communes'];

async function connecter(page, telephone) {
  await page.goto('/connexion');
  await page.fill('input[name="telephone"], input[type="tel"]', telephone);
  await page.fill('input[type="password"]', MDP);
  await page.click('button[type="submit"]');
  // La connexion mène soit au tableau de bord, soit au changement de mot de
  // passe imposé à la première ouverture.
  await page.waitForURL((u) => !u.pathname.startsWith('/connexion'), { timeout: 15000 });
}

/**
 * Ce qu'on refuse de voir sur une page : une erreur React, une page vide, ou
 * le texte d'une exception affiché à l'utilisateur.
 */
function surveiller(page) {
  const problemes = [];
  page.on('pageerror', (e) => problemes.push(`exception : ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Les erreurs réseau d'une ressource annexe ne cassent pas la page.
    if (/favicon|net::ERR_|Failed to load resource/i.test(t)) return;
    problemes.push(`console : ${t.slice(0, 200)}`);
  });
  return problemes;
}

test.describe('Le tableau de bord s\'ouvre', () => {
  for (const { chemin, porte } of PAGES) {
    test(`${chemin} s'affiche et porte ses données`, async ({ page }) => {
      const problemes = surveiller(page);
      await connecter(page, COMPTES.chef_projet);

      await page.goto(chemin);
      // On attend que le chargement soit fini : c'est APRÈS que le code
      // intéressant s'exécute. Une page qui reste en chargement pour toujours
      // échoue ici — c'est ainsi que la page des rues s'est trahie.
      await expect(page.locator('text=Chargement')).toHaveCount(0, { timeout: 20000 });
      await page.waitForTimeout(600);

      const corps = await page.locator('body').innerText();
      expect(corps.length, `${chemin} rend une page vide`).toBeGreaterThan(80);
      expect(corps, `${chemin} affiche une erreur à l'utilisateur`)
        .not.toMatch(/is not defined|undefined is not|Cannot read propert|Application error/i);
      expect(corps, `${chemin} s'ouvre mais ne porte aucune donnée`).toMatch(porte);
      expect(problemes, `${chemin} : ${problemes.join(' | ')}`).toEqual([]);
    });
  }

  for (const chemin of PAGES_ADMIN) {
    test(`${chemin} s'affiche pour l'administrateur`, async ({ page }) => {
      const problemes = surveiller(page);
      await connecter(page, COMPTES.admin);
      await page.goto(chemin);
      await expect(page.locator('text=Chargement')).toHaveCount(0, { timeout: 20000 });
      await page.waitForTimeout(600);
      const corps = await page.locator('body').innerText();
      expect(corps.length).toBeGreaterThan(80);
      expect(problemes, `${chemin} : ${problemes.join(' | ')}`).toEqual([]);
    });
  }
});

test('le maire voit son bandeau de consultation, et pas les paramètres', async ({ page }) => {
  await connecter(page, COMPTES.maire);
  await page.goto('/tableau-bord');
  await expect(page.locator('text=consultation seule')).toBeVisible({ timeout: 15000 });
  // Le barème relève d'une délibération, pas d'un écran.
  await expect(page.locator('nav a[href="/parametres"]')).toHaveCount(0);
});
