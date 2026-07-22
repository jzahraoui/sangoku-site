import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectBridge, startHarness, stopHarness, waitForStatus } from '../support/harness.js';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const ADY_FIXTURE = path.join(FIXTURES_DIR, 'sample.ady');

test('align sub joint : filtres PK par sub + projection, cible target-match', async t => {
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
    await page.getByTestId('time-align').click();
    await waitForStatus(page, 'Time align successful', 180000);
    await page.getByTestId('align-spl').click();
    await waitForStatus(page, 'SPL alignment successful', 240000);

    await t.test('le solveur joint applique des filtres PK individuels', async () => {
      // Budget réduit (hook de test, pas d'UI) : le parcours valide le
      // câblage produit, pas la qualité de convergence — couverte par les
      // tests moteur.
      // L'input natif du checkbox-container est masqué par le style : on
      // passe par l'observable, comme les autres parcours.
      await page.evaluate(() => {
        // Depuis que la réserve d'alignement est mesurée sur des IR vraiment
        // filtrées (mock /eq/impulse-response), le solveur aligne les subs
        // jouets par délais purs et ses filtres tombent sous le seuil
        // utilisateur de 0.4 dB (« below min filter gain … discarded »).
        // Seuil à 0 : le parcours valide le câblage des filtres (gaindB,
        // isAuto, slots), pas la pertinence acoustique du jouet.
        globalThis.viewModel.autoEqConfig.minFilterGain(0);
        globalThis.viewModel.jointOptimizerBudget({
          filtersPerSub: 2,
          populationSize: 12,
          alignmentGenerations: 30,
          generations: 60,
          patience: 60,
          // Seed du PRNG du solveur (joint.seed → xorshift32) : le parcours
          // était flaky — sur les subs jouets, un run non seedé converge
          // parfois vers le génome neutre (tous les gains PK à 0 dB) et
          // l'assertion « au moins un gain non nul » tombait au hasard.
          // Seedé, le run est déterministe et ce seed produit des gains
          // non nuls — vérifié sur plusieurs exécutions. Re-seedé (2 → 3)
          // au chantier perf du solveur (grille décimée du Lot 6) : la
          // trajectoire a changé et le génome neutre gagnait avec le seed 2
          // (CLAUDE.md invariant 3 — balayage prévu à chaque changement de
          // trajectoire).
          seed: 3,
        });
        globalThis.viewModel.useJointSubOptimization(true);
      });

      await page.getByTestId('align-sub').click();
      await waitForStatus(page, 'MultiSubOptimizer successfull', 240000);

      // La projection et sa référence Theo existent, pas de LFE Max Sum.
      const titles = rew.titles();
      assert.ok(titles.includes('LFE predicted_P1'), `REW: ${titles}`);
      assert.ok(titles.includes('LFE Max Sum Theo_P1'), `Theo absente: ${titles}`);
      assert.ok(
        !titles.includes('LFE Max Sum'),
        `LFE Max Sum ne doit plus exister: ${titles}`,
      );

      // Chaque sub porte des filtres PK individuels non-auto (slots 1..N) —
      // c'est la signature du process joint vs la recopie d'EQ commune.
      const subFilters = await page.evaluate(async () => {
        const vm = globalThis.viewModel;
        const subs = vm.measurements().filter(m => /^SW\d+avg$/.test(m.title()));
        const result = {};
        for (const sub of subs) {
          const filters = await sub.getFilters();
          result[sub.title()] = filters
            .filter(f => f.type === 'PK' && f.enabled)
            .map(f => ({ index: f.index, isAuto: f.isAuto, gaindB: f.gaindB }));
        }
        return result;
      });

      const subNames = Object.keys(subFilters);
      assert.ok(subNames.length > 1, `subs introuvables: ${subNames}`);
      const subsWithFilters = subNames.filter(name => subFilters[name].length > 0);
      assert.ok(
        subsWithFilters.length > 0,
        `aucun filtre PK individuel appliqué: ${JSON.stringify(subFilters)}`,
      );
      for (const name of subsWithFilters) {
        for (const filter of subFilters[name]) {
          assert.equal(filter.isAuto, false, `${name} slot ${filter.index} isAuto`);
          assert.ok(filter.index <= 19, `${name} slot ${filter.index} > 19`);
        }
      }
      // Le gain doit arriver dans le champ REW `gaindB` — avec la clé `gain`
      // (ignorée silencieusement) tous les filtres restaient à 0 dB.
      const activeGains = subsWithFilters.flatMap(name =>
        subFilters[name].map(f => f.gaindB),
      );
      assert.ok(
        activeGains.some(g => typeof g === 'number' && Math.abs(g) > 0.01),
        `tous les filtres PK sont restés à 0 dB: ${JSON.stringify(subFilters)}`,
      );
    });
  } finally {
    await stopHarness(harness);
  }
});
