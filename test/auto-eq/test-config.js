/**
 * test-config.js
 * Configuration centralisée pour tous les tests Auto-EQ
 *
 * Ce fichier contient:
 * - Fonctions utilitaires communes (parsing, réponses brutes, échantillonnage)
 * - Configuration par défaut
 * - Chemins des exemples de test
 * - Helpers pour la comparaison avec REW
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ============================================================================
// CHEMINS DES EXEMPLES DE TEST
// ============================================================================

export const TEST_EXAMPLES = {
  exemple1: {
    basePath: './test/auto-eq/exemple1',
    measured: './test/auto-eq/exemple1/FRavg.txt',
    target: './test/auto-eq/exemple1/Target FRavg.txt',
    rewFilters: './test/auto-eq/exemple1/REW_Filters.txt',
  },
  exemple2: {
    basePath: './test/auto-eq/exemple2',
    measured: './test/auto-eq/exemple2/FRavg.txt',
    target: './test/auto-eq/exemple2/Target FRavg.txt',
    rewFilters: './test/auto-eq/exemple2/REW_Filters.txt',
  },
  exemple3: {
    basePath: './test/auto-eq/exemple3',
    measured: './test/auto-eq/exemple3/FRavg.txt',
    target: './test/auto-eq/exemple3/Target FRavg.txt',
    rewFilters: './test/auto-eq/exemple3/REW_Filters.txt',
  },
  exemple4: {
    basePath: './test/auto-eq/exemple4',
    measured: './test/auto-eq/exemple4/FRavg.txt',
    target: './test/auto-eq/exemple4/Target FRavg.txt',
    rewFilters: './test/auto-eq/exemple4/REW_Filters.txt',
  },
};

// ============================================================================
// CONFIGURATION PAR DÉFAUT
// ============================================================================

const customStartFrequency = 20; // Hz
const customEndFrequency = 20000;
const individualMaxBoostdB = 6; // dB
const overallMaxBoostdB = 6; // dB
const flatnessTargetdB = 1; // dB

/**
 * Configuration de base pour AutoEQCalculator
 * Utilisée comme point de départ pour tous les tests
 */
export const DEFAULT_CONFIG = {
  sampleRate: 48000,
  numFilters: 20, // Plus de filtres pour mieux couvrir le spectre
  matchRangeStart: customStartFrequency,
  matchRangeEnd: customEndFrequency,
  individualMaxBoostDb: individualMaxBoostdB,
  overallMaxBoostDb: overallMaxBoostdB,
  maxBoostFreq: 50, // Protection ampli/enceintes (FR-032), aligné sur le défaut UI
  flatnessTarget: flatnessTargetdB,

  // Limites de gain - REW utilise jusqu'à -15.2 dB (exemple3)
  maxCutDb: 20,

  // Q maximum par zone de fréquence — non consommé par le moteur à ce jour
  // (plafonds de Q par bande, câblage à décider)
  maxQLowFreq: 6,
  maxQHighFreq: 4,

  // Pénalité d'overshoot - faible pour permettre les boosts agressifs
  overshootPenaltyWeight: 0.2,

  // ===== PARAMÈTRES REW v4.3 =====
  numOptimizationPasses: 15,
  gainSignLockThreshold: 0.5,
  allowNarrowFiltersBelow200Hz: true,
  varyQAbove200Hz: false,

  notchExclusionThreshold: 6,
  minFilterGain: 0.4,
};

// ============================================================================
// PLAGES DE MATCH PRÉDÉFINIES
// ============================================================================

export const MATCH_RANGES = {
  full: { start: 20, end: 20000 },
  bass: { start: 20, end: 250 },
  midrange: { start: 250, end: 4000 },
  treble: { start: 4000, end: 20000 },
  critical: { start: 40, end: 3000 }, // Plage la plus importante pour RMS
  subwoofer: { start: 20, end: 120 },
  dialog: { start: 100, end: 8000 },
};

// ============================================================================
// FONCTIONS UTILITAIRES DE PARSING
// ============================================================================

/**
 * Parse un fichier REW au format tabulaire (Freq Hz, SPL dB, Phase °)
 * @param {string} filePath - Chemin vers le fichier .txt
 * @returns {Array<{freq: number, spl: number, phase?: number}>}
 */
