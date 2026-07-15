/**
 * Banc du solveur joint (target-match) sur les fixtures réelles multi-sub.
 *
 * Runner Node autonome (hors vitest) : exécute `optimizeSubwoofersJoint` sur
 * les fixtures data.test / data.bug / data.bis avec un seed fixe, et mesure
 * temps par phase, score final et RMS vs cible. Sert de référence de perf et
 * de qualité pour les optimisations du solveur :
 *   - l'empreinte `result` du JSON (scores, générations, params sérialisés)
 *     est déterministe à seed égal — c'est la surface de parité stricte ;
 *   - les temps (`timing`) sont informatifs, exclus de la comparaison.
 *
 * Usage :
 *   node test/bench/joint-solver.bench.js
 *     [--fixture data.test|data.bug|data.bis|all]   (défaut : all)
 *     [--budget full|quick]                         (défaut : full = prod)
 *     [--json]                     JSON complet sur stdout (logs sur stderr)
 *     [--compare <ref.json>]       compare au run de référence, exit ≠ 0 si écart
 *     [--mode strict|quality]      (défaut : strict)
 *     [--seed <n>]                 seed du solveur (défaut : 42) — pour les
 *                                  études de variance multi-seeds
 *       strict  : empreinte déterministe identique (scores, params au bit près)
 *       quality : ΔtargetRms ≤ 0,05 dB et Δscore ≥ −0,2 par fixture
 *
 * Cible : courbe plate ancrée au niveau de référence pondéré (moyenne de
 * puissance, mêmes formules que le Scorer) du plafond théorique (somme
 * cohérente des magnitudes brutes) sur la bande d'optimisation de la fixture.
 * Le clamp au plafond théorique du moteur façonne ensuite la cible effective.
 */
import { readFileSync } from 'node:fs';
import MultiSubOptimizer from '../../src/multi-sub-optimizer.js';
import Scorer from '../../src/optimizer/scoring.js';

const DEFAULT_SEED = 42;

const FIXTURE_PATHS = {
  'data.test': new URL('../fixtures/multi-sub-optimizer/data.test.js', import.meta.url),
  'data.bug': new URL('../fixtures/multi-sub-optimizer/data.bug.test.js', import.meta.url),
  'data.bis': new URL('../fixtures/multi-sub-optimizer/data.bis.test.js', import.meta.url),
};

const BUDGETS = {
  // full = défauts moteur (pop 80, gén 800/2500/800, patience 400) : la
  // config joint du moteur complète ce bloc via normalizeConfig.
  full: {},
  quick: {
    populationSize: 40,
    alignmentGenerations: 200,
    generations: 600,
    patience: 150,
  },
};

const QUALITY_MAX_RMS_DEGRADATION_DB = 0.05;
const QUALITY_MAX_SCORE_DEGRADATION = 0.2;

// Les logs du moteur et du banc vont sur stderr : stdout reste réservé au
// JSON (`--json` + redirection = capture de baseline).
const logLine = message => process.stderr.write(`${message}\n`);
const lm = {
  info: (...args) => logLine(`[opt] ${args.join(' ')}`),
  warn: (...args) => logLine(`[opt:warn] ${args.join(' ')}`),
  error: (...args) => logLine(`[opt:error] ${args.join(' ')}`),
  debug: () => {},
  success: (...args) => logLine(`[opt] ${args.join(' ')}`),
  downloadLogs: () => {},
  clearLogs: () => {},
};

