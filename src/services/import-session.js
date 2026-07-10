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
const VALID_FILE_EXTENSIONS = ['.avr', '.ady', '.mqx'];

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function validateFile(file) {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!VALID_FILE_EXTENSIONS.includes(ext)) {
    throw new Error('Please select a .avr, .ady, or .mqx file');
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

// TODO check if this is needed
function normalizeChannelMapping(data) {
  const StandardChannelMapping = {
    59: 54,
    60: 55,
    62: 56,
    63: 57,
    58: 54,
    61: 55,
    64: 56,
    47: 54,
    49: 55,
  };

  // TODO: ampassign can be directionnal must be converted to standard
  // convert directionnal bass to standard
  data.detectedChannels = data.detectedChannels.map(channel => ({
    ...channel,
    enChannelType: StandardChannelMapping[channel.enChannelType] || channel.enChannelType,
  }));
}

/** Convert a .mqx structure to an .ady-like structure. */
async function processMqxFile(data, jsonAvrData) {
  if (!jsonAvrData) {
    throw new Error('Please load AVR data first');
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
  async function importImpulseResponse(session, processedResponse, { sampleRate, splOffset }) {
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
      startTime: 0,
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
      log.warn(
        `${identifier} IR is above 1(${max.toFixed(
          2,
        )}), it will not be used for processing`,
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

  return {
    cleanJSON,
    findClosingBrace,
    importAdyImpulses,
    importImpulseResponse,
    normalizeChannelMapping,
    parseSessionFile,
    processMqxFile,
    validateFile,
  };
}

export {
  MAX_FILE_SIZE_BYTES,
  VALID_FILE_EXTENSIONS,
  cleanJSON,
  createImportSession,
  findClosingBrace,
  normalizeChannelMapping,
  parseSessionFile,
  processMqxFile,
  validateFile,
};