export function parseREWFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const data = [];
  let inData = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (trimmedLine.startsWith('*')) {
      inData = inData || trimmedLine.includes('Freq(Hz)');
      continue;
    }

    if (!inData) continue;

    const parts = line.split('\t');
    if (parts.length < 2) continue;

    const freq = Number.parseFloat(parts[0]);
    const spl = Number.parseFloat(parts[1]);
    const phase = parts.length >= 3 ? Number.parseFloat(parts[2]) : undefined;

    if (!Number.isNaN(freq) && !Number.isNaN(spl)) {
      data.push({ freq, spl, phase });
    }
  }

  return data;
}

/**
 * Parse un fichier REW et retourne le format API (Float32Arrays)
 * @param {string} filePath - Chemin vers le fichier .txt
 * @returns {Object} - {identifier, freqs, magnitude, phase, ppo?, startFreq?}
 */
function createEmptyApiResponse() {
  return {
    identifier: '',
    isImpedance: false,
    freqs: [],
    magnitude: [],
    phase: [],
  };
}

function parseFrequencyStepMetadata(data, trimmedLine) {
  if (!trimmedLine.startsWith('* Frequency Step:')) {
    return false;
  }

  const value = trimmedLine.substring('* Frequency Step:'.length).trim();
  if (value.includes('ppo')) {
    data.ppo = Number.parseFloat(value);
  } else {
    data.freqStep = Number.parseFloat(value);
  }

  return true;
}

function applyApiMetadataLine(data, trimmedLine) {
  if (trimmedLine.startsWith('* Measurement:')) {
    data.identifier = trimmedLine.substring('* Measurement:'.length).trim();
    return true;
  }

  if (parseFrequencyStepMetadata(data, trimmedLine)) {
    return true;
  }

  if (trimmedLine.startsWith('* Start Frequency:')) {
    const value = trimmedLine.substring('* Start Frequency:'.length).trim();
    data.startFreq = Number.parseFloat(value);
    return true;
  }

  return false;
}

function parseApiDataPoint(line) {
  const parts = line.split('\t');
  if (parts.length < 2) {
    return null;
  }

  const freq = Number.parseFloat(parts[0]);
  const spl = Number.parseFloat(parts[1]);
  const phase = parts.length >= 3 ? Number.parseFloat(parts[2]) : 0;

  if (Number.isNaN(freq) || Number.isNaN(spl)) {
    return null;
  }

  return { freq, spl, phase };
}

function appendApiDataPoint(data, point) {
  data.freqs.push(point.freq);
  data.magnitude.push(point.spl);
  data.phase.push(point.phase);
}

function finalizeApiResponse(data) {
  return {
    ...data,
    freqs: new Float32Array(data.freqs),
    magnitude: new Float32Array(data.magnitude),
    phase: new Float32Array(data.phase),
  };
}

export function parseREWFileAsAPI(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const data = createEmptyApiResponse();
  let inData = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    if (trimmedLine.startsWith('*')) {
      applyApiMetadataLine(data, trimmedLine);
      inData = inData || trimmedLine.includes('Freq(Hz)');
      continue;
    }

    if (!inData) continue;

    const point = parseApiDataPoint(line);
    if (point) {
      appendApiDataPoint(data, point);
    }
  }

  return finalizeApiResponse(data);
}

/**
 * Lit le sample rate d'une mesure importee dans REW.
 * Les imports REW API peuvent exposer un sample rate different du defaut local.
 *
 * @param {Object} api - Instance de l'API REW
 * @param {string|number} measurementId - UUID ou index de mesure REW
 * @param {number} fallbackSampleRate - Valeur de repli si REW n'expose rien
 * @returns {Promise<number>}
 */
export async function getRewMeasurementSampleRate(
  api,
  measurementId,
  fallbackSampleRate = DEFAULT_CONFIG.sampleRate,
) {
  const measurementInfo = await api.rewMeasurements.get(measurementId);
  return measurementInfo.sampleRate ?? fallbackSampleRate;
}

/**
 * Parse un fichier de filtres REW
 * Supporte les formats ancien et nouveau (tabulaire)
 * @param {string} filePath - Chemin vers le fichier de filtres
 * @returns {Array<{fc: number, gain: number, Q: number}>}
 */
