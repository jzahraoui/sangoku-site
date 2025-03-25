class AdyTools {
  static SPL_OFFSET = 80.0;

  constructor(fileContent) {
    if (!fileContent) {
      throw new Error(`no avr file content provided`);
    }
    this.fileContent = fileContent;
    this.currentDate = new Date();
    this.samplingRate = 48000;
    this.MIC_CALIBRATION_URL = 'ressources/mic-cal-imp.txt';
    this.micCalData = this.getMicCalData(this.MIC_CALIBRATION_URL);
  }

  async parse() {
    const SAMPLE_INTERVAL = 1 / this.samplingRate;
    const START_TIME = '0.0';
    const windowsEndOfLine = '\r\n';
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
    const jszip = new JSZip();
    const isCirrusLogic = this.fileContent.avr.hasCirrusLogicDsp;

    // Convert map to Promise.all for parallel processing
    const zipPromises = this.fileContent.detectedChannels.flatMap(channel =>
      Object.entries(channel.responseData).map(async ([position, measurementData]) => {
        const positionName = `P${Number(position) + 1}`;
        // must start with the channel name to mach
        const measurementName = `${channel.commandId}_${positionName}`;

        if (measurementData.length < 1000) {
          throw new Error(`measurement data for ${measurementName} is too short`);
        }
        if (measurementData.length > 16384) {
          throw new Error(`measurement data for ${measurementName} is too long`);
        }
        if (measurementData.some(isNaN)) {
          throw new Error(`measurement data for ${measurementName} contains NaN`);
        }
        // convert measurementData elements to number
        const measurementDataNumber = measurementData.map(Number);

        const filename = `${measurementName}.txt`;
        const peakValue = Math.max(...measurementDataNumber);
        const peakIndex = measurementDataNumber.indexOf(peakValue);
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

        if (isCirrusLogic) {
          const perfectResponse = [1, ...Array(measurementDataNumber.length - 1).fill(0)];
          const caldata = await this.getMicCalData();
          const inv_micCal = this.vectorDivision(perfectResponse, caldata);
          measurementData = await this.fastConvolution(measurementDataNumber, inv_micCal);
        }
        const filecontent = `${[...fileHeader, ...measurementData].join(
          windowsEndOfLine
        )}`;
        if (!filecontent) {
          throw new Error(`no file content for ${filename}`);
        }
        return jszip.file(filename, filecontent);
      })
    );

    // Wait for all files to be added, then generate and save zip
    await Promise.all(zipPromises);
    try {
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
  vectorDivision(impulseA, impulseB) {
    // Basic input validation
    if (!impulseA || !impulseA.length || !impulseB || !impulseB.length) {
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

  async fastConvolution(audioData, calibrationData) {
    // Create offline audio context
    const ctx = new OfflineAudioContext(1, audioData.length, this.samplingRate);

    // Create and set up audio buffers
    const sourceBuffer = ctx.createBuffer(1, audioData.length, this.samplingRate);
    const calibBuffer = ctx.createBuffer(1, calibrationData.length, this.samplingRate);

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

  async getMicCalData(micCalUrl) {
    // creates a singleton for this.micCalData
    if (this.micCalData) return this.micCalData;

    try {
      this.micCalData = await this.readTextToFloatArray(micCalUrl);
      // resize this.micCalData to 16384 if it's smaller
      if (this.micCalData.length < 16384) {
        this.micCalData = this.micCalData.concat(
          new Array(16384 - this.micCalData.length).fill(0)
        );
      }
    } catch (error) {
      throw new Error(`Error fetching or processing mic calibration data: ${error}`, {
        cause: error,
      });
    }
    return this.micCalData;
  }

  // function that read text from URL and return float array
  async readTextToFloatArray(url) {
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
}

export default AdyTools;