function parseArgs(argv) {
  const options = {
    fixture: 'all',
    budget: 'full',
    json: false,
    compare: null,
    mode: 'strict',
    seed: DEFAULT_SEED,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--fixture') options.fixture = argv[++i];
    else if (arg.startsWith('--fixture=')) options.fixture = arg.slice('--fixture='.length);
    else if (arg === '--budget') options.budget = argv[++i];
    else if (arg.startsWith('--budget=')) options.budget = arg.slice('--budget='.length);
    else if (arg === '--compare') options.compare = argv[++i];
    else if (arg === '--mode') options.mode = argv[++i];
    else if (arg.startsWith('--mode=')) options.mode = arg.slice('--mode='.length);
    else if (arg === '--seed') options.seed = Number(argv[++i]);
    else if (arg.startsWith('--seed=')) options.seed = Number(arg.slice('--seed='.length));
    else throw new Error(`Argument inconnu : ${arg}`);
  }
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (options.fixture !== 'all' && !FIXTURE_PATHS[options.fixture]) {
    throw new Error(
      `--fixture doit être all ou ${Object.keys(FIXTURE_PATHS).join('|')}`,
    );
  }
  if (!BUDGETS[options.budget]) {
    throw new Error(`--budget doit être ${Object.keys(BUDGETS).join('|')}`);
  }
  if (options.mode !== 'strict' && options.mode !== 'quality') {
    throw new Error('--mode doit être strict ou quality');
  }
  if (!Number.isInteger(options.seed) || options.seed <= 0) {
    throw new Error('--seed doit être un entier positif');
  }
}

/**
 * Niveau de la cible plate : moyenne pondérée en puissance (formule du
 * referenceLevel du Scorer) du plafond théorique — la somme cohérente des
 * magnitudes brutes — sur la bande d'optimisation de la fixture.
 */
function computeFlatTargetLevel(frequencyResponses, band) {
  const freqs = frequencyResponses[0].freqs;
  let powerSum = 0;
  let weightSum = 0;

  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] < band.min || freqs[i] > band.max) continue;
    let linearSum = 0;
    for (const sub of frequencyResponses) {
      linearSum += Math.pow(10, sub.magnitude[i] / 20);
    }
    const weight = Scorer.computeFrequencyWeight(freqs[i]);
    powerSum += linearSum * linearSum * weight;
    weightSum += weight;
  }

  const meanPower = weightSum > 0 ? powerSum / weightSum : 0;
  return 10 * Math.log10(Math.max(meanPower, Number.EPSILON));
}

function buildBenchConfig(optimizerConfig, targetLevel, budgetOverrides, seed) {
  const config = structuredClone(optimizerConfig);
  config.optimization = {
    ...config.optimization,
    objective: 'target-match',
    targetCurve: { freqs: [5, 500], magnitude: [targetLevel, targetLevel] },
    joint: { seed, ...budgetOverrides },
  };
  return config;
}

function splitPhases(reportPhases) {
  const deterministic = {};
  const timings = {};
  for (const [name, phase] of Object.entries(reportPhases)) {
    if (!phase) {
      deterministic[name] = null;
      timings[name] = null;
      continue;
    }
    deterministic[name] = { generations: phase.generations, score: phase.score };
    timings[name] = phase.timeMs;
  }
  return { deterministic, timings };
}

async function runFixture(name, budgetName, seed) {
  const { frequencyResponses, optimizerConfig } = await import(
    FIXTURE_PATHS[name].href
  );
  const targetLevel = computeFlatTargetLevel(
    frequencyResponses,
    optimizerConfig.frequency,
  );
  const config = buildBenchConfig(
    optimizerConfig,
    targetLevel,
    BUDGETS[budgetName],
    seed,
  );
  const optimizer = new MultiSubOptimizer(frequencyResponses, config, lm);

  const started = performance.now();
  const { optimizedSubs, optimizationReport } = await optimizer.optimizeSubwoofersJoint({
    onProgress: progress => {
      if (progress.generation % 200 === 0) {
        logLine(
          `[bench] ${name} ${progress.phase} gén. ${progress.generation}/` +
            `${progress.generations} score ${progress.bestScore.toFixed(3)}`,
        );
      }
    },
  });
  const wallMs = performance.now() - started;

  const { deterministic, timings } = splitPhases(optimizationReport.phases);
  return {
    fixture: name,
    seed,
    budget: budgetName,
    targetLevelDb: targetLevel,
    // Partie déterministe à seed égal : l'empreinte de parité stricte.
    result: {
      baselineScore: optimizationReport.baseline.score,
      finalScore: optimizationReport.final.score,
      targetRms: optimizationReport.final.targetRms,
      phases: deterministic,
      params: optimizedSubs.map(sub => sub.param),
    },
    // Partie non déterministe, exclue des comparaisons.
    timing: {
      wallMs,
      executionTimeMs: optimizationReport.executionTimeMs,
      phases: timings,
    },
  };
}

