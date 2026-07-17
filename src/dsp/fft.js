/**
 * fft.js — [MOTEUR] module.
 *
 * FFT radix-2 sur tableaux typés, pour les chemins chauds du moteur
 * (alignement temporel : ~40 transformées de 32k échantillons par groupe de
 * positions). La FFT de mathjs, utilisée sur les chemins ponctuels
 * (impulse-synthesis, vectorDivision, phase minimale), alloue un objet
 * Complex par échantillon et coûte ~300 ms par transformée 32k — ~100× plus
 * lent que cette implémentation. Parité vérifiée contre mathjs par
 * test/unit/fft.test.js.
 */

/**
 * FFT complexe in-place (Cooley-Tukey radix-2, décimation temporelle).
 *
 * @param {Float64Array} re - Parties réelles (longueur = puissance de 2)
 * @param {Float64Array} im - Parties imaginaires (même longueur)
 * @param {boolean} [inverse=false] - Transformée inverse (normalisée par 1/N)
 * @throws {RangeError} Si la longueur n'est pas une puissance de 2.
 */
// Complexité 17 assumée (revue 2026-07-14) : le noyau Cooley-Tukey est trois
// boucles imbriquées irréductibles sur chemin chaud — découper dégraderait
// lisibilité et performances sans bénéfice.
// eslint-disable-next-line sonarjs/cognitive-complexity
export function fftInPlace(re, im, inverse = false) {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0 || im.length !== n) {
    throw new RangeError(
      `FFT length must be a power of two (got re=${n}, im=${im.length})`,
    );
  }

  // Permutation bit-reversed
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const evenRe = re[i + j];
        const evenIm = im[i + j];
        const oddRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const oddIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = evenRe + oddRe;
        im[i + j] = evenIm + oddIm;
        re[i + j + len / 2] = evenRe - oddRe;
        im[i + j + len / 2] = evenIm - oddIm;
        const nextWRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextWRe;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** Plus petite puissance de 2 ≥ n. */
export function nextPowerOfTwo(n) {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(2, n))));
}

/**
 * IFFT d'un spectre complexe **hermitien** (celui d'un signal réel), et retour
 * des `n` premiers échantillons réels. Équivalent de `numpy.fft.irfft` quand on
 * travaille sur le spectre complet plutôt qu'un demi-spectre : toutes les
 * opérations en amont (division de Kirkeby, gain de calibration réel) doivent
 * préserver l'hermiticité pour que la partie imaginaire du résultat soit ≈ 0.
 *
 * `re`/`im` sont consommés en place par la transformée inverse.
 *
 * @param {Float64Array} re - Parties réelles du spectre (longueur = puissance de 2)
 * @param {Float64Array} im - Parties imaginaires
 * @param {number} n - Nombre d'échantillons temporels à retourner (≤ re.length)
 * @returns {Float64Array}
 */
export function realInverseFft(re, im, n) {
  fftInPlace(re, im, true);
  return re.slice(0, n);
}

/**
 * Spectre complexe d'un signal réel, zéro-paddé à `size` (puissance de 2).
 *
 * @param {ArrayLike<number>} samples
 * @param {number} size - Longueur FFT (≥ samples.length)
 * @returns {{ re: Float64Array, im: Float64Array }}
 */
export function forwardRealFft(samples, size) {
  if (samples.length > size) {
    throw new RangeError(
      `FFT size ${size} smaller than signal length ${samples.length}`,
    );
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < samples.length; i++) re[i] = samples[i];
  fftInPlace(re, im);
  return { re, im };
}
