import * as math from 'mathjs';
import JSZip from 'jszip';
import lm from './logs.js';

/**
 * Audio processing tools for impulse response data
 * Provides functionality for parsing audio measurement data, applying calibration,
 * and generating processed impulse response files.
 */
class AdyTools {
  /**
   * URL for microphone calibration data file
   * @type {string}
   */
  static MIC_CALIBRATION_URL = 'ressources/mic-cal-imp.txt';

  /**
   * Creates an instance of AdyTools
   * @param {Object} fileContent - The content of the audio file
   * @throws {Error} If no file content is provided
   */
  constructor(fileContent) {
    if (!fileContent) {
      throw new Error(
        `No audio file content provided. Please ensure the file is properly loaded and parsed.`,
      );
    }
    this.fileContent = fileContent;
    this.currentDate = new Date();
    this.samplingRate = 48000;
    this.impulses = [];
  }

  /**
   * Parse audio content and generate zip file with processed impulse responses
   * @param {boolean} needCal - Whether calibration is needed
   * @returns {Promise<Blob>} The generated zip file
   * @throws {Error} If error occurs during zip file generation
   */
  async parseContent(needCal = false) {
    const jszip = new JSZip();
    let inv_micCal;

    try {
      if (needCal) {
        inv_micCal = await AdyTools.getMicCalDataInv();
        lm.debug('Applying calibration to measurement data...');
      }

      // Create a flat array of all file processing promises
      const zipPromises = this.fileContent.detectedChannels.flatMap(channel =>
        Object.entries(channel.responseData).map(async ([position, measurementData]) => {
          const positionIndex = Number(position);
          if (Number.isNaN(positionIndex)) {
            throw new TypeError(
              `Invalid position key "${position}" in responseData: expected a numeric index.`,
            );
          }
          const positionName = `P${(positionIndex + 1).toString().padStart(2, '0')}`;
          // must start with the channel name to match
          const measurementName = `${channel.commandId}_${positionName}`;
          const filename = `${measurementName}.txt`;

          // convert measurementData to Float32Array
          const irData = new Float32Array(measurementData);

          // Only apply calibration if needed
          const processedData = needCal
            ? await AdyTools.applyCal(irData, inv_micCal, this.samplingRate)
            : irData;

          const filecontent = this.createIRFileContent(processedData, measurementName);
          if (!filecontent) {
            throw new Error(`Failed to generate file content for ${filename}`);
          }
          this.impulses.push({
            name: measurementName,
            data: processedData,
          });
          return jszip.file(filename, filecontent);
        }),
      );

      // Wait for all files to be added, then generate and save zip
      await Promise.all(zipPromises);

      // Generate the zip file after all files have been added
      const content = await jszip.generateAsync({
        type: 'blob',
        encoding: 'binary',
      });
      return content;
    } catch (error) {
      throw new Error(`Failed to generate zip file: ${error.message}`, { cause: error });
    }
  }

  /**
   * Perform vector division in frequency domain
   * @param {Float32Array} impulseA - First impulse response
   * @param {Float32Array} impulseB - Second impulse response
   * @returns {Float32Array} Result of vector division
   * @throws {Error} If input signals are invalid
   */
  static vectorDivision(impulseA, impulseB) {
    // Basic input validation
    if (!impulseA?.length || !impulseB?.length) {
      throw new Error(
        'Invalid input signals for vector division. Both signals must have data.',
      );
    }
    if (impulseA.length !== impulseB.length) {
      throw new Error(
        `Vector division requires equal-length signals (got ${impulseA.length} and ${impulseB.length}).`,
      );
    }

    // Perform FFT (math.fft accepts real-valued arrays directly)
    const freqA = math.fft(Array.from(impulseA));
    const freqB = math.fft(Array.from(impulseB));

    // Wiener regularization to prevent division by near-zero values
    const EPSILON = 1e-10;
    const result = freqA.map((val, i) => {
      const denom = freqB[i];
      const denomAbsSq = math.abs(denom) ** 2 + EPSILON;
      return math.divide(math.multiply(val, math.conj(denom)), denomAbsSq);
    });

    // Convert back to time domain and return real parts
    return Float32Array.from(math.ifft(result).map(x => x.re));
  }

  /**
   * Perform fast convolution using Web Audio API
   * @param {Float32Array} audioData - Audio data to convolve
   * @param {Float32Array} calibrationData - Calibration data
   * @param {number} samplingRate - Sampling rate
   * @returns {Promise<Float32Array>} Convolved audio data
   * @throws {Error} If convolution fails
   */
  static async fastConvolution(audioData, calibrationData, samplingRate) {
    // Correct output length for linear convolution: N + M - 1
    const outputLength = audioData.length + calibrationData.length - 1;
    // Create offline audio context
    const ctx = new OfflineAudioContext(1, outputLength, samplingRate);

    // Create and set up audio buffers
    const sourceBuffer = ctx.createBuffer(1, audioData.length, samplingRate);
    const calibBuffer = ctx.createBuffer(1, calibrationData.length, samplingRate);

    // Fill buffers with data
    sourceBuffer.getChannelData(0).set(audioData);
    calibBuffer.getChannelData(0).set(calibrationData);

    // Set up audio nodes
    const source = ctx.createBufferSource();
    const convolver = ctx.createConvolver();

    // Configure nodes
    source.buffer = sourceBuffer;
    convolver.buffer = calibBuffer;

    // Connect nodes
    source.connect(convolver);
    convolver.connect(ctx.destination);

    try {
      // Start processing
      source.start(0);
      const renderedBuffer = await ctx.startRendering();
      return renderedBuffer.getChannelData(0);
    } catch (error) {
      lm.error('Convolution failed:', error);
      throw new Error(`Audio convolution failed: ${error.message}`, { cause: error });
    }
  }

