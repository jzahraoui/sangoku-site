import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertMockClean,
  clickAndDownload,
  startHarness,
  stopHarness,
  waitForStatus,
} from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

/**
 * Journey 1 — basic README workflow against the mocked REW API:
 * connect → import .ady (auto-import into REW) → averages → time align
 * → align SPL → export .oca. Assertions target semantic outputs (mock
 * store contents, displayed key values, generated .oca structure), not
 * DOM layout.
 */
test('basic workflow: connect, import .ady, average, align, export OCA', async t => {
  const harness = await startHarness();
  const { page, rew } = harness;

  try {
    await t.test('connect to REW (mock)', async () => {
      await page.getByTestId('rew-connect').click();
      await page
        .getByTestId('rew-version')
        .filter({ hasText: '5.40 beta 111' })
        .waitFor({ state: 'attached' });
      // On connect, the app creates the target-curve measurement under the
      // processing lock; file imports are silently ignored while it is held.
      // Wait for the UI-observable release signal (buttons re-enabled).
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="create-averages"]').disabled,
        { timeout: 60000 },
      );
    });

    await t.test('import .ady and auto-load measurements into REW', async () => {
      await page.getByTestId('avr-file-input').setInputFiles(ADY_FIXTURE);
      await waitForStatus(page, 'File loaded successfully', 180000);

      // 5 channels × 3 positions, imported by the app itself (round-trip),
      // plus the target-curve measurement created at connect time.
      const titles = rew.titles();
      assert.equal(titles.length, 16, `expected 16 measurements, got: ${titles}`);
      for (const channel of ['FL', 'C', 'FR', 'SW1', 'SW2']) {
        for (const position of ['P01', 'P02', 'P03']) {
          assert.ok(
            titles.includes(`${channel}_${position}`),
            `missing measurement ${channel}_${position} in ${titles}`,
          );
        }
      }
      await page
        .getByTestId('measurement-count')
        .filter({ hasText: '16 / 199' })
        .waitFor({ state: 'attached' });
    });

    await t.test('create averages', async () => {
      await page.getByTestId('create-averages').click();
      await waitForStatus(page, 'Average calculations completed successfully', 180000);

      const titles = rew.titles();
      for (const channel of ['FL', 'C', 'FR', 'SW1', 'SW2']) {
        assert.ok(
          titles.includes(`${channel}avg`),
          `missing average ${channel}avg in ${titles}`,
        );
      }
      // Originals deleted (default "delete all"): the 5 averages plus the
      // target-curve measurement remain.
      assert.equal(titles.length, 6, `expected 5 averages + target, got: ${titles}`);
    });

    await t.test('time align', async () => {
      await page.getByTestId('time-align').click();
      await waitForStatus(page, 'Time align successful', 180000);

      // Semantic outcome: t=0 sits on the excess-phase arrival, so each
      // speaker IR peak lands within a couple of ms of zero (the residual is
      // the peak-vs-wavefront gap, µs-range on clean IRs) where the raw
      // imports started tens of ms away.
      for (const record of rew.store.measurements.values()) {
        assert.ok(
          Math.abs(record.timeOfIRPeakSeconds) < 2e-3 ||
            record.title.startsWith('SW'),
          `IR peak of ${record.title} far from zero: ${record.timeOfIRPeakSeconds}`,
        );
      }
    });

    await t.test('align SPL', async () => {
      await page.getByTestId('align-spl').click();
      await waitForStatus(page, 'SPL alignment successful', 240000);

      // Speaker averages must have been aligned to a common level.
      const speakers = [...rew.store.measurements.values()].filter(record =>
        ['FLavg', 'Cavg', 'FRavg'].includes(record.title),
      );
      assert.equal(speakers.length, 3);
      const offsets = speakers.map(record => record.alignSPLOffsetdB);
      assert.ok(
        offsets.some(offset => offset !== 0),
        `expected non-zero align offsets, got ${offsets}`,
      );
    });

    await t.test('export OCA file', async () => {
      const { path: downloadPath, suggestedFilename } = await clickAndDownload(
        page,
        'create-oca',
      );
      assert.match(suggestedFilename, /\.oca$/);
      assert.match(suggestedFilename, /Denon-AVC-A1H/);

      // Structural assertions on the generated .oca (odd format): filter
      // VALUES come from the identity-EQ mock and are not meaningful, but
      // the document shape and channel set are the workflow's contract.
      const oca = JSON.parse(readFileSync(downloadPath, 'utf8'));
      assert.equal(oca.model, 'Denon AVC-A1H');
      assert.equal(oca.title, 'e2e-sample');
      assert.match(oca.tcName, /e2eTarget/);
      assert.equal(oca.numberOfSubwoofers, 2);
      assert.ok(Array.isArray(oca.channels), 'channels missing');
      assert.equal(oca.channels.length, 5, `expected 5 channels, got ${oca.channels.length}`);
      for (const channel of oca.channels) {
        assert.ok(Number.isInteger(channel.channelType), 'channelType missing');
        assert.ok(typeof channel.speakerType === 'string', 'speakerType missing');
        assert.ok(Number.isFinite(channel.distanceInMeters), 'distance missing');
        assert.ok(Number.isFinite(channel.trimAdjustmentInDbs), 'trim missing');
        assert.ok(
          Array.isArray(channel.filter) && channel.filter.length > 0,
          'filter taps missing',
        );
      }
    });

    assert.deepEqual(harness.pageErrors, []);
    assertMockClean(rew);
  } finally {
    await stopHarness(harness);
  }
});
