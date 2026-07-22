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
 * Journey — bank guards and transfer control: the transfer stays disabled
 * until BOTH banks are saved, the dry-run validation reaches the bridge, and
 * a cancellation is deferred (FINZ) then reported as cancelled.
 */
test('transfer: bank gating, validate dry-run, deferred cancellation', async t => {
  // Long scripted transfer: a wide in-progress window for the cancel step.
  const harness = await startHarness({ bridge: { transferSteps: 30 } });
  const { page, rew, bridge } = harness;

  try {
    await t.test('prepare session', async () => {
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
      await page.getByTestId('avr-file-input').setInputFiles(ADY_FIXTURE);
      await waitForStatus(page, 'File loaded successfully', 180000);
      await page.getByTestId('create-averages').click();
      await waitForStatus(page, 'Average calculations completed successfully', 180000);
    });

    await t.test('transfer is gated until both banks are saved', async () => {
      assert.equal(
        await page.getByTestId('transfer-start').isDisabled(),
        true,
        'transfer must be disabled with empty banks',
      );

      await page.getByTestId('bank-save-reference').click();
      await waitForStatus(page, 'Filters saved to the reference bank');
      await page
        .getByTestId('bank-state-reference')
        .filter({ hasText: 'e2eTarget' })
        .waitFor({ state: 'attached' });
      await page.getByTestId('bank-lock-hint').waitFor({ state: 'visible' });
      assert.equal(
        await page.getByTestId('transfer-start').isDisabled(),
        true,
        'transfer must stay disabled with a single bank',
      );

      await page.getByTestId('bank-save-flat').click();
      await waitForStatus(page, 'Filters saved to the flat bank');
      assert.equal(await page.getByTestId('transfer-start').isDisabled(), false);
    });

    await t.test('validate dry-run reaches the bridge', async () => {
      await page.getByTestId('transfer-validate').click();
      await waitForStatus(page, 'Calibration is compatible with the connected AVR');
      assert.ok(bridge.lastArchive, 'validation archive not received');
      assert.equal(bridge.lastArchive.eqType, 2);
    });

    await t.test('cancellation is deferred then reported', async () => {
      await page.getByTestId('transfer-start').click();
      await page.getByTestId('transfer-cancel').waitFor({ state: 'visible' });
      await page.getByTestId('transfer-cancel').click();
      await waitForStatus(page, 'Transfer cancelled', 60000);
      await page
        .getByTestId('transfer-state')
        .filter({ hasText: 'cancelled' })
        .waitFor({ state: 'attached' });
    });

    assert.deepEqual(harness.pageErrors, []);
    assertMockClean(rew, bridge);
  } finally {
    await stopHarness(harness);
  }
});