export function parseREWFilters(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const filters = [];

  for (const line of lines) {
    // Format ancien: Filter  1: ON  PK       Fc    46.5 Hz  Gain  -8.3 dB  Q  1.226
    const matchOld = line.match(
      /Filter\s+\d+:\s+ON\s+PK\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+Q\s+([\d.]+)/i,
    );
    if (matchOld) {
      filters.push({
        fc: Number.parseFloat(matchOld[1]),
        gain: Number.parseFloat(matchOld[2]),
        Q: Number.parseFloat(matchOld[3]),
      });
      continue;
    }

    // Format nouveau (tabulaire): 1	True	Auto	PK	46.45	-8.3	1.226	37.89
    const parts = line.split('\t');
    if (parts.length >= 7 && parts[3] === 'PK') {
      const fc = Number.parseFloat(parts[4]);
      const gain = Number.parseFloat(parts[5]);
      const Q = Number.parseFloat(parts[6]);
      if (!Number.isNaN(fc) && !Number.isNaN(gain) && !Number.isNaN(Q)) {
        filters.push({ fc, gain, Q });
      }
    }
  }

  return filters;
}

// ============================================================================
// FONCTIONS DE RÉPONSES FRÉQUENTIELLES
// ============================================================================

/**
 * Convertit des données tabulaires ou API en réponse fréquentielle brute
 * compatible avec AutoEQCalculator.calculate().
 *
 * Supporte deux formats:
 * - Array: [{freq, spl}, ...]
 * - API Object: {freqs: Float32Array, magnitude: Float32Array}
 *
 * @param {Array|Object} data - Données source
 * @returns {{freqs: Float32Array, magnitude: Float32Array}}
 */
export function toFrequencyResponse(data) {
  if (Array.isArray(data)) {
    return {
      freqs: Float32Array.from(data, point => point.freq),
      magnitude: Float32Array.from(data, point => point.spl),
    };
  }

  if (
    data &&
    typeof data === 'object' &&
    ArrayBuffer.isView(data.freqs) &&
    ArrayBuffer.isView(data.magnitude)
  ) {
    return {
      freqs: Float32Array.from(data.freqs),
      magnitude: Float32Array.from(data.magnitude),
    };
  }

  throw new TypeError('Unsupported frequency response format');
}

function findNearestFrequencyIndex(freqs, targetFreq) {
  if (targetFreq <= freqs[0]) {
    return 0;
  }

  const lastIndex = freqs.length - 1;
  if (targetFreq >= freqs[lastIndex]) {
    return lastIndex;
  }

  let left = 0;
  let right = lastIndex;

  while (right - left > 1) {
    const mid = Math.floor((left + right) / 2);
    if (freqs[mid] < targetFreq) {
      left = mid;
    } else {
      right = mid;
    }
  }

  return Math.abs(freqs[right] - targetFreq) < Math.abs(targetFreq - freqs[left])
    ? right
    : left;
}

/**
 * Projette une réponse fréquentielle brute sur la grille de référence
 * par plus proche voisin, sans interpolation.
 *
 * @param {Array|Object} referenceData - Grille de référence
 * @param {Array|Object} sourceData - Réponse à projeter
 * @returns {{freqs: Float32Array, magnitude: Float32Array}}
 */
export function projectResponseToReferenceGrid(referenceData, sourceData) {
  const referenceResponse = toFrequencyResponse(referenceData);
  const sourceResponse = toFrequencyResponse(sourceData);

  return {
    freqs: Float32Array.from(referenceResponse.freqs),
    magnitude: Float32Array.from(referenceResponse.freqs, freq => {
      const sourceIndex = findNearestFrequencyIndex(sourceResponse.freqs, freq);
      return sourceResponse.magnitude[sourceIndex];
    }),
  };
}

/**
 * Crée un échantillonneur sans interpolation par plus proche voisin.
 * Utilisé pour les comparaisons dans les tests sur données brutes.
 *
 * @param {Array|Object} data - Données source
 * @returns {Function} - Fonction d'échantillonnage: (freq) => spl
 */
export function createNearestSampler(data) {
  const response = toFrequencyResponse(data);

  return freq => {
    const index = findNearestFrequencyIndex(response.freqs, freq);
    return response.magnitude[index];
  };
}

// ============================================================================
// FONCTIONS DE STATISTIQUES
// ============================================================================

/**
 * Calcule l'erreur RMS entre données et courbe cible
 * @param {Array} dataArray - [{freq, spl}, ...]
 * @param {Function} targetCurve - Échantillonneur de la courbe cible
 * @param {number} startFreq - Fréquence de début
 * @param {number} endFreq - Fréquence de fin
 * @returns {number} - Erreur RMS en dB
 */
