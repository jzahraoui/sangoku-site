/**
 * initialMetrics.js
 *
 * Creates the SpanAnalyzer and FastMSE instances needed at the start of the
 * AutoEQ pipeline, and computes the baseline MSE.
 * Pure factory — no class state; all context passed as parameters.
 */

import { SpanAnalyzer } from './SpanAnalyzer.js';
import { FastMSE } from '../optimization/FastMSE.js';

/**
 * @param {Object} config               - AutoEQ config fields
 * @param {number}   config.matchRangeStart
 * @param {number}   config.matchRangeEnd
 * @param {number}   config.flatnessTarget
 * @param {number}   config.sampleRate
 * @param {number}   config.notchExclusionThreshold
 * @param {number}   config.overallMaxBoostDb
 * @param {Object} calculationContext   - GridCalculationContext instance
 * @returns {{ spanAnalyzer: SpanAnalyzer, fastMSE: FastMSE, initialMSE: number }}
 */
export function createInitialMetrics(config, calculationContext) {
  const spanAnalyzer = new SpanAnalyzer(
    config.matchRangeStart,
    config.matchRangeEnd,
    config.flatnessTarget,
    config.sampleRate,
    config.notchExclusionThreshold,
  );

  spanAnalyzer.initFromGrid(
    calculationContext.scanFreqs,
    calculationContext.measuredArr,
    calculationContext.targetArr,
  );

  const initSpans = spanAnalyzer.calcSpansExclNotches([]);
  const fastMSE = new FastMSE(config.overallMaxBoostDb, config.sampleRate);

  fastMSE.initFromGrid(
    initSpans,
    calculationContext.scanFreqs,
    calculationContext.measuredArr,
    calculationContext.targetArr,
  );

  return {
    spanAnalyzer,
    fastMSE,
    initialMSE: Math.sqrt(fastMSE.compute([])),
  };
}