function printHumanReport(records) {
  for (const record of records) {
    logLine(
      `\n=== ${record.fixture} — seed ${record.seed}, budget ${record.budget}, ` +
        `cible ${record.targetLevelDb.toFixed(2)} dB ===`,
    );
    logLine(
      `score ${record.result.baselineScore.toFixed(2)} → ` +
        `${record.result.finalScore.toFixed(2)}, ` +
        `target RMS ${record.result.targetRms.toFixed(3)} dB`,
    );
    for (const [name, phase] of Object.entries(record.result.phases)) {
      if (!phase) continue;
      const timeMs = record.timing.phases[name];
      logLine(
        `  ${name.padEnd(9)} ${String(phase.generations).padStart(4)} gén., ` +
          `score ${phase.score.toFixed(3)}, ${(timeMs / 1000).toFixed(1)} s`,
      );
    }
    logLine(`  total     ${(record.timing.wallMs / 1000).toFixed(1)} s`);
  }
}

function compareStrict(cur, ref, failures) {
  if (JSON.stringify(cur.result) === JSON.stringify(ref.result)) return;
  const details = [];
  if (cur.result.finalScore !== ref.result.finalScore) {
    details.push(`score ${ref.result.finalScore} → ${cur.result.finalScore}`);
  }
  if (cur.result.targetRms !== ref.result.targetRms) {
    details.push(`targetRms ${ref.result.targetRms} → ${cur.result.targetRms}`);
  }
  if (JSON.stringify(cur.result.params) !== JSON.stringify(ref.result.params)) {
    details.push('params différents');
  }
  if (JSON.stringify(cur.result.phases) !== JSON.stringify(ref.result.phases)) {
    details.push('phases différentes (générations/scores)');
  }
  failures.push(`${cur.fixture} [strict] : ${details.join(', ') || 'empreinte différente'}`);
}

function compareQuality(cur, ref, failures) {
  const rmsDelta = cur.result.targetRms - ref.result.targetRms;
  if (rmsDelta > QUALITY_MAX_RMS_DEGRADATION_DB) {
    failures.push(
      `${cur.fixture} [quality] : targetRms dégradé de ${rmsDelta.toFixed(3)} dB ` +
        `(max ${QUALITY_MAX_RMS_DEGRADATION_DB})`,
    );
  }
  const scoreDelta = cur.result.finalScore - ref.result.finalScore;
  if (scoreDelta < -QUALITY_MAX_SCORE_DEGRADATION) {
    failures.push(
      `${cur.fixture} [quality] : score dégradé de ${(-scoreDelta).toFixed(3)} ` +
        `(max ${QUALITY_MAX_SCORE_DEGRADATION})`,
    );
  }
}

function compareToReference(payload, referencePath, mode) {
  const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
  const failures = [];
  for (const ref of reference.fixtures) {
    const cur = payload.fixtures.find(record => record.fixture === ref.fixture);
    if (!cur) {
      failures.push(`${ref.fixture} : absent du run courant`);
      continue;
    }
    if (mode === 'strict') compareStrict(cur, ref, failures);
    else compareQuality(cur, ref, failures);
  }
  return failures;
}

// ---- main ----

const options = parseArgs(process.argv.slice(2));
const names = options.fixture === 'all' ? Object.keys(FIXTURE_PATHS) : [options.fixture];

const records = [];
for (const name of names) {
  records.push(await runFixture(name, options.budget, options.seed));
}
const payload = { seed: options.seed, budget: options.budget, fixtures: records };

printHumanReport(records);
if (options.json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (options.compare) {
  const failures = compareToReference(payload, options.compare, options.mode);
  if (failures.length > 0) {
    for (const failure of failures) logLine(`❌ ${failure}`);
    throw new Error(
      `${failures.length} écart(s) vs ${options.compare} (mode ${options.mode})`,
    );
  }
  logLine(`✅ conforme à ${options.compare} (mode ${options.mode})`);
}
