import assert from 'node:assert/strict';
import test from 'node:test';
import { startHarness, stopHarness } from '../support/harness.js';

/**
 * Journey 3 — EN/FR language toggle (UI parity reference).
 * Semantic assertions: translated labels, persisted preference, <html lang>.
 */
test('language toggle EN/FR', async () => {
  const harness = await startHarness();
  const { page } = harness;

  try {
    // Default language is English.
    await assertText(page, '[data-i18n="connect"]', 'Connect');
    await assertText(page, '[data-i18n="averages"]', 'Averages');

    // Switch to French.
    await page.getByTestId('language-selector').selectOption('fr');
    await assertText(page, '[data-i18n="connect"]', 'Connecter');
    await assertText(page, '[data-i18n="averages"]', 'Moyennes');
    assert.equal(await page.getAttribute('html', 'lang'), 'fr');
    assert.equal(
      await page.evaluate(() => localStorage.getItem('userLanguage')),
      'fr',
    );

    // Preference survives a reload.
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#appContent');
    await assertText(page, '[data-i18n="averages"]', 'Moyennes');

    // And back to English.
    await page.getByTestId('language-selector').selectOption('en');
    await assertText(page, '[data-i18n="averages"]', 'Averages');
    assert.equal(await page.getAttribute('html', 'lang'), 'en');

    assert.deepEqual(harness.pageErrors, []);
  } finally {
    await stopHarness(harness);
  }
});

async function assertText(page, selector, expected) {
  await page
    .locator(selector)
    .filter({ hasText: expected })
    .first()
    .waitFor({ state: 'attached' });
}
