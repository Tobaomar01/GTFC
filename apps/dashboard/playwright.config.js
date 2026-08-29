// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 45000,
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000',
    headless: true,
    // Une capture au moment de l'échec vaut mieux qu'un message : on voit ce
    // que l'utilisateur aurait vu.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
