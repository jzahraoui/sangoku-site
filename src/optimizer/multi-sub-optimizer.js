/**
 * MultiSubOptimizer is the public entry point for the multi-sub optimization workflow.
 *
 * Contributor map:
 * - Keep public method names stable; UI code and tests call the facade methods.
 * - Instance compatibility wrappers live in facade-methods.js.
 * - Put behavior in focused optimizer modules, then delegate from the facade layer.
 * - Add new responsibilities as small modules instead of growing this class again.
 */
import GeneticAlgorithm from './genetic-algorithm.js';
import OptimizerFacadeMethods from './facade-methods.js';
import { createEvaluationCache } from './cache.js';
import {
  DEFAULT_CONFIG as OPTIMIZER_DEFAULT_CONFIG,
  EMPTY_CONFIG as OPTIMIZER_EMPTY_CONFIG,
  normalizeConfig,
  validateOptimizerConfig,
} from './config.js';
import { countAllPossibleCombinations } from './params.js';
import {
  AUDIO_SELECTION,
  compareAudioCandidates,
  selectBestAudioCandidate,
} from './audio-selection.js';

class MultiSubOptimizer extends OptimizerFacadeMethods {
  static DEFAULT_CONFIG = OPTIMIZER_DEFAULT_CONFIG;

  static EMPTY_CONFIG = OPTIMIZER_EMPTY_CONFIG;

  static AUDIO_SELECTION = AUDIO_SELECTION;

  static selectBestAudioCandidate(candidates = []) {
    return selectBestAudioCandidate(candidates);
  }

  static compareAudioCandidates(a, b) {
    return compareAudioCandidates(a, b);
  }

  /**
   * @param {Array} subMeasurements - Array of subwoofer frequency response measurements
   * @param {Object} config - Configuration object for optimization parameters
   */
  constructor(subMeasurements, config, lm) {
    super();
    if (!lm) {
      throw new Error('Logger instance is required');
    }
    this.config = normalizeConfig(config ?? MultiSubOptimizer.DEFAULT_CONFIG);
    validateOptimizerConfig(this.config);
    this.validateMeasurements(subMeasurements);
    this.subMeasurements = subMeasurements;
    this.optimizedSubs = [];
    this.frequencyWeights = null;
    this.theoreticalMaxResponse = null;

    this.lm = lm;

    // Evaluation cache for performance optimization
    this._evaluationCache = createEvaluationCache();

    // Scoring engine and genetic algorithm engine
    this._scorer = null;
    this._ga = new GeneticAlgorithm(this.config);

    // 1. Initial measurements preparation
    this.preparedSubs = this.prepareMeasurements();

    // Calculate theoretical maximum response
    this.theoreticalMaxResponse = this.calculateCombinedResponse(
      this.preparedSubs,
      true,
      false,
      { validate: false },
    );
    this.allPossibleCombinationsCount = countAllPossibleCombinations(this.config);
  }
}

export default MultiSubOptimizer;
