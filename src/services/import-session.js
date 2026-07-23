import { CHANNEL_TYPES } from '../audyssey.js';
import MqxTools from '../mqx-tools.js';

/**
 * Session-file import service extracted from MeasurementViewModel
 *.
 *
 * [ORCHESTRATION] service: validation and parsing of .avr/.ady/.mqx session
 * files, and import of their impulse responses into REW through the
 * RewSession service. No Knockout, no DOM — reading the DOM `File` object
 * and the download buttons stay in the viewmodel.
 *
 * Instantiate with `createImportSession({ log })`; pure helpers live at
 * module scope and are re-exposed by the factory.
 */

const MAX_FILE_SIZE_BYTES = 209715200; // 200 MB
const VALID_FILE_EXTENSIONS = ['.ady', '.mqx', '.liveproject'];
// Extensions lues comme binaire (arrayBuffer) plutot que texte JSON.
const BINARY_FILE_EXTENSIONS = ['.liveproject'];

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Vrai si le fichier de session est binaire (Dirac `.liveproject`). */
function isBinarySessionFile(filename) {
  return BINARY_FILE_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(ext));
}

function validateFile(file) {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!VALID_FILE_EXTENSIONS.includes(ext)) {
    throw new Error('Please select a .avr, .ady, .mqx or .liveproject file');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File size exceeds ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`);
  }
}

function findClosingBrace(content, startIndex) {
  let openCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];

    if (char === '"' && !escapeNext) {
      inString = !inString;
    } else if (char === '\\' && !escapeNext) {
      escapeNext = true;
      continue;
    } else if (!inString) {
      if (char === '{') openCount++;
      else if (char === '}' && --openCount === 0) return i;
    }
    escapeNext = false;
  }

  return -1;
}

function cleanJSON(fileContent) {
  // Early return if the input is empty or not a string
  if (!fileContent || typeof fileContent !== 'string') {
    throw new Error('Invalid input: fileContent must be a non-empty string');
  }

  const firstOpen = fileContent.indexOf('{');
  if (firstOpen === -1) {
    throw new Error('Invalid file format: no JSON object found');
  }

  const closingIndex = findClosingBrace(fileContent, firstOpen);
  if (closingIndex === -1) {
    throw new Error('Invalid JSON structure: unmatched braces');
  }

  return fileContent.slice(firstOpen, closingIndex + 1);
}

/**
 * Parse the raw text of a session file. `.mqx` files may contain garbage
 * after the closing JSON brace: truncate after the brace matching the first
 * opening bracket.
 */
function parseSessionFile(fileContent, filename) {
  if (filename.endsWith('.mqx')) {
    fileContent = cleanJSON(fileContent);
  }
  return JSON.parse(fileContent);
}

/**
 * Standard SWMix1-4 channel type for a directional-layout subwoofer ID;
 * anything else (speakers, SWLFE*, already-SWMix, unknown IDs) is returned
 * unchanged. Directional entries are recognized in CHANNEL_TYPES by their
 * Subwoofer group and a directional position; their SW1..SW4 code names the
 * matching SWMix entry.
 */
function standardSubwooferChannelType(enChannelType, log) {
  const details = CHANNEL_TYPES.getByChannelIndex(enChannelType);
  if (details?.group !== 'Subwoofer' || details.position === 'None') {
    return enChannelType;
  }
  if (!details.code) {
    log.warn(
      `Subwoofer channel type ${enChannelType} has no standard SW code, keeping it as-is`,
    );
    return enChannelType;
  }
  return CHANNEL_TYPES.getByCode(details.code).channelIndex;
}

/**
 * Normalize the subwoofer channel IDs of the measurement file. Measured in
 * Directional bass mode, the AVR tags each sub with a layout-specific
 * enChannelType (SWFrontLeft4sp, SWBack2sp, …) while the app and the OCA
 * export work with the generic numbered SWMix1-4 IDs. Applied once at
 * import — everything downstream (channelDetailsFor, OCA channelType) reads
 * the normalized detectedChannels.
 *
 * Note: the ampAssignInfo blob keeps the Directional configuration taken
 * for the measurements and is exported as-is — by design. The OCA importer
 * (A1 Evo lineage) only uses it as a strict equality check against the live
 * AVR state, sends the live AssignBin, and always forces the sub mode back
 * to Standard through an explicit SWSetup message; the import must happen
 * while the AVR is still in Directional mode.
 */
function normalizeChannelMapping(data, log = noopLog) {
  data.detectedChannels = data.detectedChannels.map(channel => ({
    ...channel,
    enChannelType: standardSubwooferChannelType(channel.enChannelType, log),
  }));
}

/** Convert a .mqx structure to an .ady-like structure. */
async function processMqxFile(data, jsonAvrData) {
  if (!jsonAvrData) {
    throw new Error(
      'AVR data is not available: connect the bridge and register your AVR first',
    );
  }
  const mqxTools = new MqxTools(data, jsonAvrData);
  mqxTools.parse();
  return mqxTools.jsonAvrData;
}

function createImportSession({ log = noopLog } = {}) {
  /**
   * Import one impulse response into REW through the session service and tag
   * the created measurement with its IR peak value.
   */
  async function importImpulseResponse(session, processedResponse, { sampleRate, splOffset, startTime = 0 }) {
    const identifier = processedResponse.name;
    const response = processedResponse.data;
    let max = 0;
    for (const element of response) {
      const absValue = Math.abs(element);
      if (absValue > max) {
        max = absValue;
      }
    }
    const options = {
      identifier,
      startTime,
      sampleRate,
      splOffset,
      applyCal: false,
      data: response,
    };
    const measurementItem = await session.addMeasurementFromRewOperation(
      () => session.rewImport.importImpulseResponseData(options),
      { expectedTitle: identifier, operationLabel: `import ${identifier}` },
    );
    measurementItem.IRPeakValue = max;
    if (max >= 1) {
      // Informational only: the IR is a deconvolved transfer function — a
      // peak above digital full scale does NOT indicate mic saturation and
      // never excludes the measurement (decision 2026-07-23). Real capture
      // problems are reported by the AVR (plausibility flag).
      log.info(
        `${identifier} IR peak is ${max.toFixed(2)} (above digital full scale)`,
      );
    }
  }

  /** Import all impulse responses of a parsed .ady/.mqx file into REW. */
  async function importAdyImpulses(session, adyTools, { filename, splOffset }) {
    if (filename.endsWith('.ady')) {
      adyTools.isDirectionalWhenMultiSubs();
    }

    // if not connected, do not import measurements in REW
    if (!session.state.isPolling) {
      log.warn('Not connected to REW, skipping measurements import');
      return;
    }

    try {
      // set processing state to speed up REW operations
      await session.setProcessing(true);
      // sort impulses by name to have all related positions together
      adyTools.impulses.sort((a, b) => a.name.localeCompare(b.name));
      for (const processedResponse of adyTools.impulses) {
        await importImpulseResponse(session, processedResponse, {
          sampleRate: adyTools.samplingRate,
          splOffset,
        });
      }
    } finally {
      await session.setProcessing(false);
    }
  }

  /**
   * Import all reconstructed impulse responses of a decoded Dirac `.liveproject`
   * into REW. Mirrors `importAdyImpulses`, but the IRs carry a common non-zero
   * `startTime` so their relative arrival delays (hence distances) survive.
   */
  async function importLiveprojectImpulses(session, decoded, { splOffset }) {
    // if not connected, do not import measurements in REW
    if (!session.state.isPolling) {
      log.warn('Not connected to REW, skipping measurements import');
      return;
    }

    try {
      await session.setProcessing(true);
      // sort by name to keep each channel's positions grouped and ordered
      const measurements = [...decoded.measurements].sort((a, b) => a.name.localeCompare(b.name));
      for (const measurement of measurements) {
        await importImpulseResponse(session, measurement, {
          sampleRate: decoded.sampleRate,
          splOffset: splOffset ?? decoded.splOffset,
          startTime: decoded.startTime,
        });
      }
    } finally {
      await session.setProcessing(false);
    }
  }

  return {
    cleanJSON,
    findClosingBrace,
    importAdyImpulses,
    importImpulseResponse,
    importLiveprojectImpulses,
    isBinarySessionFile: filename => isBinarySessionFile(filename),
    normalizeChannelMapping: data => normalizeChannelMapping(data, log),
    parseSessionFile,
    processMqxFile,
    validateFile,
  };
}

export {
  MAX_FILE_SIZE_BYTES,
  VALID_FILE_EXTENSIONS,
  BINARY_FILE_EXTENSIONS,
  cleanJSON,
  createImportSession,
  findClosingBrace,
  isBinarySessionFile,
  normalizeChannelMapping,
  parseSessionFile,
  processMqxFile,
  validateFile,
};
