import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertMockClean,
  clickAndDownload,
  connectBridge,
  startHarness,
  stopHarness,
  waitForStatus,
} from '../support/harness.js';
import { previewUrl } from '../support/server.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');
const IMPORT_INPUT = 'session-import-input';
const LFE_REVERT_LABEL = 'LFE Revert Frequency';
const BANK_STATE_REFERENCE = 'bank-state-reference';

/** Connects the full chain on a page (bridge first, then REW). */
async function connectChain(page) {
  await connectBridge(page);
  await page.getByTestId('rew-connect').click();
  await page
    .getByTestId('rew-version')
    .filter({ hasText: '5.40 beta 111' })
    .waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="create-averages"]').disabled,
    { timeout: 60000 },
  );
}

/**
 * Journey — session file export/import: build a session (measurements +
 * settings + a saved filter bank), export it to a .json file, then resume it
 * in a FRESH browser context (empty localStorage — the "come back later"
 * scenario; REW, mocked, still holds the measurements of the .mdat): import
 * the file back and verify the settings, the bank and the REW re-attachment;
 * then import a tampered file carrying an unknown measurement uuid and
 * verify the non-blocking "not found in REW" report; finally an invalid file
 * is refused with a clear error.
 */
test('session file: export, fresh browser, import, reattach and report', async t => {
  const harness = await startHarness();
  const { page, rew, bridge } = harness;
  let downloadPath;
  let exported;
  // Fresh-context page (empty localStorage) used from the import step on.
  let context2;
  let page2;
  const page2Errors = [];

  try {
    await t.test('prepare session (connect, import .ady, averages, bank)', async () => {
      await connectChain(page);
      await page.getByTestId('avr-file-input').setInputFiles(ADY_FIXTURE);
      await waitForStatus(page, 'File loaded successfully', 180000);
      await page.getByTestId('create-averages').click();
      await waitForStatus(page, 'Average calculations completed successfully', 180000);
      await page.getByTestId('bank-save-reference').click();
      await waitForStatus(page, 'Filters saved to the reference bank');
      // A persisted, side-effect-free setting to assert the restoration on.
      await page.getByLabel(LFE_REVERT_LABEL).selectOption('120');
    });

    await t.test('export the session file', async () => {
      const download = await clickAndDownload(page, 'session-export');
      downloadPath = download.path;
      assert.match(download.suggestedFilename, /^rch-session-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
      await waitForStatus(page, 'Session file downloaded');

      exported = JSON.parse(readFileSync(downloadPath, 'utf8'));
      assert.equal(exported.schemaVersion, 1);
      assert.ok(exported.rchVersion, 'rchVersion missing');
      assert.ok(exported.savedAt, 'savedAt missing');
      // 5 channel averages + the target-curve measurement.
      assert.equal(exported.payload.measurements.length, 6);
      assert.equal(exported.payload.selectedLfeFrequency, 120);
      assert.ok(
        exported.payload.filterBanks?.reference?.channels?.length > 0,
        'reference bank missing from the exported payload',
      );
      assert.equal(exported.payload.filterBanks.flat, null);
      // ADR 002: no signal data in the session payload.
      for (const channel of exported.payload.avrFileContent?.detectedChannels ?? []) {
        assert.deepEqual(channel.responseData, {}, `signal left in ${channel.commandId}`);
      }
    });

    await t.test('open a fresh browser context (empty storage)', async () => {
      context2 = await harness.browser.newContext({ acceptDownloads: true });
      page2 = await context2.newPage();
      page2.setDefaultTimeout(30000);
      page2.on('pageerror', error => page2Errors.push(error?.stack ?? String(error)));
      await page2.route('**/api.github.com/**', route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      );
      // Same REW/bridge mocks: REW still holds the measurements (.mdat story).
      await rew.attach(page2);
      await bridge.attach(page2);
      await page2.goto(previewUrl(), { waitUntil: 'load', timeout: 30000 });
      await page2.waitForSelector('#appContent');
      await connectChain(page2);
      // Nothing restored: the banks start empty in this browser.
      await page2
        .getByTestId(BANK_STATE_REFERENCE)
        .filter({ hasText: 'empty' })
        .waitFor({ state: 'attached' });
    });

    await t.test('import the session file back', async () => {
      await page2.getByTestId(IMPORT_INPUT).setInputFiles(downloadPath);
      await waitForStatus(page2, 'Session imported successfully');

      // Settings restored.
      assert.equal(await page2.getByLabel(LFE_REVERT_LABEL).inputValue(), '120');
      // Filter bank restored (the bank card shows the saved target curve).
      await page2
        .getByTestId(BANK_STATE_REFERENCE)
        .filter({ hasText: 'e2eTarget' })
        .waitFor({ state: 'attached' });
      // Measurements re-attached by uuid: the REW mock still holds them all.
      await page2
        .getByTestId('measurement-count')
        .filter({ hasText: '6 (max 199)' })
        .waitFor({ state: 'attached' });
    });

    await t.test('report measurements missing from REW (tampered session)', async () => {
      const tampered = structuredClone(exported);
      const ghost = structuredClone(tampered.payload.measurements[0]);
      ghost.uuid = 'ghost-e2e-uuid';
      ghost.title = 'GHOST_P01';
      ghost.displayMeasurementTitle = 'GHOST_P01';
      ghost.position = 1;
      tampered.payload.measurements.push(ghost);
      const tamperedPath = `${downloadPath}-tampered.json`;
      writeFileSync(tamperedPath, JSON.stringify(tampered));

      await page2.getByTestId(IMPORT_INPUT).setInputFiles(tamperedPath);
      // Non-blocking report raised by the next REW sync: the ghost is
      // discarded and the summary tells the user to reload the .mdat.
      await waitForStatus(page2, 'not found in REW', 60000);
      await page2
        .getByTestId('measurement-count')
        .filter({ hasText: '6 (max 199)' })
        .waitFor({ state: 'attached' });
    });

    await t.test('invalid file is refused with a clear error', async () => {
      const invalidPath = `${downloadPath}-invalid.json`;
      writeFileSync(invalidPath, '{ this is not json');
      await page2.getByTestId(IMPORT_INPUT).setInputFiles(invalidPath);
      await page2
        .locator('.logs-content .log-entry.error .log-message')
        .filter({ hasText: 'not a valid JSON file' })
        .first()
        .waitFor({ state: 'attached', timeout: 60000 });
    });

    assert.deepEqual(harness.pageErrors, []);
    assert.deepEqual(page2Errors, []);
    assertMockClean(rew, bridge);
  } finally {
    if (context2) await context2.close();
    await stopHarness(harness);
  }
});
