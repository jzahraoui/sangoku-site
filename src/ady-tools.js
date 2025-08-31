import * as math from 'mathjs';
import JSZip from 'jszip';

class AdyTools {
  static SPL_OFFSET = 80.0;
  static MIC_CALIBRATION_URL = 'ressources/mic-cal-imp.txt';

  constructor(fileContent) {
    if (!fileContent) {
      throw new Error(`no avr file content provided`);
    }
    this.fileContent = fileContent;
    this.currentDate = new Date();
    this.samplingRate = 48000;
    this.impulses = [];
  }

  async parseContent(needCal = false) {
    const jszip = new JSZip();
    let inv_micCal;

    if (needCal) {
      inv_micCal = await AdyTools.getMicCalDataInv();
      console.debug('Applying calibration to measurement data...');
    }

    try {
      // Create a flat array of all file processing promises
      const zipPromises = this.fileContent.detectedChannels.flatMap(channel =>
        Object.entries(channel.responseData).map(async ([position, measurementData]) => {
          const positionName = `P${(Number(position) + 1).toString().padStart(2, '0')}`;
          // must start with the channel name to mach
          const measurementName = `${channel.commandId}_${positionName}`;
          const filename = `${measurementName}.txt`;

          // Only apply calibration if needed
          const processedData = needCal
            ? await AdyTools.applyCal(measurementData, inv_micCal, this.samplingRate)
            : measurementData;

          const filecontent = await this.createIRFileContent(
            processedData,
            measurementName
          );
          if (!filecontent) {
            throw new Error(`no file content for ${filename}`);
          }
          this.impulses.push({
            name: measurementName,
            data: processedData,
          });
          return jszip.file(filename, filecontent);
        })
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
      throw new Error(`Error generating zip file: ${error.message}`, { cause: error });
    }
  }

  // TODO: replace by Polar and Complex class methods
  static vectorDivision(impulseA, impulseB) {
    // Basic input validation
    if (!impulseA ||!impulseA?.length || !impulseB?.length) {
      return [];
    }

    // Convert to math.js compatible complex numbers
    const signalA = impulseA.map(x => math.complex(Number(x), 0));
    const signalB = impulseB.map(x => math.complex(Number(x), 0));

    // Perform FFT
    const freqA = math.fft(signalA);
    const freqB = math.fft(signalB);

    // Simple frequency domain division
    const result = freqA.map((val, i) => math.divide(val, freqB[i]));

    // Convert back to time domain and return real parts
    return math.ifft(result).map(x => x.re);
  }

  static async fastConvolution(audioData, calibrationData, samplingRate) {
    // Create offline audio context
    const ctx = new OfflineAudioContext(1, audioData.length, samplingRate);

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
      return Array.from(renderedBuffer.getChannelData(0));
    } catch (error) {
      console.error('Convolution failed:', error);
      return [];
    }
  }

  static async getMicCalData(micCalUrl) {
    if (!micCalUrl) {
      throw new Error('No mic calibration URL provided');
    }

    try {
      let micCalIRData = await AdyTools.readTextToFloatArray(micCalUrl);
      // resize micCalData to 16384 if it's smaller
      if (micCalIRData.length < 16384) {
        micCalIRData = micCalIRData.concat(
          new Array(16384 - micCalIRData.length).fill(0)
        );
      }
      return micCalIRData;
    } catch (error) {
      throw new Error(
        `Error fetching or processing mic calibration data: ${error.message}`,
        {
          cause: error,
        }
      );
    }
  }

