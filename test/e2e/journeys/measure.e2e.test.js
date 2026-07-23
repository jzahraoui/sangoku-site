import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMockClean,
  connectBridge,
  startHarness,
  stopHarness,
  waitForStatus,
} from '../support/harness.js';

const READY_STATE = { hasText: 'ready' };

/**
 * Journey — bridge-driven Audyssey measurement assistant: start the session,
 * measure position 1 (full detected plan) with the impulse responses imported
 * into REW on the fly, measure position 2 with a channel subset, run a
 * subwoofer level-matching routine, then complete with the .mdat reminder.
 */
test('measure: bridge-driven Audyssey session imports IRs into REW', async t => {
  const harness = await startHarness({ bridge: { measureSteps: 3 } });
  const { page, rew, bridge } = harness;

  try {
    await t.test('green chain (bridge + REW)', async () => {
      await connectBridge(page);
      await page.getByTestId('rew-connect').click();
      await page
        .getByTestId('rew-version')
        .filter({ hasText: '5.40 beta 111' })
        .waitFor({ state: 'attached' });
      // Wait for the connect-time processing lock to release.
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="create-averages"]').disabled,
        { timeout: 60000 },
      );
    });

    await t.test('start the session until ready', async () => {
      await page.getByTestId('measure-start-session').click();
      await page
        .getByTestId('measure-state')
        .filter(READY_STATE)
        .waitFor({ state: 'attached' });
      await page
        .getByTestId('measure-next-position')
        .filter({ hasText: '1 / 32' })
        .waitFor({ state: 'attached' });
      const channels = await page.getByTestId('measure-channels').textContent();
      for (const commandId of ['FL', 'C', 'FR', 'SW1', 'SW2']) {
        assert.ok(channels.includes(commandId), `plan should list ${commandId}: ${channels}`);
      }
    });

    await t.test('measure position 1 (full detected plan)', async () => {
      await page.getByTestId('measure-position').click();
      // The channel under work is highlighted in the plan list while the
      // sweep/retrieve/import runs.
      await page
        .locator('[data-testid="measure-channels"] label.measure-current')
        .first()
        .waitFor({ state: 'attached', timeout: 60000 });
      await waitForStatus(page, 'Position measured: 1', 120000);

      const titles = rew.titles();
      for (const channel of ['FL', 'C', 'FR', 'SW1', 'SW2']) {
        assert.ok(
          titles.includes(`${channel}_P01`),
          `missing measurement ${channel}_P01 in ${titles}`,
        );
      }
      // Position 1 = detection: the bridge received no channels subset.
      assert.deepEqual(bridge.measure.positionRequests[0], {
        position: 1,
        channels: null,
      });
      // The non-blocking polarity warning from the detection is displayed.
      const warnings = await page.getByTestId('measure-warnings').textContent();
      assert.ok(
        warnings.includes('Reverse polarity') && warnings.includes('C'),
        `polarity warning should mention C: ${warnings}`,
      );
    });

    await t.test('page reload re-attaches the open session', async () => {
      const titlesBefore = rew.titles();
      await page.reload();
      // The restored session auto-reconnects REW and the bridge; the
      // assistant re-attaches to the session still open on the bridge.
      await waitForStatus(page, 're-attached', 60000);
      await page
        .getByTestId('measure-state')
        .filter(READY_STATE)
        .waitFor({ state: 'attached' });
      await page
        .getByTestId('measure-next-position')
        .filter({ hasText: '2 / 32' })
        .waitFor({ state: 'attached' });
      // The already-measured responses were NOT re-imported into REW.
      assert.deepEqual(rew.titles(), titlesBefore);
      // Wait for the reconnect processing lock to release.
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="create-averages"]').disabled,
        { timeout: 60000 },
      );
    });

    await t.test('measure position 2 with a channel subset', async () => {
      await page
        .getByTestId('measure-next-position')
        .filter({ hasText: '2 / 32' })
        .waitFor({ state: 'attached' });
      // Deselect C and SW2 (the labels toggle the hidden checkbox inputs).
      await page.getByTestId('measure-channel-C').click();
      await page.getByTestId('measure-channel-SW2').click();
      await page.getByTestId('measure-position').click();
      await waitForStatus(page, 'Position measured: 2', 120000);

      const titles = rew.titles();
      for (const channel of ['FL', 'FR', 'SW1']) {
        assert.ok(
          titles.includes(`${channel}_P02`),
          `missing measurement ${channel}_P02 in ${titles}`,
        );
      }
      assert.ok(!titles.includes('C_P02'), `C_P02 should not exist in ${titles}`);
      assert.ok(!titles.includes('SW2_P02'), `SW2_P02 should not exist in ${titles}`);
      // The subset reached the bridge as WIRE codes (SWMIX1, not SW1).
      assert.deepEqual(bridge.measure.positionRequests[1], {
        position: 2,
        channels: ['FL', 'FR', 'SWMIX1'],
      });
    });

    await t.test('subwoofer level matching start/stop', async () => {
      await page.getByTestId('measure-sublevel-start-SW1').click();
      // The scripted SPL series ends at 74.9 dB — the live value settles there.
      await page
        .getByTestId('measure-sublevel-spl-SW1')
        .filter({ hasText: '74.9' })
        .waitFor({ state: 'attached' });
      await page.getByTestId('measure-sublevel-stop-SW1').click();
      await page
        .getByTestId('measure-state')
        .filter(READY_STATE)
        .waitFor({ state: 'attached' });
    });

    await t.test('complete the session with the .mdat reminder', async () => {
      await page.getByTestId('measure-complete').click();
      await waitForStatus(page, '.mdat', 60000);
      await page
        .getByTestId('measure-state')
        .filter({ hasText: 'idle' })
        .waitFor({ state: 'attached' });
      await page.getByTestId('measure-start-session').waitFor({ state: 'visible' });
    });

    assert.deepEqual(
      harness.pageErrors,
      [],
      `page errors:\n${harness.pageErrors.join('\n')}`,
    );
    assertMockClean(rew, bridge);
  } finally {
    await stopHarness(harness);
  }
});
