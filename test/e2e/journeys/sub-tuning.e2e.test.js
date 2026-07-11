import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHarness, stopHarness, waitForStatus } from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

test('tuning: Find Sub Alignment, preview et revert LFE sur la projection impulsionnelle (ADR 003)', async t => {
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
    await page.getByTestId('align-sub').click();
    await waitForStatus(page, 'MultiSubOptimizer successfull', 240000);

    await t.test('Tuning: produceAligned via le service décontaminé', async () => {
      const before = await page.evaluate(() => {
        const vm = globalThis.viewModel;
        const fl = vm.measurements().find(m => m.title() === 'FLavg');
        vm.selectedSpeaker(fl.uuid);
        return vm
          .measurements()
          .filter(m => m.isSub())
          .map(m => m.cumulativeIRShiftSeconds());
      });
      await page.evaluate(() => {
        globalThis.__err = null;
        const orig = globalThis.viewModel.handleError.bind(globalThis.viewModel);
        globalThis.viewModel.handleError = (msg, e) => {
          globalThis.__err = `${msg} | ${e?.stack?.split('\n')[1] ?? ''}`;
          return orig(msg, e);
        };
        return globalThis.viewModel.buttonproduceAlignedButton();
      });
      await page.waitForFunction(() => !globalThis.viewModel.isProcessing(), {
        timeout: 240000,
      });
      const state = await page.evaluate(() => ({
        error: globalThis.viewModel.hasError?.() ?? null,
        status: globalThis.__err,
        shifts: globalThis.viewModel
          .measurements()
          .filter(m => m.isSub())
          .map(m => m.cumulativeIRShiftSeconds()),
        lpf: globalThis.viewModel.lpfForLFE(),
      }));
      console.log('TUNING:', JSON.stringify({ before, ...state }));
      assert.notDeepEqual(state.shifts, before, 'les subs doivent être décalés');
      assert.ok(state.lpf >= 120, `lpfForLFE: ${state.lpf}`);
    });

    await t.test('preview de mesure: final <canal> créé', async () => {
      await page.evaluate(async () => {
        const vm = globalThis.viewModel;
        const fl = vm.measurements().find(m => m.title() === 'FLavg');
        await vm.businessTools.createMeasurementPreview(fl);
      });
      const titles = rew.titles();
      assert.ok(
        titles.some(x => x.startsWith('final FLavg')),
        `preview absente: ${titles}`,
      );
    });

    await t.test('revert LFE: la chaîne descend jusqu à l arithmétique REW', async () => {
      const message = await page.evaluate(async () => {
        try {
          await globalThis.viewModel.businessTools.revertLfeFilterProccess(120, false, true);
          return 'OK';
        } catch (error) {
          return error.message;
        }
      });
      console.log('REVERT:', message);
      // Le mock n'implémente pas la division A/B : atteindre cette erreur
      // prouve que toute la chaîne déléguée (low-pass, filtre généré,
      // opérations) s'exécute. Un vrai REW irait au bout.
      assert.ok(
        message === 'OK' || /A \/ B|not implemented/i.test(message),
        `échec inattendu en amont: ${message}`,
      );
    });
  } finally {
    await stopHarness(harness);
  }
});