  /**
   * Get microphone calibration data
   * @param {string} micCalUrl - URL to microphone calibration data
   * @returns {Promise<Float32Array>} Microphone calibration data
   * @throws {Error} If fetching or processing fails
   */
  static async getMicCalData(micCalUrl) {
    if (!micCalUrl) {
      throw new Error(
        'No microphone calibration URL provided. Please check the calibration data file path.',
      );
    }

    try {
      const micCalIRData = await AdyTools.readTextToFloatArray(micCalUrl);
      // Normalize micCalData length to exactly 16384
      if (micCalIRData.length < 16384) {
        const resized = new Float32Array(16384);
        resized.set(micCalIRData);
        return resized;
      }
      if (micCalIRData.length > 16384) {
        return micCalIRData.slice(0, 16384);
      }
      return micCalIRData;
    } catch (error) {
      throw new Error(
        `Error fetching or processing microphone calibration data from ${micCalUrl}: ${error.message}`,
        {
          cause: error,
        },
      );
    }
  }

  /**
   * Read text from URL and return float array
   * @param {string} url - URL to fetch data from
   * @returns {Promise<Float32Array>} Float array from text data
   * @throws {Error} If fetching or processing fails
   */
  static async readTextToFloatArray(url) {
    if (!url) throw new Error('No URL provided for fetching data');
    // Reject absolute URLs pointing to external origins to prevent SSRF
    if (/^https?:\/\//i.test(url)) {
      const urlObj = new URL(url, globalThis.location?.href);
      if (urlObj.origin !== globalThis.location?.origin) {
        throw new Error(`Fetching from external URLs is not permitted: ${url}`);
      }
    }
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache' },
        mode: 'cors',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(
          `HTTP error! status: ${response.status} when fetching data from ${url}`,
        );
      }

      const text = await response.text();
      if (!text?.trim()) {
        throw new Error('No content received from server when fetching data from ' + url);
      }

      const floats = Float32Array.from(text.trim().split(/\s+/), Number.parseFloat);
      if (floats.length === 0 || floats.some(Number.isNaN)) {
        throw new Error('Invalid data format received when fetching data from ' + url);
      }

