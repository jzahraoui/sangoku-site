export function initializeOptimizer(optimizer, calculationContext, spans) {
  optimizer.initializeFromGrid(
    calculationContext.scanFreqs,
    calculationContext.measuredArr,
    calculationContext.targetArr,
    spans,
  );
}

export async function runAllIfNeeded(
  filters,
  spanAnalyzer,
  optimizer,
  calculationContext,
  { equalizerAdapter, maxIter = 500, logOverride = null, runAllOptions = {} } = {},
) {
  if (filters.length === 0) return;

  filters.sort((a, b) => a.fc - b.fc);
  const spans = spanAnalyzer.calcSpansExclNotches(filters);

  initializeOptimizer(optimizer, calculationContext, spans);
  await optimizer.optimizeAllParameters(filters, logOverride, maxIter, runAllOptions);

  equalizerAdapter.adaptFilters(filters);
}
