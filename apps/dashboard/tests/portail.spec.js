// @ts-check
/**
 * Le portail du redevable, et la page publique d'un sticker.
 *
 * Ce sont les deux surfaces qu'un commerçant — ou un passant — atteint sans
 * qu'aucun agent ne soit présent. Elles n'avaient jamais été ouvertes.
 *
 * Le portail donne accès à un dossier fiscal : montants dus, historique,
 * adresse. Sa seule porte est un code à six chiffres envoyé par SMS. Ce qui
 * est éprouvé ici, ce n'est pas qu'il « marche » — c'est qu'il ne s'ouvre pas
 * quand il ne devrait pas.
 */
const { test, expect } = require('@playwright/test');

/**
 * Deux redevables dont le numéro a été vérifié par un agent (seed 0014).
 *
 * Ils sont DISTINCTS à dessein : le portail plafonne les demandes de code
 * par numéro et par heure (app.code_acces_autorise, otp_max_par_heure).
 * Deux tests qui partagent un numéro s'épuisent l'un l'autre — et l'échec
 * ne ressemble alors plus du tout à sa cause : le champ du code n'apparaît
 * pas, sans que rien ne dise pourquoi.
 */
const REDEVABLE = process.env.PORTAIL_TEL ?? '+221701000001';
const REDEVABLE_BIS = process.env.PORTAIL_TEL_BIS ?? '+221701000002';

/**
 * Le plafond horaire est une protection qui fonctionne, pas une panne. Quand
 * il tombe, on le NOMME et on s'arrête : un test rouge doit désigner un
 * défaut, jamais une limite de l'environnement.
 */
const sousPlafond = (texte) => /trop de demandes pour ce num/i.test(texte);

/** Un numéro qui n'existe pas dans le registre. */
const INCONNU = '+221709999999';

test('le portail s\'ouvre et demande un numéro', async ({ page }) => {
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(e.message));

  await page.goto('/portail');
  await expect(page.locator('input[type="tel"], input[name="telephone"]')).toBeVisible();
  expect(erreurs, erreurs.join(' | ')).toEqual([]);
});

test('un numéro inconnu ne se distingue pas d\'un numéro connu', async ({ page }) => {
  // Deux réponses différentes permettraient d'énumérer les redevables de la
  // commune en composant au hasard. Le portail doit rester muet.
  const lire = async (numero) => {
    await page.goto('/portail');
    await page.fill('input[type="tel"], input[name="telephone"]', numero);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1500);
    return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  };

  const connu = await lire(REDEVABLE);
  test.skip(sousPlafond(connu), 'plafond horaire de codes atteint pour ce numéro');
  const inconnu = await lire(INCONNU);

  // Le bloc « code de démonstration » n'apparaît que faute de passerelle SMS,
  // et seulement pour un numéro connu — puisqu'un code n'est engendré que là.
  // C'est une commodité de développement : en production, la configuration
  // refuse ce mode et le champ n'est jamais renvoyé. On l'écarte donc de la
  // comparaison, et on éprouve ce qui subsistera : le MESSAGE.
  const sansDemo = (t) => t
    .replace(/Aucun opérateur SMS n'est raccordé\.\s*Code de démonstration\s*:\s*\d+\s*/i, '')
    .trim();

  expect(sansDemo(inconnu), 'un numéro inconnu se distingue d\'un numéro connu')
    .toEqual(sansDemo(connu));

  // Et le message lui-même ne tranche pas : « SI ce numéro est enregistré ».
  expect(connu).toMatch(/si ce numéro est enregistré/i);
});

test('un code faux n\'ouvre pas le dossier', async ({ page }) => {
  await page.goto('/portail');
  await page.fill('input[type="tel"], input[name="telephone"]', REDEVABLE_BIS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(1200);
  test.skip(sousPlafond(await page.locator('body').innerText()),
    'plafond horaire de codes atteint pour ce numéro');

  const champCode = page.locator('input[inputmode="numeric"], input[name="code"]').first();
  await expect(champCode).toBeVisible({ timeout: 8000 });
  await champCode.fill('000000');
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(1500);

  expect(page.url(), 'un code faux a ouvert le dossier').not.toContain('/dossier');
  await expect(page.locator('text=/invalide|incorrect|tentative/i')).toBeVisible();
});

test('le dossier ne s\'atteint pas sans session', async ({ page }) => {
  // L'adresse est devinable : elle ne doit pas suffire.
  await page.goto('/portail/dossier');
  await page.waitForTimeout(1500);
  const corps = await page.locator('body').innerText();
  // Soit on est renvoyé au portail, soit la page refuse — jamais un dossier.
  const renvoye = page.url().includes('/portail') && !page.url().includes('/dossier');
  expect(renvoye || /connect|code|session/i.test(corps),
    `le dossier s'est affiché sans session : ${corps.slice(0, 200)}`).toBeTruthy();
  expect(corps, 'un montant dû est apparu sans authentification')
    .not.toMatch(/\d[\d\s]{3,}\s*(FCFA|XOF)/);
});

test('la page publique d\'un sticker n\'affiche aucun montant', async ({ page, request }) => {
  // Le jeton vient de l'API : c'est ce que porte le QR collé sur la devanture.
  const r = await request.get('http://127.0.0.1:4000/public/commune/gtfc');
  expect(r.ok(), 'l\'API publique doit répondre').toBeTruthy();

  const jeton = process.env.QR_JETON;
  test.skip(!jeton, 'QR_JETON non fourni');

  await page.goto(`/c/${jeton}`);
  await page.waitForTimeout(1200);
  const corps = await page.locator('body').innerText();
  expect(corps).not.toMatch(/FCFA|XOF|solde|impay/i);
});