      return floats;
    } catch (error) {
      throw new Error(`Failed to fetch or process data from ${url}: ${error.message}`, {
        cause: error,
      });
    }
  }

  /**
   * Create IR file content for a measurement
   * @param {Float32Array} measurementData - Measurement data
   * @param {string} measurementName - Name of the measurement
   * @returns {string} File content
   * @throws {Error} If data validation fails
   */
  createIRFileContent(measurementData, measurementName) {
    if (!measurementData || measurementData.length < 1000) {
      throw new Error(
        `measurement data for ${measurementName} is too short ${measurementData?.length || 0}`,
      );
    }
    if (measurementData.length > 16384) {
      throw new Error(
        `measurement data for ${measurementName} is too long ${measurementData.length}`,
      );
    }
    if (measurementData.some(Number.isNaN)) {
      throw new Error(`measurement data for ${measurementName} contains NaN values`);
    }
    // Find the sample with the highest absolute amplitude (correct for inverted polarity)
    const peakIndex = measurementData.reduce(
      (maxIdx, val, i, arr) => (Math.abs(val) > Math.abs(arr[maxIdx]) ? i : maxIdx),
      0,
    );
    const peakValue = measurementData[peakIndex];
    const SAMPLE_INTERVAL = 1 / this.samplingRate;
    const START_TIME = '0.0';
    const options = {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    };
    const formattedDate = this.currentDate.toLocaleString('fr-FR', options);
    const windowsEndOfLine = '\r\n';

    const fileHeader = [
      '* Impulse Response data saved by REW',
      '* IR is not normalised',
      '* IR window has not been applied',
      '* IR is not the min phase version',
      `* Dated: ${formattedDate}`,
      `* Measurement: ${measurementName}`,
      `* Excitation: Imported Impulse Response, ${this.samplingRate.toFixed(
        1,
      )} Hz sampling`,
      `${peakValue.toPrecision(18)} // Peak value before normalisation`,
      `${peakIndex} // Peak index`,
      `${measurementData.length} // Response length`,
      `${SAMPLE_INTERVAL.toExponential(16).replace(
        'e',
        'E',
      )} // Sample interval (seconds)`,
      `${START_TIME} // Start time (seconds)`,
      `${this.fileContent.avr?.splOffset ?? 80} // Data offset (dB)`,
      '* Data start',
    ];

    const filecontent = `${[...fileHeader, ...measurementData].join(windowsEndOfLine)}`;
    return filecontent;
  }

  /**
   * Apply calibration to measurement data
   * @param {Float32Array} measurementData - Measurement data
   * @param {Float32Array} inv_micCal - Inverted microphone calibration data
   * @param {number} samplingRate - Sampling rate
   * @returns {Promise<Float32Array>} Calibrated measurement data
   * @throws {Error} If calibration fails
   */
  static async applyCal(measurementData, inv_micCal, samplingRate) {
    // Validate measurement data
    if (!measurementData || !inv_micCal) {
      throw new TypeError(
        'Measurement data or calibration data is missing for calibration process.',
      );
    }

    if (measurementData.some(v => !Number.isFinite(v))) {
      throw new TypeError(
        'Measurement data contains invalid numbers. All values must be finite numbers.',
      );
    }

    return AdyTools.fastConvolution(measurementData, inv_micCal, samplingRate);
  }

  /**
   * Invert an impulse response
   * @param {Float32Array} impulseResponse - Impulse response to invert
   * @returns {Float32Array} Inverted impulse response
   */
  static invertIR(impulseResponse) {
    // Create a perfect impulse (Dirac delta)
    const perfectImpulse = new Float32Array(impulseResponse.length);
    perfectImpulse[0] = 1; // First sample is 1, rest are 0

    return AdyTools.vectorDivision(perfectImpulse, impulseResponse);
  }

  /**
   * Get inverted microphone calibration data with caching
   * @returns {Promise<Float32Array>} Inverted microphone calibration data
   * @throws {Error} If getting calibration data fails
   */
  static #cachedInvMicCal = null;

  static async getMicCalDataInv() {
    try {
      // Return cached result if available
      if (AdyTools.#cachedInvMicCal) {
        return AdyTools.#cachedInvMicCal;
      }

      const micCalData = await AdyTools.getMicCalData(AdyTools.MIC_CALIBRATION_URL);
      const inv_micCal = AdyTools.invertIR(micCalData);

      // Validate the inverted data
      if (
        !inv_micCal ||
        inv_micCal.length === 0 ||
        inv_micCal.some(v => !Number.isFinite(v))
      ) {
        throw new Error(
          'Failed to invert microphone calibration data: result is invalid. The inversion process produced an empty or invalid result.',
        );
      }

      // Cache the result for future use
      AdyTools.#cachedInvMicCal = inv_micCal;
      return inv_micCal;
    } catch (error) {
      lm.error('Mic calibration inversion error:', error);
      throw new Error(
        `Failed to get inverted microphone calibration data: ${error.message}`,
        { cause: error },
      );
    }
  }

  /**
   * Clear the cached inverted microphone calibration data
   */
  static clearCache() {
    AdyTools.#cachedInvMicCal = null;
  }

  /**
   * Check if directional mode is needed for multiple subwoofers
   * @returns {boolean} Whether directional mode is needed
   * @throws {Error} If measurement process needs to be repeated
   */
  isDirectionalWhenMultiSubs() {
    const numbersOfSubs = Number(this.fileContent.subwooferNum);
    const subwooferMode = this.fileContent.subwooferMode;

    // For none, single subwoofer, or undetected count, no need for directional mode
    if (Number.isNaN(numbersOfSubs) || numbersOfSubs <= 1) {
      return true;
    }

    // N/A means no multiple subwoofer mode detected
    if (subwooferMode === 'N/A') {
      return true;
    }

    // Multiple subwoofers case - check if explicitly in Directional mode
    if (subwooferMode === 'Directional') {
      return true;
    }

    // No subwoofer mode detected with multiple subs
    if (!subwooferMode) {
      lm.warn(
        `WARNING: Subwoofer mode not detected with multiple subs. Make sure Directional bass mode was used`,
      );
      return false;
    }

    // Handle error cases for multiple subwoofers without directional mode
    if (this.fileContent.avr?.speedOfSound === 343) {
      throw new Error(
        `Repeat measurement process with your receiver in 'directional bass' mode.`,
        {
          cause: new Error('Speed of sound is 343 m/s, indicating non-directional mode'),
        },
      );
    }

    if (this.fileContent.avr?.hasCirrusLogicDsp) {
      throw new Error(
        `Try manually measuring each of your subwoofers with REW and a calibrated microphone or use 'odd.wtf measure -s' tool with subwoofer RCA cable swapping method.`,
        {
          cause: new Error(
            'Cirrus Logic DSP detected, requires manual subwoofer measurement',
          ),
        },
      );
    }

    throw new Error(
      `Repeat measurement process with 'odd.wtf measure -b' 'directional bass' mode hack (will work with your receiver model).`,
      {
        cause: new Error(
          'No specific error identified, but directional mode is required',
        ),
      },
    );
  }
}

export default AdyTools;
