import * as coarseSearch from './coarse-search.js';
import * as evaluation from './evaluation.js';
import * as flow from './flow.js';
import * as geneticSearch from './genetic-search.js';
import * as localSearch from './local-search.js';
import * as measurements from './measurements.js';
import * as parameters from './params.js';
import * as responses from './response.js';
import * as results from './result.js';
import * as subSearch from './sub-search.js';

/**
 * Public instance methods exposed by MultiSubOptimizer for UI code and tests.
 * Keep these wrappers thin; implementation belongs in the focused optimizer modules.
 */
export default class OptimizerFacadeMethods {
  validateMeasurements(subMeasurements) {
    if (!subMeasurements || subMeasurements.length < 2) {
      throw new Error('At least 2 subwoofer measurements required');
    }

    for (const [index, frequencyResponse] of subMeasurements.entries()) {
      responses.validateResponseArrays(frequencyResponse, `Sub ${index}`);
      if (!frequencyResponse.measurement) {
        throw new Error('Measurement UUID is required');
      }
    }
  }

  get _cacheHits() {
    return this._evaluationCache.hits;
  }

  set _cacheHits(value) {
    this._evaluationCache.hits = value;
  }

  get _cacheMisses() {
    return this._evaluationCache.misses;
  }

  set _cacheMisses(value) {
    this._evaluationCache.misses = value;
  }

  generateTestParams(stepFactor = 1) {
    return parameters.generateTestParams(this.config, stepFactor);
  }

  optimizeSubwoofers() {
    return flow.optimizeSubwoofers(this);
  }

  prepareMeasurements() {
    return measurements.prepareMeasurements(this);
  }

  refineOptimizedSubsGlobally(preparedSubs, result) {
    return results.refineOptimizedSubsGlobally(this, preparedSubs, result);
  }

  calculateEfficiencyRatio(actualResponse, theoreticalResponse) {
    return evaluation.calculateEfficiencyRatio(this, actualResponse, theoreticalResponse);
  }

  _runSingleGeneticRun(subToOptimize, previousValidSum, theo, coarseBest, options) {
    return geneticSearch.runSingleGeneticRun(
      this,
      subToOptimize,
      previousValidSum,
      theo,
      coarseBest,
      options,
    );
  }

  runGeneticOptimization(subToOptimize, previousValidSum, theo, testParamsList, options) {
    return geneticSearch.runGeneticOptimization(
      this,
      subToOptimize,
      previousValidSum,
      theo,
      testParamsList,
      options,
    );
  }

  runClassicOptimization(subToOptimize, previousValidSum, theo, testParamsList) {
    return coarseSearch.runClassicOptimization(
      this,
      subToOptimize,
      previousValidSum,
      theo,
      testParamsList,
    );
  }

  findTopCoarseParams(
    subToOptimize,
    previousValidSum,
    theo,
    testParamsList,
    coarseSeedCount = 1,
  ) {
    return coarseSearch.findTopCoarseParams(
      this,
      subToOptimize,
      previousValidSum,
      theo,
      testParamsList,
      coarseSeedCount,
    );
  }

  getFinalSubSum() {
    return responses.getFinalSubSum(this);
  }

  calculateFrequencyWeights(frequencies) {
    return measurements.calculateFrequencyWeights(this, frequencies);
  }

  displayResponse(response) {
    return responses.displayResponse(response);
  }

  calculateCombinedResponse(
    subs,
    theoreticalResponse,
    realisticTheoreticalResponse,
    options,
  ) {
    return responses.calculateCombinedResponse(
      subs,
      theoreticalResponse,
      realisticTheoreticalResponse,
      options,
    );
  }

  calculateResponseWithParams(sub) {
    return responses.calculateResponseWithParams(sub);
  }

  calculateQualityScore(response, theoreticalMax) {
    return evaluation.calculateQualityScore(this, response, theoreticalMax);
  }

  calculateOptimizationScore(response, theoreticalMax) {
    return evaluation.calculateOptimizationScore(this, response, theoreticalMax);
  }

  evaluateParameters(subToOptimize, previousValidSum, theoreticalMax, options) {
    return evaluation.evaluateParameters(
      this,
      subToOptimize,
      previousValidSum,
      theoreticalMax,
      options,
    );
  }

  evaluateParametersCached(subToOptimize, previousValidSum, theoreticalMax, options) {
    return evaluation.evaluateParametersCached(
      this,
      subToOptimize,
      previousValidSum,
      theoreticalMax,
      options,
    );
  }

  localSearch(
    param,
    subToOptimize,
    previousValidSum,
    theoreticalMax,
    maxIterations = 30,
  ) {
    return localSearch.localSearch({
      config: this.config,
      param,
      subToOptimize,
      previousValidSum,
      theoreticalMax,
      maxIterations,
      evaluateParametersCached: (candidate, previous, target) =>
        this.evaluateParametersCached(candidate, previous, target, { validate: false }),
    });
  }

  get _random() {
    return this._ga._random;
  }

  set _random(fn) {
    this._ga._random = fn;
  }

  _createSeededRandom(seed) {
    return this._ga._createSeededRandom(seed);
  }

  chooseBestSolution(bestWithAllPass, bestWithoutAllPass) {
    return subSearch.chooseBestSolution(this, bestWithAllPass, bestWithoutAllPass);
  }
}