export function calculateRMSError(dataArray, targetCurve, startFreq, endFreq) {
  const inRange = dataArray.filter(d => d.freq >= startFreq && d.freq <= endFreq);
  if (inRange.length === 0) return Number.NaN;

  const errors = inRange.map(d => d.spl - targetCurve(d.freq));
  return Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
}

function logBandBreakdown(bands, measuredDataArray, equalizedDataArray, targetCurve) {
  console.log('\n📊 Erreur RMS par bande de fréquence:');
  for (const band of bands) {
    const bandDataBefore = measuredDataArray.filter(
      d => d.freq >= band.start && d.freq < band.end,
    );
    const bandDataAfter = equalizedDataArray.filter(
      d => d.freq >= band.start && d.freq < band.end,
    );
    if (bandDataBefore.length === 0) continue;
    const errBefore = bandDataBefore.map(d => d.spl - targetCurve(d.freq));
    const errAfter = bandDataAfter.map(d => d.spl - targetCurve(d.freq));
    const rmsBefore = Math.sqrt(
      errBefore.reduce((s, e) => s + e * e, 0) / errBefore.length,
    );
    const rmsAfter = Math.sqrt(errAfter.reduce((s, e) => s + e * e, 0) / errAfter.length);
    const improvement = (1 - rmsAfter / rmsBefore) * 100;
    console.log(
      `   ${band.name.padEnd(20)}: ${rmsBefore.toFixed(2)} dB → ${rmsAfter.toFixed(2)} dB (${improvement >= 0 ? '+' : ''}${improvement.toFixed(0)}%)`,
    );
  }
}

function computeMaxCorrection(inRangeData, inRangeOriginal) {
  const corrections = inRangeData.map(d => {
    const origPoint = inRangeOriginal.find(o => Math.abs(o.freq - d.freq) < 0.1);
    return origPoint ? Math.abs(d.spl - origPoint.spl) : 0;
  });
  return Math.max(...corrections);
}

function logEqualizationSummary(
  originalRmsError,
  rmsError,
  maxError,
  maxErrorFreq,
  maxCorrection,
) {
  console.log("\n📈 Statistiques de l'égalisation (20-20000 Hz):");
  console.log(`   RMS Error avant:  ${originalRmsError.toFixed(3)} dB`);
  console.log(`   RMS Error après:  ${rmsError.toFixed(3)} dB`);
  console.log(
    `   Amélioration:     ${((1 - rmsError / originalRmsError) * 100).toFixed(1)}%`,
  );
  console.log(
    `   Max erreur:       ${maxError.toFixed(2)} dB @ ${maxErrorFreq.toFixed(0)} Hz`,
  );
  console.log(`   Max correction:   ${maxCorrection.toFixed(2)} dB`);
}

/**
 * Calcule les statistiques détaillées de l'égalisation
 * @param {Array} equalizedData - Données égalisées
 * @param {Array} originalData - Données originales
 * @param {Function} targetCurve - Courbe cible
 * @param {number} startFreq - Fréquence de début
 * @param {number} endFreq - Fréquence de fin
 * @returns {Object} - Statistiques calculées
 */
export function calculateEqualizationStats(
  equalizedDataArray,
  matchRangeStart,
  matchRangeEnd,
  measuredDataArray,
  targetCurve,
) {
  const inRangeData = equalizedDataArray.filter(
    d => d.freq >= matchRangeStart && d.freq <= matchRangeEnd,
  );
  const inRangeOriginal = measuredDataArray.filter(
    d => d.freq >= matchRangeStart && d.freq <= matchRangeEnd,
  );

  const errors = inRangeData.map(d => d.spl - targetCurve(d.freq));
  const originalErrors = inRangeOriginal.map(d => d.spl - targetCurve(d.freq));

  const rmsError = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
  const originalRmsError = Math.sqrt(
    originalErrors.reduce((sum, e) => sum + e * e, 0) / originalErrors.length,
  );
  const maxError = Math.max(...errors.map(Math.abs));
  const maxCorrection = computeMaxCorrection(inRangeData, inRangeOriginal);
  const maxErrorIdx = errors.findIndex(e => Math.abs(e) === maxError);
  const maxErrorFreq = inRangeData[maxErrorIdx]?.freq ?? 0;

  logEqualizationSummary(
    originalRmsError,
    rmsError,
    maxError,
    maxErrorFreq,
    maxCorrection,
  );

  // Breakdown par bande de fréquence
  const bands = [
    { name: 'Sub-bass (20-60 Hz)', start: 20, end: 60 },
    { name: 'Bass (60-250 Hz)', start: 60, end: 250 },
    { name: 'Low-mid (250-500 Hz)', start: 250, end: 500 },
    { name: 'Mid (500-2000 Hz)', start: 500, end: 2000 },
    { name: 'High-mid (2-6 kHz)', start: 2000, end: 6000 },
    { name: 'High (6-20 kHz)', start: 6000, end: 20000 },
  ];

  logBandBreakdown(bands, measuredDataArray, equalizedDataArray, targetCurve);

  return {
    maxError,
    maxErrorFreq,
  };
}

