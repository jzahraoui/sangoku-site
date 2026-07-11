export const DEFAULT_CONFIG = {
  frequency: {
    min: 20,
    max: 200,
  },
  gain: {
    min: 0,
    max: 0,
    step: 0.1,
  },
  delay: {
    min: -0.005,
    max: 0.005,
    step: 0.00001,
  },
  allPass: {
    enabled: false,
    frequency: {
      min: 10,
      max: 100,
      step: 1,
    },
    q: {
      min: 0.1,
      max: 0.5,
      step: 0.1,
    },
  },
  optimization: {
    objective: 'balanced',
    theoreticalWeight: 0.75,
    globalRefinement: {
      enabled: false,
      passes: 1,
      maxIterations: 20,
    },
    multiStart: {
      enabled: false,
      runs: 2,
      coarseSeedCount: 8,
      minRunImprovement: 0.25,
    },
  },
};

export const EMPTY_CONFIG = Object.freeze({
  delay: 0,
  gain: 0,
  polarity: 1,
  allPass: Object.freeze({
    frequency: 0,
    q: 0,
    enabled: false,
  }),
  // Per-sub peaking biquads ({ frequency, gain, q }), applied on top of
  // delay/polarity/gain. Empty by default: the historical pipeline never
  // sets them; the joint (target-match) solver does.
  filters: Object.freeze([]),
});

export function normalizeConfig(config = {}) {
  const source = config ?? {};
  const allPass = source.allPass ?? {};
  const optimization = source.optimization ?? {};
  const globalRefinement =
    typeof optimization.globalRefinement === 'boolean'
      ? { enabled: optimization.globalRefinement }
      : (optimization.globalRefinement ?? {});
  const multiStart =
    typeof optimization.multiStart === 'boolean'
      ? { enabled: optimization.multiStart }
      : (optimization.multiStart ?? {});

  return {
    frequency: { ...DEFAULT_CONFIG.frequency, ...(source.frequency ?? {}) },
    gain: { ...DEFAULT_CONFIG.gain, ...(source.gain ?? {}) },
    delay: { ...DEFAULT_CONFIG.delay, ...(source.delay ?? {}) },
    allPass: {
      ...DEFAULT_CONFIG.allPass,
      ...allPass,
      frequency: { ...DEFAULT_CONFIG.allPass.frequency, ...(allPass.frequency ?? {}) },
      q: { ...DEFAULT_CONFIG.allPass.q, ...(allPass.q ?? {}) },
    },
    optimization: {
      ...DEFAULT_CONFIG.optimization,
      ...optimization,
      globalRefinement: {
        ...DEFAULT_CONFIG.optimization.globalRefinement,
        ...globalRefinement,
      },
      multiStart: {
        ...DEFAULT_CONFIG.optimization.multiStart,
        ...multiStart,
      },
    },
  };
}

export function normalizeParam(param = {}) {
  const source = param ?? {};
  const allPass = source.allPass ?? {};
  const readNumber = (value, fallback, name) => {
    if (value == null) return fallback;
    if (!Number.isFinite(value)) {
      throw new TypeError(`${name} must be a finite number`);
    }
    return value;
  };

  const polarity = source.polarity ?? EMPTY_CONFIG.polarity;
  if (polarity !== 1 && polarity !== -1) {
    throw new Error('polarity must be 1 or -1');
  }

  const enabled = allPass.enabled === true;
  const normalized = {
    delay: readNumber(source.delay, EMPTY_CONFIG.delay, 'delay'),
    gain: readNumber(source.gain, EMPTY_CONFIG.gain, 'gain'),
    polarity,
    allPass: {
      frequency: readNumber(
        allPass.frequency,
        EMPTY_CONFIG.allPass.frequency,
        'allPass.frequency',
      ),
      q: readNumber(allPass.q, EMPTY_CONFIG.allPass.q, 'allPass.q'),
      enabled,
    },
    filters: normalizeParamFilters(source.filters),
  };

  if (
    normalized.allPass.enabled &&
    (normalized.allPass.frequency <= 0 || normalized.allPass.q <= 0)
  ) {
    throw new Error('Enabled all-pass parameters require positive frequency and q');
  }

  return normalized;
}

