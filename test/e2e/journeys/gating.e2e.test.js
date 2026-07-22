import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertMockClean,
  connectBridge,
  startHarness,
  stopHarness,
} from '../support/harness.js';

/**
 * Journey — RCH 2.0 operational chain gating: the application stays locked
 * until REW + bridge + a registered AVR are all available, and locks back
 * as soon as a link drops. The bridge mock starts WITHOUT a registered AVR
 * to walk the full discover → register path.
 */
test('gating: app locked until REW + bridge + AVR are all green', async t => {
  const harness = await startHarness({ bridge: { registered: false } });
  const { page, rew, bridge, pageErrors } = harness;

  try {
    await t.test('boots locked with the chain banner', async () => {
      await page.locator('#RewCommands.app-gated').waitFor({ state: 'attached' });
      const hint = await page.getByTestId('chain-blockers').textContent();
      assert.ok(hint.includes('REW'), `blockers should mention REW: ${hint}`);
      assert.ok(hint.includes('Bridge'), `blockers should mention the bridge: ${hint}`);
    });

    await t.test('bridge connects but the AVR is still missing', async () => {
      await connectBridge(page);
      await page
        .getByTestId('bridge-avr-state')
        .filter({ hasText: 'no AVR registered' })
        .waitFor({ state: 'attached' });
      await page.locator('#RewCommands.app-gated').waitFor({ state: 'attached' });
    });

    await t.test('discover then register the AVR', async () => {
      // A single AVR on the network: discovery fills the IP field directly
      // (no list, no extra click, no model input — the model comes from the
      // discovery response).
      await page.getByTestId('avr-discover').click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="avr-ip-input"]').value ===
          '192.168.1.99',
      );
      assert.equal(await page.getByTestId('discovered-avrs').count(), 0);
      await page.getByTestId('avr-register').click();
      await page
        .getByTestId('bridge-avr-state')
        .filter({ hasText: 'Denon AVC-A1H' })
        .waitFor({ state: 'attached' });
      await page.locator('#RewCommands.app-gated').waitFor({ state: 'attached' });
    });

    await t.test('REW connect completes the chain and unlocks the app', async () => {
      await page.getByTestId('rew-connect').click();
      await page
        .getByTestId('rew-version')
        .filter({ hasText: '5.40 beta 111' })
        .waitFor({ state: 'attached' });
      await page.locator('#RewCommands.app-gated').waitFor({ state: 'detached' });
      await page
        .locator('#measurements-container.app-gated')
        .waitFor({ state: 'detached' });
      const blockers = await page.getByTestId('chain-blockers').count();
      assert.equal(blockers, 0, 'no blockers hint once the chain is complete');
    });

    await t.test('dropping the bridge locks the app back', async () => {
      await page.getByTestId('bridge-connect').click();
      await page.locator('#RewCommands.app-gated').waitFor({ state: 'attached' });
    });

    assertMockClean(rew, bridge);
    assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join('\n')}`);
  } finally {
    await stopHarness(harness);
  }
});