  // function that read text from URL and return float array
  static async readTextToFloatArray(url) {
    if (!url) throw new Error('No URL provided');
    try {
      // Fetch the text from URL

      const response = await fetch(url, {
        headers: {
          Accept: 'text/plain',
          'Cache-Control': 'no-cache',
        },
        // Add these options to help prevent fetch errors
        mode: 'cors',
        credentials: 'same-origin',
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Get the text content
      const text = await response.text();
      // Validate that we actually got content
      if (!text) {
        throw new Error('No content received from server');
      }

      // Split the text into lines and convert to floats
      const floatArray = text
        .trim() // Remove leading/trailing whitespace
        .split(/\s+/) // Split on whitespace (space, tab, newline)
        .filter(line => line) // Remove empty lines
        .map(num => parseFloat(num)); // Convert strings to floats
      // Validate the parsed data
      if (floatArray.length === 0 || floatArray.some(isNaN)) {
        throw new Error('Invalid data format received');
      }

      return floatArray;
    } catch (error) {
      throw new Error(`Failed to fetch or process data: ${error.message}`, {
        cause: error,
      });
    }
  }

  createIRFileContent(measurementData, measurementName) {
    if (measurementData.length < 1000) {
      throw new Error(
        `measurement data for ${measurementName} is too short ${measurementData.length}`
      );
    }
    if (measurementData.length > 16384) {
      throw new Error(
        `measurement data for ${measurementName} is too long ${measurementData.length}`
      );
    }
    if (measurementData.some(isNaN)) {
      throw new Error(
        `measurement data for ${measurementName} contains NaN ${measurementData}`
      );
    }
    // convert measurementData elements to number
    const measurementDataNumber = measurementData.map(Number);
    const peakValue = Math.max(...measurementDataNumber);
    const peakIndex = measurementDataNumber.indexOf(peakValue);
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
      `* Excitation: Imported Impulse Response, ${this.samplingRate.toFixed(1)} Hz sampling`,
      `${peakValue.toPrecision(18)} // Peak value before normalisation`,
      `${peakIndex} // Peak index`,
      `${measurementDataNumber.length} // Response length`,
      `${SAMPLE_INTERVAL.toExponential(16).replace('e', 'E')} // Sample interval (seconds)`,
      `${START_TIME} // Start time (seconds)`,
      `${AdyTools.SPL_OFFSET.toFixed(1)} // Data offset (dB)`,
      '* Data start',
    ];

    const filecontent = `${[...fileHeader, ...measurementData].join(windowsEndOfLine)}`;
    return filecontent;
  }

  static async applyCal(measurementData, inv_micCal, samplingRate) {
    // Convert measurement data to numbers and validate
    const measurementDataFloat = measurementData.map(value => {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new Error('Measurement data contains invalid numbers');
      }
      return num;
    });

    const measurementDataCal = await AdyTools.fastConvolution(
      measurementDataFloat,
      inv_micCal,
      samplingRate
    );
    return measurementDataCal;
  }

  static invertIR(impulseResponse) {
    // Create a perfect impulse (Dirac delta)
    const perfectImpulse = [...Array(impulseResponse.length).fill(0)];
    perfectImpulse[0] = 1; // First sample is 1, rest are 0

    return AdyTools.vectorDivision(perfectImpulse, impulseResponse);
  }

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
      if (!inv_micCal || inv_micCal.length === 0 || inv_micCal.some(isNaN)) {
        throw new Error(
          'Failed to invert microphone calibration data: result is invalid'
        );
      }

      // Cache the result for future use
      AdyTools.#cachedInvMicCal = inv_micCal;
      return inv_micCal;
    } catch (error) {
      console.error('Mic calibration inversion error:', error);
      throw new Error(
        `Failed to get inverted microphone calibration data: ${error.message}`
      );
    }
  }

  isDirectionalWhenMultiSubs() {
    const numbersOfSubs = Number(this.fileContent.subwooferNum);
    const subwooferMode = this.fileContent.subwooferMode;

    // For none or single subwoofer, no need for directional mode
    if (numbersOfSubs <= 1) {
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
      console.warn(
        `WARNING: Subwoofer mode not detected with multiple subs. Make sure Directional bass mode was used`
      );
      return false;
    }

    // Handle error cases for multiple subwoofers without directional mode
    if (this.fileContent.avr.speedOfSound === 343) {
      throw new Error(
        `Repeat measurement process with your receiver in 'directional bass' mode.`
      );
    }

    if (this.fileContent.avr.hasCirrusLogicDsp) {
      throw new Error(
        `Try manually measuring each of your subwoofers with REW and a calibrated microphone or use 'odd.wtf measure -s' tool with subwoofer RCA cable swapping method.`
      );
    }

    throw new Error(
      `Repeat measurement process with 'odd.wtf measure -b' 'directional bass' mode hack (will work with your receiver model).`
    );
  }
}

export default AdyTools;
