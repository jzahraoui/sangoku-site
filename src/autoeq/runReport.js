/**
 * runReport.js
 *
 * Builds the structured audit report of an AutoEQ run (spec FR-016/FR-017/
 * FR-018, périmètre v1) : before/after metrics, max combined boost, per-filter
 * verdicts and a global PASS/WARN/FAIL verdict.
 * Pure functions — all context passed as parameters.
 */

import {
  createPeakingProfiles,
  sumProfilesDbAtFrequency,
} from '../dsp/peakingProfiles.js';

/**
 * Maximum combined positive contribution of the filters over the scan grid
 * (headroom impact of the EQ, in dB).
 *
 * @param {Array<{fc:number, Q:number, gain:number}>} filters
 * @param {{scanFreqs: ArrayLike<number>}} calculationContext
 * @param {number} sampleRate
 * @returns {number}
 */
export function computeMaxCombinedBoostDb(filters, calculationContext, sampleRate) {
  if (filters.length === 0) return 0;
  const profiles = createPeakingProfiles(filters, sampleRate);
  const { scanFreqs } = calculationContext;
  let maxBoost = 0;
  for (let i = 0; i < scanFreqs.length; i += 2) {
    const combined = sumProfilesDbAtFrequency(profiles, scanFreqs[i], sampleRate);
    if (combined > maxBoost) maxBoost = combined;
  }
  return maxBoost;
}

/**
 * Assembles the run report.
 *
 * Global verdict:
 *   FAIL — a filter fails a safety threshold, or the run degrades the full RMS
 *   WARN — filter warnings, residual overshoot above maxAllowedOvershoot,
 *          or improvement below 10 % (SC-004)
 *   PASS — otherwise
 *
 * @param {object} p
 * @param {Array}  p.filters
 * @param {object} p.beforeQuality      - FilterQualityEvaluator.evaluate([], ctx)
 * @param {object} p.afterQuality       - FilterQualityEvaluator.evaluate(filters, ctx)
 * @param {Array}  p.filterVerdicts     - FilterQualityEvaluator.buildFilterVerdicts()
 * @param {number} p.maxCombinedBoostDb
 * @param {number} p.overallMaxBoostDb
 * @param {number} p.maxAllowedOvershoot
 * @returns {object} report
 */
export function buildRunReport({
  filters,
  beforeQuality,
  afterQuality,
  filterVerdicts,
  maxCombinedBoostDb,
  overallMaxBoostDb,
  maxAllowedOvershoot,
}) {
  const warnings = [];
  let verdict = 'PASS';

  if (filterVerdicts.some(f => f.verdict === 'FAIL')) {
    verdict = 'FAIL';
    warnings.push('au moins un filtre dépasse un plafond de sécurité');
  }
  if (filters.length > 0 && afterQuality.fullRms > beforeQuality.fullRms) {
    verdict = 'FAIL';
    warnings.push(
      `la correction dégrade le RMS global (${beforeQuality.fullRms.toFixed(2)} → ${afterQuality.fullRms.toFixed(2)} dB)`,
    );
  }

  const improvementPct =
    beforeQuality.fullRms > 0
      ? ((beforeQuality.fullRms - afterQuality.fullRms) / beforeQuality.fullRms) * 100
      : 0;

  if (verdict === 'PASS') {
    if (filterVerdicts.some(f => f.verdict === 'WARN')) {
      verdict = 'WARN';
    }
    if (afterQuality.maxOvershoot > maxAllowedOvershoot) {
      verdict = 'WARN';
      warnings.push(
        `overshoot résiduel ${afterQuality.maxOvershoot.toFixed(2)} dB > seuil ${maxAllowedOvershoot} dB`,
      );
    }
    if (filters.length > 0 && improvementPct < 10) {
      verdict = 'WARN';
      warnings.push(`amélioration RMS ${improvementPct.toFixed(1)} % < 10 %`);
    }
    if (maxCombinedBoostDb > overallMaxBoostDb + 0.05) {
      verdict = 'WARN';
      warnings.push(
        `boost combiné ${maxCombinedBoostDb.toFixed(2)} dB > limite globale ${overallMaxBoostDb} dB`,
      );
    }
  }

  const pick = quality => ({
    fullRms: quality.fullRms,
    criticalRms: quality.criticalRms,
    positiveRms: quality.positiveRms,
    maxOvershoot: quality.maxOvershoot,
  });

  return {
    verdict,
    warnings,
    improvementPct,
    before: pick(beforeQuality),
    after: pick(afterQuality),
    maxCombinedBoostDb,
    filters: filterVerdicts,
  };
}

/**
 * Writes the report to the run log.
 *
 * @param {object} report
 * @param {(msg: string) => void} onLog
 */
export function logRunReport(report, onLog) {
  onLog('\n=== Rapport de validation ===');
  onLog(`Verdict: ${report.verdict}`);
  onLog(
    `RMS full: ${report.before.fullRms.toFixed(2)} → ${report.after.fullRms.toFixed(2)} dB ` +
      `(${report.improvementPct.toFixed(1)} %) | mid: ${report.before.criticalRms.toFixed(2)} → ${report.after.criticalRms.toFixed(2)} dB`,
  );
  onLog(
    `Overshoot max: ${report.after.maxOvershoot.toFixed(2)} dB | Boost combiné max: ${report.maxCombinedBoostDb.toFixed(2)} dB`,
  );
  for (const warning of report.warnings) {
    onLog(`  ⚠ ${warning}`);
  }
  for (const filter of report.filters) {
    if (filter.verdict !== 'PASS') {
      onLog(
        `  ${filter.verdict} fc=${filter.fc.toFixed(1)} Hz Q=${filter.Q.toFixed(2)} ` +
          `gain=${filter.gain.toFixed(2)} dB — ${filter.warnings.join(' ; ')}`,
      );
    }
  }
}
