// playwright.config.js
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
});