function normalizeParamFilters(filters) {
  if (filters == null) return [];
  if (!Array.isArray(filters)) {
    throw new TypeError('param filters must be an array');
  }

  return filters.map((filter, index) => {
    const label = `filters[${index}]`;
    const { frequency, gain, q } = filter ?? {};
    if (!Number.isFinite(frequency) || frequency <= 0) {
      throw new Error(`${label}.frequency must be a positive finite number`);
    }
    if (!Number.isFinite(gain)) {
      throw new TypeError(`${label}.gain must be a finite number`);
    }
    if (!Number.isFinite(q) || q <= 0) {
      throw new Error(`${label}.q must be a positive finite number`);
    }
    return { frequency, gain, q };
  });
}

export function cloneParam(param = {}) {
  return normalizeParam(param);
}

export function validateOptimizerConfig(config) {
  const validateBounds = (range, name, requireStep = true) => {
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) {
      throw new TypeError(`${name} range must contain finite min and max values`);
    }
    if (range.min > range.max) {
      throw new Error(`Invalid ${name} range parameters`);
    }
    if (requireStep && (!Number.isFinite(range.step) || range.step <= 0)) {
      throw new Error(`Invalid ${name} step parameter`);
    }
  };

  validateBounds(config.frequency, 'frequency', false);
  validateBounds(config.delay, 'delay');
  validateBounds(config.gain, 'gain');
  validateBounds(config.allPass.frequency, 'all-pass frequency');
  validateBounds(config.allPass.q, 'all-pass q');

  const { objective, theoreticalWeight, globalRefinement, multiStart, targetCurve } =
    config.optimization;
  if (!['balanced', 'max-theoretical', 'pre-eq', 'target-match'].includes(objective)) {
    throw new Error('Invalid optimization objective');
  }
  if (objective === 'target-match') {
    if (
      !targetCurve?.freqs?.length ||
      !targetCurve?.magnitude?.length ||
      targetCurve.freqs.length !== targetCurve.magnitude.length
    ) {
      throw new Error(
        'target-match objective requires optimization.targetCurve with matching freqs and magnitude arrays',
      );
    }
  }
  if (
    !Number.isFinite(theoreticalWeight) ||
    theoreticalWeight < 0 ||
    theoreticalWeight > 1
  ) {
    throw new Error('optimization theoreticalWeight must be between 0 and 1');
  }
  if (typeof globalRefinement.enabled !== 'boolean') {
    throw new TypeError('optimization globalRefinement.enabled must be a boolean');
  }
  if (
    !Number.isInteger(globalRefinement.passes) ||
    globalRefinement.passes < 1 ||
    !Number.isInteger(globalRefinement.maxIterations) ||
    globalRefinement.maxIterations < 1
  ) {
    throw new Error(
      'optimization globalRefinement passes and maxIterations must be positive integers',
    );
  }
  if (typeof multiStart.enabled !== 'boolean') {
    throw new TypeError('optimization multiStart.enabled must be a boolean');
  }
  if (
    !Number.isInteger(multiStart.runs) ||
    multiStart.runs < 1 ||
    !Number.isInteger(multiStart.coarseSeedCount) ||
    multiStart.coarseSeedCount < 1
  ) {
    throw new Error(
      'optimization multiStart runs and coarseSeedCount must be positive integers',
    );
  }
  if (
    !Number.isFinite(multiStart.minRunImprovement) ||
    multiStart.minRunImprovement < 0
  ) {
    throw new Error(
      'optimization multiStart.minRunImprovement must be a non-negative number',
    );
  }
}
