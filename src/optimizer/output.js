export function generateLogResults(optimizer, optimizedSubs, bestScore) {
  optimizer.lm.info('Optimized parameters:');
  for (const sub of optimizedSubs) {
    if (!sub.param) continue;

    const delayMs = (sub.param.delay * 1000).toFixed(2);
    optimizer.lm.info(`${sub.name}:`);
    if (sub.param.polarity === 1) {
      optimizer.lm.info(` - polarity: normal`);
    } else {
      optimizer.lm.warn(` - polarity: inverted`);
    }
    optimizer.lm.info(` - delay: ${delayMs}ms`);
    if (sub.param.allPass?.enabled) {
      optimizer.lm.success(
        ` - allpass: freq: ${sub.param.allPass.frequency}Hz Q: ${sub.param.allPass.q}`,
      );
    } else {
      optimizer.lm.info(` - allpass: disabled`);
    }
  }

  optimizer.lm.info(`Best score: ${bestScore.toFixed(2)}`);
}

export function checkDelayBoundaries(optimizer, sub) {
  if (
    sub.param.delay < optimizer.config.delay.max &&
    sub.param.delay > optimizer.config.delay.min
  ) {
    return;
  }

  const delayMs = (sub.param.delay * 1000).toFixed(2);
  optimizer.lm.warn(`WARNING: Optimal delay for ${sub.name} is at the edge: ${delayMs}ms.
       This may indicate that the delay range is too narrow.`);
}

export function logComparisonResults(
  optimizer,
  subToOptimize,
  bestWithAllPass,
  bestWithoutAllPass,
  improvementPercentage,
  method,
) {
  if (bestWithAllPass.score === -Infinity) {
    return;
  }

  optimizer.lm.info(`Sub ${subToOptimize.name} ${method} optimization results:`);
  optimizer.lm.info(
    `- Best without all-pass: Score ${bestWithoutAllPass.score.toFixed(2)}`,
  );
  optimizer.lm.info(`- Best with all-pass: Score ${bestWithAllPass.score.toFixed(2)}`);
  optimizer.lm.info(`- Improvement with all-pass: ${improvementPercentage}%`);
}
