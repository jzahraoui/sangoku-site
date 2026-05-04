export function buildCalculationResult({
  filters,
  initialMSE,
  finalMSE,
  elapsed,
  quality,
}) {
  const improvement = initialMSE > 0 ? ((initialMSE - finalMSE) / initialMSE) * 100 : 0;

  return {
    filters,
    initialMSE,
    finalMSE,
    improvement,
    elapsed,
    quality,
  };
}

export function logCalculationResult(result, onLog) {
  onLog('\n=== Résultat Final ===');
  onLog(`Filtres: ${result.filters.length}`);
  onLog(`MSE: ${result.initialMSE.toFixed(3)} → ${result.finalMSE.toFixed(3)} dB RMS`);
  onLog(`Amélioration: ${result.improvement.toFixed(1)}%`);
  onLog(`Temps total: ${(result.elapsed / 1000).toFixed(2)}s`);
  onLog('\n--- Filtres finaux ---');

  // Sorts result.filters in-place for stable output/logging.
  result.filters.sort((a, b) => a.fc - b.fc);
  for (let i = 0; i < result.filters.length; i++) {
    const fi = result.filters[i];
    onLog(
      `  #${i + 1}: fc=${fi.fc.toFixed(1)} Hz  Q=${fi.Q.toFixed(3)}  gain=${fi.gain.toFixed(2)} dB`,
    );
  }
}
