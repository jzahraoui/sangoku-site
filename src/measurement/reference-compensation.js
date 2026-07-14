/**
 * reference-compensation.js — [MOTEUR] module, zéro dépendance.
 *
 * Compensation du biais de référentiel (phase 1 du plan qualité audio) :
 * quand les filtres sont calculés sur une courbe de travail fenêtrée (MTW/FDW)
 * mais appliqués à la mesure brute, le predicted dépasse la cible de
 * D(f) = brute − fenêtrée (mesuré sur le corpus test/fixtures/ady/ :
 * +1.3 à +2.4 dB sur 300-3000 Hz pour les fronts large bande).
 *
 * Ces helpers sont purs : l'orchestration (récupérer les deux états de courbe,
 * décider d'appliquer, journaliser) reste dans les services — le calculateur
 * reste un outil qui reçoit une cible déjà recalée.
 */

/**
 * Écart moyen (dB) entre une courbe de référence (brute) et une courbe de
 * travail sur [startFreq, endFreq] — lookup par fréquence la plus proche, les
 * deux grilles peuvent différer.
 *
 * @param {{freqs: ArrayLike<number>, magnitude: ArrayLike<number>}} reference
 * @param {{freqs: ArrayLike<number>, magnitude: ArrayLike<number>}} working
 * @param {number} startFreq
 * @param {number} endFreq
 * @returns {number} moyenne de (reference − working) sur la bande, 0 si vide
 */
function computeReferenceOffset(reference, working, startFreq, endFreq) {
  if (
    !reference?.freqs?.length ||
    !working?.freqs?.length ||
    reference.freqs.length !== reference.magnitude?.length ||
    working.freqs.length !== working.magnitude?.length
  ) {
    return 0;
  }

  let sum = 0;
  let count = 0;
  let workingIndex = 0;
  const lastWorking = working.freqs.length - 1;

  for (let i = 0; i < reference.freqs.length; i++) {
    const freq = reference.freqs[i];
    if (freq < startFreq || freq > endFreq) continue;

    // Les deux grilles sont croissantes : avance le curseur jusqu'au point le
    // plus proche (évite une recherche binaire par point).
    while (
      workingIndex < lastWorking &&
      Math.abs(working.freqs[workingIndex + 1] - freq) <=
        Math.abs(working.freqs[workingIndex] - freq)
    ) {
      workingIndex++;
    }

    sum += reference.magnitude[i] - working.magnitude[workingIndex];
    count++;
  }

  return count > 0 ? sum / count : 0;
}

/**
 * Retourne une copie de la réponse cible décalée de `offsetDb`.
 * Ne mute pas l'entrée ; conserve les autres champs (freqs partagées).
 *
 * @param {{freqs: ArrayLike<number>, magnitude: ArrayLike<number>}} target
 * @param {number} offsetDb
 * @returns {{freqs: ArrayLike<number>, magnitude: Float64Array}}
 */
function applyTargetOffset(target, offsetDb) {
  const magnitude = new Float64Array(target.magnitude.length);
  for (let i = 0; i < magnitude.length; i++) {
    magnitude[i] = target.magnitude[i] + offsetDb;
  }
  return { ...target, magnitude };
}

/**
 * Profil de référentiel D(f) = référence − travail, par moyennes de bandes
 * d'octave interpolées linéairement en log-fréquence.
 *
 * C'est l'équivalent mesurable de « la cible vue à travers la même fenêtre
 * que la mesure » : soustraire ce profil à la cible rend le référentiel
 * cohérent bande par bande (BF intactes où D≈0, médiums dosés juste, pente
 * de la cible transmise en HF), sans réintroduire les détails que le
 * fenêtrage a volontairement retirés.
 *
 * Construction par bandes plutôt que par lissage glissant : une moyenne sur
 * une octave entière élimine le désaccord de forme des pics entre les deux
 * courbes (qui polluerait la cible), et l'interpolation locale ne fait pas
 * fuir l'écart des médiums vers les basses ou les aigus comme le ferait un
 * noyau large (validé sur le corpus test/fixtures/ady/, 2026-07-12).
 *
 * @param {{freqs: ArrayLike<number>, magnitude: ArrayLike<number>}} reference
 * @param {{freqs: ArrayLike<number>, magnitude: ArrayLike<number>}} working
 * @param {object} [options]
 * @param {number} [options.bandsPerOctave=1] - résolution du profil
 * @returns {{freqs: Float64Array, offset: Float64Array} | null}
 *   Profil sur la grille de la courbe de travail, null si entrées invalides.
 */
/**
 * Moyennes de `pointwise` par bande log2 (centres en log2(√(lo·hi))) sur la
 * grille `freqs` — étape 2 de computeReferenceProfile.
 * @returns {{ centers: number[], means: number[] }}
 */
