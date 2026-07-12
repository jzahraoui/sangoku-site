import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHarness, stopHarness, waitForStatus } from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

test('align sub: projection LFE predicted + Theo, equalize via la projection (ADR 003)', async t => {
  const harness = await startHarness();
  const { page, rew } = harness;

  try {
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
    await page.getByTestId('time-align').click();
    await waitForStatus(page, 'Align peaks successful', 180000);
    await page.getByTestId('align-spl').click();
    await waitForStatus(page, 'SPL alignment successful', 240000);

    await t.test('align-sub projette LFE predicted + Theo, sans LFE Max Sum', async () => {
      // Plante un filtre EQ résiduel sur un sub : l'alignement doit repartir
      // d'un état propre (filtres purgés avant la capture des réponses).
      await page.evaluate(() =>
        globalThis.viewModel
          .measurements()
          .find(m => m.title() === 'SW1avg')
          .setSingleFilter({
            index: 1,
            type: 'PK',
            enabled: true,
            isAuto: false,
            frequency: 60,
            gain: 3,
            q: 2,
          }),
      );

      await page.getByTestId('align-sub').click();
      await waitForStatus(page, 'MultiSubOptimizer successfull', 240000);

      const sw1Filters = await page.evaluate(async () => {
        const sub = globalThis.viewModel.measurements().find(m => m.title() === 'SW1avg');
        const filters = await sub.getFilters();
        return filters.filter(f => f.type !== 'None').map(f => f.type);
      });
      assert.deepEqual(sw1Filters, [], `filtres résiduels sur SW1avg: ${sw1Filters}`);

      const titles = rew.titles();
      assert.ok(titles.includes('LFE predicted_P1'), `REW: ${titles}`);
      assert.ok(titles.includes('LFE Max Sum Theo_P1'), `Theo absente: ${titles}`);
      assert.ok(!titles.includes('LFE Max Sum'), `LFE Max Sum ne doit plus exister: ${titles}`);

      const state = await page.evaluate(() => {
        const vm = globalThis.viewModel;
        const proj = vm.measurements().find(m => m.title() === 'LFE predicted_P1');
        return {
          owned: vm.virtualSubwooferService.subwooferFor(proj ? '1' : 'x').projectionUuid,
          projUuid: proj?.uuid ?? null,
          flag: proj?.isSubOperationResult ?? null,
          theoFlag: vm
            .measurements()
            .find(m => m.title() === 'LFE Max Sum Theo_P1')?.isSubOperationResult ?? null,
        };
      });
      assert.equal(state.owned, state.projUuid, 'uuid possédé ≠ liste');
      assert.equal(state.flag, true);
      assert.equal(state.theoFlag, true, 'Theo sans flag isSubOperationResult');
    });

    await t.test('equalize-sub passe par la projection', async () => {
      await page.getByTestId('equalize-sub').click();
      await page.waitForFunction(() => !globalThis.viewModel.isProcessing(), {
        timeout: 240000,
      });
      const state = await page.evaluate(() => ({
        error: globalThis.viewModel.hasError?.() ?? null,
        count: globalThis.viewModel
          .measurements()
          .filter(m => m.title() === 'LFE predicted_P1').length,
      }));
      assert.equal(state.count, 1, 'projection dupliquée ou absente');
      const titles = rew.titles();
      assert.equal(titles.filter(x => x === 'LFE predicted_P1').length, 1, `REW: ${titles}`);
      // Theo est recalculée par la commande setFilters — toujours unique.
      assert.equal(
        titles.filter(x => x === 'LFE Max Sum Theo_P1').length,
        1,
        `Theo: ${titles}`,
      );
    });
  } finally {
    await stopHarness(harness);
  }
});
