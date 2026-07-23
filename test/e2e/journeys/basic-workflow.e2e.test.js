import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertMockClean,
  connectBridge,
  startHarness,
  stopHarness,
  waitForStatus,
} from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

/**
 * Journey 1 — basic README workflow against the mocked REW API:
 * connect → import .ady (auto-import into REW) → averages → time align
 * → align SPL → save both filter banks → transfer to the AVR through the
 * bridge mock. Assertions target semantic outputs (mock store contents,
 * displayed key values, received CalibrationArchive), not DOM layout.
 */
test('basic workflow: connect, import .ady, average, align, transfer', async t => {
  const harness = await startHarness();
  const { page, rew, bridge } = harness;

  try {
    await t.test('connect to REW (mock)', async () => {
      await connectBridge(page);
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
        .filter({ hasText: '16 (max 199)' })
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

    await t.test('save both banks and transfer to the AVR (mock)', async () => {
      await page.getByTestId('bank-save-reference').click();
      await waitForStatus(page, 'Filters saved to the reference bank');
      await page.getByTestId('bank-duplicate').click();
      await waitForStatus(page, 'Filters duplicated from the reference bank');

      await page.getByTestId('transfer-start').click();
      await waitForStatus(page, 'Calibration transferred to the AVR');

      // Structural assertions on the CalibrationArchive received by the
      // bridge mock: filter VALUES come from the identity-EQ mock and are
      // not meaningful, but the document shape, the channel set and the
      // FR-062 lengths are the workflow's contract.
      const archive = bridge.lastArchive;
      assert.ok(archive, 'no archive received by the bridge mock');
      assert.equal(archive.eqType, 2);
      assert.equal(archive.model, 'Denon AVC-A1H');
      assert.equal(archive.title, 'e2e-sample');
      assert.equal(archive.numberOfSubwoofers, 2);
      assert.equal(archive.ampAssign, '2chBiAmp');
      // ampAssignBin omis du contrat (l'ampli le regenere au changement de
      // mode subwoofer) ; swSetup porte l'etat final vise.
      assert.equal(archive.ampAssignBin, undefined);
      assert.deepEqual(archive.swSetup, {
        SWNum: 2,
        SWMode: 'Standard',
        SWLayout: 'N/A',
      });
      assert.ok(Array.isArray(archive.channels), 'channels missing');
      assert.equal(
        archive.channels.length,
        5,
        `expected 5 channels, got ${archive.channels.length}`,
      );
      for (const channel of archive.channels) {
        assert.ok(typeof channel.commandId === 'string', 'commandId missing');
        assert.ok(typeof channel.speakerType === 'string', 'speakerType missing');
        assert.ok(Number.isFinite(channel.distanceInMeters), 'distance missing');
        assert.ok(Number.isFinite(channel.trimAdjustmentInDbs), 'trim missing');
        const expectedTaps = channel.commandId.startsWith('SW') ? 16055 : 16321;
        for (const key of ['filterRef', 'filterFlat']) {
          const taps = Buffer.from(channel[key], 'base64').length / 4;
          assert.equal(taps, expectedTaps, `${channel.commandId} ${key} taps`);
        }
      }
    });

    assert.deepEqual(harness.pageErrors, []);
    assertMockClean(rew, bridge);
  } finally {
    await stopHarness(harness);
  }
});