// ============================================================================
// HELPERS REW API
// ============================================================================

/**
 * Détecte automatiquement l'IP de l'hôte Windows depuis WSL
 * @returns {string} L'adresse IP de l'hôte Windows
 */
export function getWindowsHostIP() {
  if (process.env.WINDOWS_HOST) {
    return process.env.WINDOWS_HOST;
  }

  try {
    const isWSL = readFileSync('/proc/version', 'utf-8')
      .toLowerCase()
      .includes('microsoft');
    if (isWSL) {
      const result = execSync("ip route show | grep -i default | awk '{ print $3}'", {
        encoding: 'utf-8',
      }).trim();
      if (result) {
        console.log(`🔗 WSL détecté - IP Windows hôte: ${result}`);
        return result;
      }
    }
  } catch {
    // Pas dans WSL ou erreur de détection
  }

  console.log('🔗 Utilisation de localhost pour REW API');
  return '127.0.0.1';
}

function isWSL() {
  try {
    return readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function getRewApiHostCandidates() {
  const candidates = [];

  if (process.env.WINDOWS_HOST) {
    candidates.push(process.env.WINDOWS_HOST.trim());
  }

  if (isWSL()) {
    try {
      const routeHost = execSync("ip route show | awk '/default/ {print $3; exit}'", {
        encoding: 'utf-8',
      }).trim();
      if (routeHost) {
        candidates.push(routeHost);
      }
    } catch {
      // Ignorer l'échec de détection par routage
    }

    try {
      const nameservers = readFileSync('/etc/resolv.conf', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('nameserver '))
        .map(line => line.split(/\s+/)[1])
        .filter(Boolean);
      candidates.push(...nameservers);
    } catch {
      // Ignorer l'absence de resolv.conf
    }
  }

  candidates.push('127.0.0.1', 'localhost');

  return [...new Set(candidates.filter(Boolean))];
}

async function probeRewApiBaseUrl(baseURL, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseURL}/version`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json().catch(() => null);
    if (!data?.message || typeof data.message !== 'string') {
      return null;
    }

    return {
      baseURL,
      version: data.message,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Détecte une URL REW API réellement joignable avant d'instancier le client
 * @param {number} port - Port de l'API REW
 * @param {number} timeoutMs - Timeout par tentative
 * @returns {Promise<string>} URL de base joignable
 */
export async function resolveRewApiBaseUrl(port = 4735, timeoutMs = 1500) {
  const candidateHosts = getRewApiHostCandidates();
  const attemptedUrls = [];

  for (const host of candidateHosts) {
    const baseURL = `http://${host}:${port}`;
    attemptedUrls.push(baseURL);
    const probeResult = await probeRewApiBaseUrl(baseURL, timeoutMs);
    if (probeResult) {
      console.log(
        `🔗 REW API détectée sur ${probeResult.baseURL} (${probeResult.version})`,
      );
      return probeResult.baseURL;
    }
  }

  throw new Error(
    'REW API introuvable. Endpoints testés: ' +
      attemptedUrls.join(', ') +
      ". Verifiez que REW est lance, que l'API HTTP est active et que le port 4735 est expose a WSL. " +
      "Vous pouvez aussi forcer l'hote avec la variable WINDOWS_HOST.",
  );
}

/**
 * Convertit les données REW API en tableau d'objets
 * @param {Object} data - {freqs: Float32Array, magnitude: Float32Array}
 * @returns {Array} - [{freq, spl}, ...]
 */
