import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectBridge, startHarness, stopHarness, waitForStatus } from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

test('preview sub: la projection LFE predicted suit le sub virtuel (ADR 003)', async t => {
  const harness = await startHarness();
  const { page, rew } = harness;

  try {
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

    await t.test('preview-sub crée la projection', async () => {
      await page.getByTestId('preview-sub').click();
      await page.waitForFunction(() => !globalThis.viewModel.isProcessing(), {
        timeout: 120000,
      });

      const state = await page.evaluate(() => {
        const vm = globalThis.viewModel;
        const proj = vm.measurements().find(m => m.title() === 'LFE predicted_P1');
        return {
          error: vm.hasError?.() ?? null,
          titles: vm.measurements().map(m => m.title()),
          projFlag: proj ? proj.isSubOperationResult : null,
          owned: vm.virtualSubwooferService.subwooferFor('1').projectionUuid,
          projUuid: proj?.uuid ?? null,
          subsCount: vm.measurements().filter(m => m.isSub()).length,
        };
      });

      assert.ok(rew.titles().includes('LFE predicted_P1'), `REW: ${rew.titles()}`);
      assert.equal(state.projFlag, true, 'flag transition manquant');
      assert.equal(state.owned, state.projUuid, 'uuid possédé ≠ uuid de la liste');
      assert.equal(state.subsCount, 2, 'les subs réels doivent rester au nombre de 2');
    });

    await t.test('second preview-sub remplace la projection', async () => {
      const before = rew.titles().filter(x => x === 'LFE predicted_P1').length;
      assert.equal(before, 1);
      await page.getByTestId('preview-sub').click();
      await page.waitForFunction(() => !globalThis.viewModel.isProcessing(), {
        timeout: 120000,
      });
      const count = rew.titles().filter(x => x === 'LFE predicted_P1').length;
      assert.equal(count, 1, `duplicats: ${rew.titles()}`);
    });
  } finally {
    await stopHarness(harness);
  }
});
