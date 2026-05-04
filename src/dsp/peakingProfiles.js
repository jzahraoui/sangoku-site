/**
 * peakingProfiles.js
 *
 * Pré-calcul et évaluation rapide de profils biquad peaking EQ.
 * Ces fonctions produisent des objets légers pour l'évaluation fréquentielle
 * rapide sans allocation par point de fréquence.
 */

/**
 * Pré-calcule les termes rapides d'un peaking EQ biquad.
 *
 * @param {number} fc
 * @param {number} Q
 * @param {number} gain
 * @param {number} sampleRate
 * @returns {{fc:number,Q:number,gain:number,sampleRate:number,aC2:number,aC3:number,aSum:number,bC2:number,bC3:number,bSum:number}|null}
 */
export function createPeakingProfile(fc, Q, gain, sampleRate) {
  if (!Number.isFinite(fc) || !Number.isFinite(Q) || !Number.isFinite(gain)) {
    return null;
  }
  if (Math.abs(gain) < 0.001 || Q <= 0) {
    return null;
  }

  const safeFc = Math.max(1e-6, Math.min(fc, sampleRate * 0.4999));
  const omega = (2 * Math.PI * safeFc) / sampleRate;
  const cs = Math.cos(omega);
  const sn = Math.sin(omega);
  const A = Math.pow(10, gain / 40);
  const alpha = sn / (2 * Q);
  const sinHalf = Math.sin(omega / 2);
  const aSum = 16 * Math.pow(sinHalf, 4);

  return {
    fc: safeFc,
    Q,
    gain,
    sampleRate,
    aC2: -8 * cs,
    aC3: 2 * (1 - (alpha * alpha) / (A * A)),
    aSum,
    bC2: -8 * cs,
    bC3: 2 * (1 - alpha * alpha * A * A),
    bSum: aSum,
  };
}

/**
 * Convertit une liste de filtres simplifiés en profils rapides.
 *
 * @param {Array<{fc:number,Q:number,gain:number}>} filters
 * @param {number} sampleRate
 * @returns {Array<object>}
 */
export function createPeakingProfiles(filters, sampleRate) {
  const profiles = [];
  for (const filter of filters) {
    const profile = createPeakingProfile(filter.fc, filter.Q, filter.gain, sampleRate);
    if (profile) {
      profiles.push(profile);
    }
  }
  return profiles;
}

/**
 * Réponse rapide exacte d'un profil biquad à partir des termes sTh/sTh2.
 *
 * @param {object} profile
 * @param {number} sTh   — 2*sin²(ω)
 * @param {number} sTh2  — 2*sin²(ω/2)
 * @returns {number} magnitude²
 */
export function peakingProfileMagnitudeSquaredFast(profile, sTh, sTh2) {
  const numerator = profile.bSum - (profile.bC2 * sTh2 + profile.bC3 * sTh);
  const denominator = profile.aSum - (profile.aC2 * sTh2 + profile.aC3 * sTh);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    Math.abs(denominator) < 1e-30
  ) {
    return 1;
  }
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 ? value : Math.abs(value || 1);
}

/**
 * Somme des filtres en dB, calculée via produit des |H|².
 *
 * @param {Array<object>} profiles
 * @param {number} freq
 * @param {number} sampleRate
 * @returns {number} dB
 */
export function sumProfilesDbAtFrequency(profiles, freq, sampleRate) {
  if (!profiles || profiles.length === 0) return 0;
  const limitedFreq = Math.min(Math.max(freq, 0), sampleRate * 0.4999);
  const omega = (2 * Math.PI * limitedFreq) / sampleRate;
  const sinOmega = Math.sin(omega);
  const sTh = 2 * sinOmega * sinOmega;
  const sinHalf = Math.sin(omega / 2);
  const sTh2 = 2 * sinHalf * sinHalf;
  let magnitudeSquared = 1;
  for (const profile of profiles) {
    magnitudeSquared *= peakingProfileMagnitudeSquaredFast(profile, sTh, sTh2);
  }
  return 10 * Math.log10(Math.max(magnitudeSquared, Number.MIN_VALUE));
}
