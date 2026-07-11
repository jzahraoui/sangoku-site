import { cloneParam, normalizeParam } from './config.js';

const DEFAULT_MAX_CACHE_ENTRIES = 10000;

export function createEvaluationCache(maxEntries = DEFAULT_MAX_CACHE_ENTRIES) {
  return {
    entries: new Map(),
    responseContexts: new WeakMap(),
    hits: 0,
    misses: 0,
    maxEntries,
  };
}

export function clearEvaluationCache(cache) {
  cache.entries.clear();
  cache.responseContexts = new WeakMap();
  cache.hits = 0;
  cache.misses = 0;
}

export function getCacheStats(cache) {
  const total = cache.hits + cache.misses;
  return {
    hits: cache.hits,
    misses: cache.misses,
    total,
    ratio: total > 0 ? (cache.hits / total) * 100 : 0,
  };
}

export function evaluateWithCache(cache, cacheKey, compute) {
  if (cache.entries.has(cacheKey)) {
    cache.hits++;
    const cached = cache.entries.get(cacheKey);

    cache.entries.delete(cacheKey);
    cache.entries.set(cacheKey, cached);

    return {
      ...cached,
      param: cloneParam(cached.param),
    };
  }

  cache.misses++;
  const result = compute();

  if (cache.entries.size >= cache.maxEntries) {
    const oldestKey = cache.entries.keys().next().value;
    cache.entries.delete(oldestKey);
  }

  cache.entries.set(cacheKey, result);
  return result;
}

export function hashParam(param) {
  const normalizedParam = normalizeParam(param);
  const precision = 1e6;
  const delay = Math.round(normalizedParam.delay * precision);
  const gain = Math.round(normalizedParam.gain * precision);
  const polarity = normalizedParam.polarity;
  const allPassFrequency = normalizedParam.allPass.enabled
    ? Math.round(normalizedParam.allPass.frequency * 100)
    : 0;
  const allPassQ = normalizedParam.allPass.enabled
    ? Math.round(normalizedParam.allPass.q * 1000)
    : 0;
  const allPassEnabled = normalizedParam.allPass.enabled ? 1 : 0;

  let hash = `${delay}|${gain}|${polarity}|${allPassEnabled}|${allPassFrequency}|${allPassQ}`;
  for (const filter of normalizedParam.filters) {
    hash += `|${Math.round(filter.frequency * 100)}:${Math.round(
      filter.gain * 1000,
    )}:${Math.round(filter.q * 1000)}`;
  }
  return hash;
}

export function hashEvaluation({
  cache,
  config,
  subToOptimize,
  previousValidSum,
  theoreticalMax,
}) {
  return [
    hashScoringContext(config),
    hashResponseContext(cache, subToOptimize),
    hashResponseContext(cache, previousValidSum),
    hashResponseContext(cache, theoreticalMax),
    hashParam(subToOptimize.param),
  ].join('||');
}

function hashScoringContext(config) {
  const { objective, theoreticalWeight } = config.optimization;
  return `${objective}|${Math.round(theoreticalWeight * 1000)}`;
}

function hashResponseContext(cache, response) {
  if (!response || typeof response !== 'object') {
    return 'null';
  }

  const cached = cache.responseContexts.get(response);
  if (cached) return cached;

  const context = [
    response.measurement ?? response.name ?? null,
    response.freqStep ?? null,
    response.ppo ?? null,
    hashNumericArray(response.freqs),
    hashNumericArray(response.magnitude),
    hashNumericArray(response.phase),
  ]
    .map(serializeCachePart)
    .join('|');

  cache.responseContexts.set(response, context);
  return context;
}

function serializeCachePart(value) {
  return value == null ? 'null' : String(value);
}

function hashNumericArray(values) {
  if (!values || typeof values.length !== 'number') return null;
  let hash = 2166136261;

  for (const value of values) {
    const quantized = Math.round(value * 1e6);
    hash ^= quantized & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (quantized >>> 8) & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (quantized >>> 16) & 0xff;
    hash = Math.imul(hash, 16777619);
    hash ^= (quantized >>> 24) & 0xff;
    hash = Math.imul(hash, 16777619);
  }

  return [
    values.length,
    hash >>> 0,
    values[0] ?? null,
    values[values.length - 1] ?? null,
  ].join(':');
}