function bandMeans(freqs, pointwise, { fmin, bandCount, bandsPerOctave }) {
  const n = freqs.length;
  const centers = [];
  const means = [];
  for (let band = 0; band < bandCount; band++) {
    const lo = fmin * Math.pow(2, band / bandsPerOctave);
    const hi = fmin * Math.pow(2, (band + 1) / bandsPerOctave);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const freq = freqs[i];
      if (freq >= lo && (freq < hi || band === bandCount - 1)) {
        sum += pointwise[i];
        count++;
      }
    }
    if (count > 0) {
      centers.push(Math.log2(Math.sqrt(lo * hi)));
      means.push(sum / count);
    }
  }
  return { centers, means };
}

/**
 * Interpolation linéaire du profil par bande en x = log2(f) — étape 3 de
 * computeReferenceProfile (plateaux aux extrémités).
 */
function interpolateBandProfile(centers, means, x) {
  const lastCenter = centers.length - 1;
  if (x <= centers[0]) {
    return means[0];
  }
  if (x >= centers[lastCenter]) {
    return means[lastCenter];
  }
  let j = 0;
  while (centers[j + 1] < x) j++;
  const t = (x - centers[j]) / (centers[j + 1] - centers[j]);
  return means[j] + t * (means[j + 1] - means[j]);
}

function computeReferenceProfile(reference, working, { bandsPerOctave = 1 } = {}) {
  if (
    !reference?.freqs?.length ||
    !working?.freqs?.length ||
    reference.freqs.length !== reference.magnitude?.length ||
    working.freqs.length !== working.magnitude?.length
  ) {
    return null;
  }

  const n = working.freqs.length;
  const pointwise = new Float64Array(n);
  let referenceIndex = 0;
  const lastReference = reference.freqs.length - 1;

  for (let i = 0; i < n; i++) {
    const freq = working.freqs[i];
    while (
      referenceIndex < lastReference &&
      Math.abs(reference.freqs[referenceIndex + 1] - freq) <=
        Math.abs(reference.freqs[referenceIndex] - freq)
    ) {
      referenceIndex++;
    }
    pointwise[i] = reference.magnitude[referenceIndex] - working.magnitude[i];
  }

  // Moyennes par bande (centres en log2), puis interpolation linéaire.
  const fmin = working.freqs[0];
  const fmax = working.freqs[n - 1];
  const bandCount = Math.max(1, Math.ceil(Math.log2(fmax / fmin) * bandsPerOctave));
  const { centers, means } = bandMeans(working.freqs, pointwise, {
    fmin,
    bandCount,
    bandsPerOctave,
  });
  if (centers.length === 0) {
    return null;
  }

  const offset = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    offset[i] = interpolateBandProfile(centers, means, Math.log2(working.freqs[i]));
  }

  return { freqs: Float64Array.from(working.freqs), offset };
}

/**
 * Retourne une copie de la cible abaissée du profil D(f) (lookup par
 * fréquence la plus proche — les grilles peuvent différer).
 *
 * @param {{freqs: ArrayLike<number>, magnitude: ArrayLike<number>}} target
 * @param {{freqs: ArrayLike<number>, offset: ArrayLike<number>}} profile
 * @returns {{freqs: ArrayLike<number>, magnitude: Float64Array}}
 */
function applyTargetProfile(target, profile) {
  const magnitude = new Float64Array(target.magnitude.length);
  let profileIndex = 0;
  const lastProfile = profile.freqs.length - 1;

  for (let i = 0; i < magnitude.length; i++) {
    const freq = target.freqs[i];
    while (
      profileIndex < lastProfile &&
      Math.abs(profile.freqs[profileIndex + 1] - freq) <=
        Math.abs(profile.freqs[profileIndex] - freq)
    ) {
      profileIndex++;
    }
    magnitude[i] = target.magnitude[i] - profile.offset[profileIndex];
  }
  return { ...target, magnitude };
}

/**
 * Moyenne du profil D(f) sur une bande — pour les logs et le seuil d'alerte.
 *
 * @param {{freqs: ArrayLike<number>, offset: ArrayLike<number>}} profile
 * @param {number} startFreq
 * @param {number} endFreq
 * @returns {number}
 */
function meanProfileOffset(profile, startFreq, endFreq) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < profile.freqs.length; i++) {
    const freq = profile.freqs[i];
    if (freq < startFreq || freq > endFreq) continue;
    sum += profile.offset[i];
    count++;
  }
  return count > 0 ? sum / count : 0;
}

export {
  computeReferenceOffset,
  applyTargetOffset,
  computeReferenceProfile,
  applyTargetProfile,
  meanProfileOffset,
};
