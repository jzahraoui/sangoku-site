import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startHarness, stopHarness, waitForStatus } from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

// Niveau côté REW d'une projection (mesure impulsionnelle depuis ADR 003) :
// niveau autour de 40 Hz calculé par le mock lui-même.
const rewLevel = (rew, title) => {
  const record = [...rew.store.measurements.values()].find(r => r.title === title);
  return record ? rew.store.levelAround(record, 40, 1) : null;
};

const splState = (page, rew) =>
  page
    .evaluate(() => {
      const vm = globalThis.viewModel;
      const by = title => vm.measurements().find(m => m.title() === title);
      const proj = by('LFE predicted_P1');
      return {
        sw1: by('SW1avg')?.splOffsetdB() ?? null,
        sw2: by('SW2avg')?.splOffsetdB() ?? null,
        projUuid: proj?.uuid ?? null,
        projCount: vm.measurements().filter(m => m.title() === 'LFE predicted_P1').length,
        theoCount: vm
          .measurements()
          .filter(m => m.title() === 'LFE Max Sum Theo_P1').length,
      };
    })
    .then(state => ({
      ...state,
      projLevel: rewLevel(rew, 'LFE predicted_P1'),
      theoLevel: rewLevel(rew, 'LFE Max Sum Theo_P1'),
    }));

const connectAndWait = async page => {
  await page.getByTestId('rew-connect').click();
  await page
    .getByTestId('rew-version')
    .filter({ hasText: '5.40 beta 111' })
    .waitFor({ state: 'attached' });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="create-averages"]').disabled,
    { timeout: 60000 },
  );
};

const trimUp = async page => {
  await page.evaluate(() => globalThis.viewModel.increaseSubTrimGain());
  await page.waitForFunction(() => !globalThis.viewModel.isProcessing(), {
    timeout: 120000,
  });
};

test('trim gain: commande de groupe — subs décalés, projections recalculées', async t => {
  const harness = await startHarness();
  const { page, rew } = harness;

  try {
    await connectAndWait(page);
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

    await t.test('trim + dans la session courante', async () => {
      const before = await splState(page, rew);
      assert.equal(before.projCount, 1);
      assert.equal(before.theoCount, 1, 'Theo absente après align-sub');
      await trimUp(page);
      const after = await splState(page, rew);

      assert.ok(Math.abs(after.sw1 - before.sw1 - 0.5) < 0.01, `SW1: ${before.sw1} -> ${after.sw1}`);
      assert.ok(Math.abs(after.sw2 - before.sw2 - 0.5) < 0.01, `SW2: ${before.sw2} -> ${after.sw2}`);
      // Les projections suivent par RECALCUL : le niveau REW monte de +0.5 dB.
      assert.ok(
        Math.abs(after.projLevel - before.projLevel - 0.5) < 0.05,
        `predicted: ${before.projLevel} -> ${after.projLevel}`,
      );
      assert.ok(
        Math.abs(after.theoLevel - before.theoLevel - 0.5) < 0.05,
        `Theo: ${before.theoLevel} -> ${after.theoLevel}`,
      );
      assert.equal(after.projCount, 1, 'projection dupliquée ou absente');
      assert.equal(after.theoCount, 1, 'Theo dupliquée ou absente');
      assert.notEqual(after.projUuid, before.projUuid, 'projection non recalculée');
    });

    await t.test('trim + après rechargement de session (scénario du bug)', async () => {
      await page.reload({ waitUntil: 'load' });
      await connectAndWait(page);
      await page.waitForFunction(
        () => globalThis.viewModel.measurements().length > 0,
        { timeout: 60000 },
      );

      const before = await splState(page, rew);
      assert.equal(before.projCount, 1, 'projection non restaurée');
      assert.equal(before.theoCount, 1, 'Theo non restaurée');
      await trimUp(page);
      const after = await splState(page, rew);

      assert.ok(Math.abs(after.sw1 - before.sw1 - 0.5) < 0.01, `SW1: ${before.sw1} -> ${after.sw1}`);
      assert.ok(
        Math.abs(after.projLevel - before.projLevel - 0.5) < 0.05,
        `predicted: ${before.projLevel} -> ${after.projLevel}`,
      );
      assert.ok(
        Math.abs(after.theoLevel - before.theoLevel - 0.5) < 0.05,
        `Theo (adoptée) non suivie: ${before.theoLevel} -> ${after.theoLevel}`,
      );
      assert.equal(after.projCount, 1, 'projection dupliquée après restauration');
      assert.equal(after.theoCount, 1, 'Theo dupliquée après restauration');
      assert.notEqual(after.projUuid, before.projUuid, 'projection restaurée non adoptée/recalculée');
    });
  } finally {
    await stopHarness(harness);
  }
});
