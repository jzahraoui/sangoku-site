import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  assertMockClean,
  clickAndDownload,
  connectBridge,
  startHarness,
  stopHarness,
  waitForStatus,
} from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/**
 * Journey 2 — MSO round-trip: export the per-position subwoofer package
 * (frequency/magnitude/phase text files zipped for MSO), then import an
 * MSO Equalizer APO result and verify the filters/delays/inversions the
 * app pushes back into REW (mock store).
 */
test('MSO workflow: export sub package, import Equalizer APO config', async t => {
  const harness = await startHarness();
  const { page, rew, bridge } = harness;

  try {
    await t.test('prepare session (connect, import .ady, averages)', async () => {
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
      await page
        .getByTestId('avr-file-input')
        .setInputFiles(path.join(FIXTURES_DIR, 'sample.ady'));
      await waitForStatus(page, 'File loaded successfully', 180000);
      await page.getByTestId('create-averages').click();
      await waitForStatus(page, 'Average calculations completed successfully', 180000);
    });

    await t.test('export MSO sub package', async () => {
      // The MSO tools live inside a collapsed <details> block.
      await page.locator('summary[data-i18n="summary_mso"]').click();
      const { path: downloadPath, suggestedFilename } = await clickAndDownload(
        page,
        'mso-export',
      );
      assert.match(suggestedFilename, /^MSO-.*\.zip$/);

      const zip = await JSZip.loadAsync(readFileSync(downloadPath));
      const names = Object.keys(zip.files).sort();
      assert.deepEqual(names, ['POS1-SUB1.txt', 'POS1-SUB2.txt']);

      // Each export holds "freq magnitude phase" lines within 5–400 Hz.
      const content = await zip.files['POS1-SUB1.txt'].async('string');
      const lines = content.trim().split('\n');
      // The mock serves a linear FFT grid (~11.7 Hz step), so 5–400 Hz holds
      // ~34 points; real REW serves a denser log grid. Shape, not density.
      assert.ok(lines.length >= 20, `too few data lines: ${lines.length}`);
      for (const line of [lines[0], lines.at(-1)]) {
        const [freq, magnitude, phase] = line.split(' ').map(Number);
        assert.ok(freq >= 5 && freq <= 400, `freq out of range: ${freq}`);
        assert.ok(Number.isFinite(magnitude), `bad magnitude in: ${line}`);
        assert.ok(Number.isFinite(phase), `bad phase in: ${line}`);
      }
    });

    await t.test('import Equalizer APO config into REW', async () => {
      await page
        .getByTestId('mso-file-input')
        .setInputFiles(path.join(FIXTURES_DIR, 'mso-equalizer-apo.txt'));
      await waitForStatus(page, 'REW import successful for position', 180000);

      const byTitle = new Map(
        [...rew.store.measurements.values()].map(record => [record.title, record]),
      );
      const sw1 = byTitle.get('SW1avg');
      const sw2 = byTitle.get('SW2avg');
      assert.ok(sw1 && sw2, `subs missing in store: ${rew.titles()}`);

      // SW1: two peaking filters, no inversion, 3.5 ms delay pulled back.
      const sw1Filters = sw1.filters.filter(filter => filter.type === 'PK');
      assert.equal(sw1Filters.length, 2, JSON.stringify(sw1.filters));
      assert.equal(sw1Filters[0].frequency, 40);
      assert.equal(sw1Filters[0].gaindB, -5);
      assert.equal(sw1.inverted, false);
      assert.ok(
        Math.abs(sw1.cumulativeIRShiftSeconds - -0.0035) < 1e-6,
        `SW1 shift: ${sw1.cumulativeIRShiftSeconds}`,
      );

      // SW2: one filter, inverted.
      const sw2Filters = sw2.filters.filter(filter => filter.type === 'PK');
      assert.equal(sw2Filters.length, 1, JSON.stringify(sw2.filters));
      assert.equal(sw2Filters[0].frequency, 50);
      assert.equal(sw2.inverted, true);
    });

    assert.deepEqual(harness.pageErrors, []);
    assertMockClean(rew, bridge);
  } finally {
    await stopHarness(harness);
  }
});