export function toDataArray(data) {
  if (Array.isArray(data)) return data;
  const result = [];
  for (let i = 0; i < data.freqs.length; i++) {
    result.push({ freq: data.freqs[i], spl: data.magnitude[i] });
  }
  return result;
}

/**
 * Arrondit les filtres pour correspondre à l'export CamillaDSP
 * @param {Array} filters - Filtres à arrondir
 */
export function adjustFilterPrecision(filters) {
  for (const filter of filters) {
    if (filter.enabled && filter.filterType !== 'NONE') {
      filter.fc = Math.round(filter.fc * 10) / 10;
      filter.gain = Math.round(filter.gain * 10) / 10;
      filter.Q = Math.round(filter.Q * 1000) / 1000;
      filter.calcBiquad();
    }
  }
}

// ============================================================================
// CALLBACKS PAR DÉFAUT
// ============================================================================

/**
 * Callback de progression simple (affiche tous les 10%)
 */
export const defaultProgressCallback = (pct, msg) => {
  if (pct % 10 === 0 || pct === 100) {
    console.log(`   [${pct}%] ${msg}`);
  }
};

/**
 * Callback de log filtré (affiche uniquement les messages importants)
 */
export const defaultLogCallback = msg => {
  const keywords = [
    'Zone',
    'MSE',
    'filtre',
    'zone',
    'Grille',
    'Analyse',
    'flatness',
    'dét',
    'Pass',
    'REW',
    'notch',
    'Pondération',
    'Convergence',
    'Temps',
  ];

  if (keywords.some(kw => msg.includes(kw))) {
    console.log(`   📝 ${msg}`);
  }
};

/**
 * Callback de log silencieux
 */
export const silentLogCallback = () => {};

/**
 * Callback de log verbeux (tout afficher)
 */
export const verboseLogCallback = msg => {
  console.log(`   📝 ${msg}`);
};

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Crée une configuration complète avec callbacks
 * @param {Object} overrides - Options à surcharger
 * @param {Object} options - Options supplémentaires
 * @returns {Object} - Configuration complète
 */
export function createConfig(overrides = {}, options = {}) {
  const { silent = false, verbose = false } = options;

  let onLog = defaultLogCallback;
  if (silent) {
    onLog = silentLogCallback;
  } else if (verbose) {
    onLog = verboseLogCallback;
  }

  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    onProgress: overrides.onProgress || (silent ? () => {} : defaultProgressCallback),
    onLog: overrides.onLog || onLog,
  };
}

/**
 * Charge un exemple de test complet
 * @param {string} exampleName - Nom de l'exemple (exemple1, exemple2, etc.)
 * @returns {Object} - {measuredData, targetData, rewFilters, measuredResponse, targetResponse, measuredSampler, targetSampler}
 */
export function loadTestExample(exampleName) {
  const example = TEST_EXAMPLES[exampleName];
  if (!example) {
    throw new Error(
      `Exemple inconnu: ${exampleName}. Disponibles: ${Object.keys(TEST_EXAMPLES).join(
        ', ',
      )}`,
    );
  }

  const measuredData = parseREWFile(example.measured);
  const targetData = parseREWFile(example.target);
  let rewFilters = null;

  try {
    rewFilters = parseREWFilters(example.rewFilters);
  } catch {
    // Fichier de filtres optionnel
  }

  const measuredResponse = toFrequencyResponse(measuredData);
  const targetResponse = projectResponseToReferenceGrid(measuredResponse, targetData);

  return {
    measuredData,
    targetData,
    rewFilters,
    measuredResponse,
    targetResponse,
    measuredSampler: createNearestSampler(measuredResponse),
    targetSampler: createNearestSampler(targetResponse),
    basePath: example.basePath,
  };
}

// ============================================================================
// EXPORT PAR DÉFAUT
// ============================================================================

export default {
  TEST_EXAMPLES,
  DEFAULT_CONFIG,
  MATCH_RANGES,
  parseREWFile,
  parseREWFileAsAPI,
  getRewMeasurementSampleRate,
  parseREWFilters,
  toFrequencyResponse,
  projectResponseToReferenceGrid,
  createNearestSampler,
  calculateRMSError,
  calculateEqualizationStats,
  getWindowsHostIP,
  resolveRewApiBaseUrl,
  toDataArray,
  adjustFilterPrecision,
  createConfig,
  loadTestExample,
  defaultProgressCallback,
  defaultLogCallback,
  silentLogCallback,
  verboseLogCallback,
};
