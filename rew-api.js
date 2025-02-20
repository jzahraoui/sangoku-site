
export default class RewApi {

  constructor(baseUrl = 'http://localhost:4735') {
    this.baseUrl = baseUrl;
    this.speedDelay = 130;
    this.VERSION_REGEX = /(\d+)\.(\d+)\sBeta\s(\d+)/;
    this.MAX_RETRIES = 5;
    this.MAX_RETRY_DELAY = 5;
    this.sOs = 343.00;
    this.minDistAccuracy = 3.0 / 100 / this.sOs / 2;
    this.modelDelayLimit = 6.0 / this.sOs * 1000;
    this.powerFactor = 1.61803398874989; //Adjusts number of speaker averages for IDW - increase for more averages    

  }

  // Move API initialization to separate method
  async initializeAPI() {
    try {
      await this.updateAPI('inhibit-graph-updates', false);
      await this.updateAPI('blocking', false);
    } catch (error) {
      throw new Error('API initialization failed', { cause: error });
    }
  }

  async checkTargetCurve() {
    try {
      const tcResponse = await fetch(`${this.baseUrl}/eq/house-curve`);
      const target = tcResponse.ok ? await tcResponse.json() : null;
      const targetCurvePath = target?.message;
      const missingTargetCurve = !target || !targetCurvePath;

      if (missingTargetCurve) {
        console.warn(`Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`);
      } else {
        console.info(`Using target curve : ${JSON.stringify(targetCurvePath)}`);
      }
      const normalizedPath = targetCurvePath.replace(/\\/g, "/");
      const tcName = normalizedPath.split("/").pop().replace(/\.[^/.]+$/, "").replace(/\s+/g, "");
      return `tc${tcName}`;

    } catch (error) {
      throw new Error(`Error checking target curve: ${error.message}`, { cause: error });
    }

  }

  async checkVersion() {
    let versionOK = false;
    let versionString;

    try {
      const rewVersionResponse = await fetch(`${this.baseUrl}/version`);

      if (!rewVersionResponse.ok) {
        throw new Error(`Error checking version: not ok`);
      }
      const rewData = await rewVersionResponse.json();
      versionString = rewData.message;

      const versionMatch = this.VERSION_REGEX.exec(versionString);

      if (!versionMatch) {
        throw new Error(`Invalid version format: ${versionString}`);
      }

      const [, major, minor, beta] = versionMatch.map(v => parseInt(v, 10));

      console.info(`Using REW version: ${JSON.stringify(versionString)}`);

      versionOK = major > 5 ||
        (major === 5 && minor > 40) ||
        (major === 5 && minor === 40 && beta >= 71);

      if (!versionOK) {
        throw new Error(
          `Installed REW version (${versionString}) is outdated and incompatible` +
          `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`
        );
      }

    } catch (error) {
      throw new Error(`Error checking version: ${error.message}`, { cause: error });
    }

    return versionString;
  }

  // REW API
  async updateAPI(endpoint, bodyValue) {
    try {
      const url = `application/${endpoint}`;
      return await this.fetchWithRetry(url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyValue)
        },
        0);
    } catch (error) {
      throw new Error(`Error updating API: ${error.message}`, { cause: error });
    }
  }

  async clearCommands() {
    try {
      const body = { command: 'Clear command in progress' };
      return await this.updateAPI('command', body);
    } catch (error) {
      throw new Error(`Error clearing commands: ${error.message}`, { cause: error });
    }
  }

  async fetchREW(indice = null, method = 'GET', body = null, retry = 3) {
    try {
      const requestUrl = `measurements${indice !== null ? `/${indice}` : ''}`;
      const requestOptions = {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'PUT' && body && { body: JSON.stringify(body) })
      };
      return await this.fetchWithRetry(requestUrl, requestOptions, retry);
    } catch (error) {
      throw new Error(`Error fetching REW: ${error.message}`, { cause: error });
    }
  }

  async fetchSafe(requestUrl, indice = null, parameters = null) {
    try {
      const url = `measurements${indice ? `/${indice}` : ''}/${requestUrl}`;
      const options = {
        method: parameters ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(parameters && {
          body: JSON.stringify(parameters)
        })
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      throw new Error(`Fetch failed: ${error.message}`, { cause: error });
    }
  }

  async fetchAlign(requestUrl) {
    try {
      const url = `alignment-tool/${requestUrl}`;
      const options = {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      throw new Error(`Fetch failed: ${error.message}`, { cause: error });
    }
  }


  /**
   * Executes a process for measurements with retry capability
   * @param {string} processName - Name of the process to execute
   * @param {string|string[]} uuids - Single UUID or array of measurement UUIDs
   * @param {Object} [parameters=null] - Optional parameters for the process
   * @returns {Promise<Object>} Process result
   */
  async postNext(processName, uuids, parameters = null, retries = 0, commandType = 'command') {
    if (!processName || !uuids) {
      throw new Error('Process name and UUIDs are required');
    }
    const isProcessMeasurements = Array.isArray(uuids);
    // Build the appropriate endpoint based on measurement type
    const endpoint = isProcessMeasurements
      ? 'process-measurements'
      : `${uuids}/${commandType}`;
    // Set response code based on command type
    const url = `measurements/${endpoint}`;
    const body = {
      ...(isProcessMeasurements ? { processName, measurementUUIDs: uuids } : { command: processName }),
      ...(parameters && { parameters })
    };
    try {
      const commandRequest = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }, retries);

      return commandRequest;

    } catch (error) {
      throw new Error(`Process execution failed: ${error.message}`, { cause: error });
    }
  }

  async postSafe(requestUrl, parameters, expectedMessage = null, retries = 0) {
    try {
      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters)
      };

      const commandRequest = await this.fetchWithRetry(
        `${requestUrl}`,
        fetchOptions,
        retries);

      return commandRequest;
    } catch (error) {
      throw new Error(`Post failed: ${error.message}`, { cause: error });
    }
  }

  async putSafe(requestUrl, parameters, expectedMessage, retries = 3) {
    try {
      const fetchOptions = {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters)
      };

      return await this.fetchWithRetry(
        requestUrl,
        fetchOptions,
        retries);
    } catch (error) {
      throw new Error(`Put failed: ${error.message}`, { cause: error });
    }
  }

  async postAlign(processName, frequency = null) {
    try {
      const result = await this.fetchWithRetry(`alignment-tool/command`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: processName,
            ...(frequency !== null && { frequency })
          })
        },
        3
      );

      const errorIntoMessage = result.message.results?.[0]?.Error;
      if (errorIntoMessage) {
        const delayMatch = errorIntoMessage.match(/delay required to align the responses.*(-?[\d.]+) ms/);
        if (delayMatch) {
          return {
            message: 'Delay too large',
            error: errorIntoMessage,
            delay: parseFloat(delayMatch[1])
          };
        }
      }
      return result;
    } catch (error) {
      throw new Error(`Post failed: ${error.message}`, { cause: error });
    }
  }
  async postDelete(indice, retry = 3) {
    const url = `measurements/${indice}`;
    const options = {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    };

    try {
      return await this.fetchWithRetry(url, options, retry);
    } catch (error) {
      throw new Error(`Delete failed: ${error.message}`, { cause: error });
    }

  }

  async syncPeaks(indices, name = null) {
    if (!indices?.length) {
      throw new Error('No indices provided for synchronization');
    }
    try {
      // Get reference measurement
      await this.postNext('Cross corr align', indices);

      const reference = await this.fetchREW(indices[0]);
      const referenceStart = reference.timeOfIRStartSeconds;

      // Process remaining measurements
      for (let i = 1; i < indices.length; i++) {
        const current = await this.fetchREW(indices[i]);
        const timeDiff = Math.abs(current.timeOfIRStartSeconds - referenceStart);

        if (timeDiff <= this.minDistAccuracy) continue;

        // Try to align measurement
        const aligned = await this.magicAlign(indices[0], indices[i]);
        if (!aligned) continue;

        // Check alignment result
        const recheck = await this.fetchREW(indices[i]);
        if (Math.abs(recheck.timeOfIRStartSeconds - referenceStart) <= this.minDistAccuracy) continue;

        // Log warning if still misaligned
        const warningMessage = name
          ? `${name}${i} required several additional attempts to be properly aligned to MLP due to strong HF reflection content in its IR!`
          : (await this.fetchREW(i + 1)).title() + ' required several additional attempts to be properly aligned to MLP due to strong HF reflection content in its IR!';

        console.warn(warningMessage);
      }
    } catch (error) {
      throw new Error(`Error in syncPeaks: ${error.message}`, { cause: error });
    }
  }


  async magicAlign(index0, index1) {
    try {
      const magicShift = await this.getDivisionPeakTime(index0, index1);

      if (Math.abs(magicShift) <= this.minDistAccuracy) {
        return false;
      }

      await this.postNext('Offset t=0', index1, {
        offset: magicShift,
        unit: 'seconds'
      });
      return true;

    } catch (error) {
      throw new Error('Error in magicAlign', { cause: error });
    }
  }

  async getDivisionPeakTime(i0, i1) {
    let key;
    try {
      // Get division results
      const division = await this.postNext('Arithmetic', [i1, i0], {
        function: "A / B"
      });

      // Get and validate key
      key = parseInt(Object.keys(division?.results ?? {})[0]);
      if (isNaN(key)) throw new Error('Invalid key');

      // Get and return peak
      return await this.findTruePeak(key);

    } catch (error) {
      throw new Error('Error in getDivisionPeakTime:', { cause: error });
    } finally {
      // Cleanup
      if (key) await this.postDelete(key).catch(() => { });
    }
  }

  async findTruePeak(key) {
    try {
      // Get excess phase data
      const ep = await this.postNext('Excess phase version', key, {
        "include cal": true,
        "append lf tail": false,
        "append hf tail": false,
        "frequency warping": false,
        "replicate data": false
      });

      // Get normalized impulse response
      const keyEP = parseInt(Object.keys(ep.results)[0]);
      const response = await this.fetchSafe('impulse-response?normalised=true', keyEP);
      await this.postDelete(keyEP);

      // Process data
      const bytes = Uint8Array.from(atob(response.data), c => c.charCodeAt(0));
      const dataView = new DataView(bytes.buffer);
      const totalSamples = bytes.length / 4;

      let maxPeak = 0;
      let maxPosition = 0;

      // Find peaks and interpolate
      for (let i = 1; i < totalSamples - 1; i++) {
        const [prev, curr, next] = [
          dataView.getFloat32((i - 1) * 4, false),
          dataView.getFloat32(i * 4, false),
          dataView.getFloat32((i + 1) * 4, false)
        ];

        if ((curr > prev && curr > next) || (curr < prev && curr < next)) {
          for (let j = 0; j < 16; j++) {
            const position = i + j / 16;
            const center = Math.floor(position);
            let value = 0;

            // Interpolate using sinc window
            for (let k = center - 8; k <= center + 8; k++) {
              if (k >= 0 && k < totalSamples) {
                const x = position - k;
                const sample = dataView.getFloat32(k * 4, false);

                if (x === 0) {
                  value += sample;
                } else if (Math.abs(x) <= 8) {
                  const px = Math.PI * x;
                  value += sample * (Math.sin(px) / px) * (0.5 * (1 - Math.cos(2 * Math.PI * (x / 16))));
                }
              }
            }

            if (Math.abs(value) > Math.abs(maxPeak)) {
              maxPeak = value;
              maxPosition = position;
            }
          }
        }
      }

      return response.startTime + maxPosition / response.sampleRate;
    } catch (error) {
      throw new Error(`Error: ${error.message}`, { cause: error });
    }
  }

  async getSpatial(indices, name) {
    // Handle single index case
    if (indices.length === 1) {
      const index = indices[0];
      await this.postSafe(`${index}/command`, { command: 'Response copy' }, 'Completed');

      const responses = await this.fetchREW();
      const totalResponses = Object.keys(responses).length;

      await this.fetchREW(totalResponses, 'PUT', { title: `${name}o` });
      return;
    }

    if (name.startsWith("SW")) {
      try {
        const vectorAverage = await this.postNext('Vector average', indices);
        const key = parseInt(Object.keys(vectorAverage.results)[0], 10);

        await this.fetchREW(key, 'PUT', { title: `${name}o` });

        console.info(`Total measurements averaged to optimize speaker ${name} steady state response: ${indices.length}`);
      } catch (error) {
        throw new Error(`Error processing speaker ${name}:`, { cause: error });
      }
      return;
    }

    this.analyzeSpeaker(indices, name);
  }

  async analyzeSpeaker(indices, name) {
    console.info(`Analysing speaker ${name} measurements...`);

    // Get distances from MLP
    const distances = await Promise.all(
      indices.map(async i => {
        const { cumulativeIRShiftSeconds } = await this.fetchREW(i);
        return Math.abs(parseFloat(cumulativeIRShiftSeconds) - (await this.fetchREW(indices[0])).cumulativeIRShiftSeconds);
      })
    );

    const maxDistance = Math.max(...distances);
    const distanceCm = maxDistance * 34300;

    // Handle small deviations (<1cm)
    if (distanceCm < 1) {
      const avgDistance = Math.mean(distances);
      await Promise.all(indices.map(i =>
        this.postNext('Offset t=0', i, { offset: -avgDistance, unit: 'seconds' })
      ));
      await this.saveAverage(indices, name);
      return;
    }

    // Handle larger deviations with weighted averaging
    const weights = distances.map((d, i) => i === 0
      ? this.maxCopies
      : Math.max(1, Math.round(this.maxCopies * Math.pow(1 - d / maxDistance, this.powerFactor)))
    );

    // Create copies and average
    const startIndex = Object.keys(await this.fetchREW()).length;
    const copies = [];

    for (let i = 0; i < indices.length; i++) {
      for (let j = 0; j < weights[i]; j++) {
        await this.postSafe(`${indices[i]}/command`, { command: "Response copy" }, "Completed");
        copies.push(startIndex + copies.length + 1);
      }
    }

    // Log results
    if (!Number.isFinite(distanceCm) || !Number.isFinite(this.powerFactor)) {
      throw new Error('Invalid numeric values for logging');
    }
    console.info('Max distance: ' + distanceCm.toFixed(2) + 'cm, power: ' + this.powerFactor.toFixed(2));
    indices.forEach((idx, i) => {
      if (!Number.isInteger(idx) || !Number.isInteger(indices[0]) || !Number.isFinite(weights[i]) || !Number.isFinite(distances[i])) {
        throw new Error('Invalid numeric values for logging');
      }
      const position = idx - indices[0];
      const mlpLabel = idx === indices[0] ? ' (MLP)' : '';
      const copyLabel = weights[i] > 1 ? 'copies' : 'copy';
      const distance = (distances[i] * 34300).toFixed(2);
      console.info('  Pos ' + position + mlpLabel + ': ' + weights[i] + ' ' + copyLabel + ' (' + distance + 'cm)');
    });

    await Promise.all(copies.map(this.postDelete));
  }

  // ERROR: Causing interruption problems
  async throwError(errorInput, error) {
    const errorMessage = Array.isArray(errorInput)
      ? errorInput.join('\n\n')
      : errorInput?.toString() || 'An unknown error occurred';

    await this.clearCommands();
    await this.updateAPI('inhibit-graph-updates', false);
    await this.updateAPI('blocking', false);

    console.error(errorMessage, error);
    throw new Error(errorMessage, { cause: error });
  }

  // Helper to make HTTP requests with consistent error handling
  async fetchWithRetry(url, options, retries = 3, expectedProcess = null) {
    if (!url || !options) {
      throw new Error('Missing parameters');
    }

    const TIMEOUT_MS = 30000; // 30 seconds timeout
    const completeUrl = `${this.baseUrl}/${url}`;
    const MAX_PULLING_RETRY = 90;

    // Create an abort controller for the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Add the signal to the fetch options
    const fetchOptions = {
      ...options,
      signal: controller.signal
    };

    try {
      const response = await fetch(completeUrl, fetchOptions);
      // Clear the timeout since the request completed
      clearTimeout(timeoutId);

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || `HTTP error! status: ${response.status} for URL: ${completeUrl}`);
      }

      // Validate data structure
      if (!data) {
        throw new Error('Invalid response data');
      }

      // Handle expected process validation
      if (expectedProcess) {
        if (expectedProcess.processName && data.processName !== expectedProcess.processName) {
          throw new Error(`The API response does not concern the expected process ID: expected ${expectedProcess.processName} received ${data.processName}`);
        }
        if (!data.message.toUpperCase().includes(expectedProcess.message.toUpperCase())) {
          throw new Error(`API does not give a "Complete" status`);
        }
        //console.debug(`Process ${expectedProcess.processName} completed`);
      }

      // Return data based on response status
      if (response.status === 200) {
        return data;
      }

      if (response.status === 202) {
        // Determine result URL and process expected response
        let processExpectedResponse;

        if (url.startsWith('import')) {
          const body = this.parseRequestBody(options);
          if (!body) {
            throw new Error('Missing or invalid body for import request');
          }
          if (!expectedProcess) {
            processExpectedResponse = {
              "message": body.path || body.identifier
            };
          }
        } else {
          const processID = data.message.match(/.*ID \d+/);
          if (!processID) {
            throw new Error('Invalid process ID in response');
          }
          processExpectedResponse = {
            "processName": processID?.[0],
            "message": "Completed"
          };
        }
        const resultUrl = this.getResultUrl(url);
        const processResponse = await this.fetchWithRetry(
          resultUrl,
          { method: 'GET' },
          MAX_PULLING_RETRY,
          processExpectedResponse
        );
        return processResponse;
      }

      return data;

    } catch (error) {
      // Clear the timeout if there was an error
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      }

      if (retries > 0) {
        //console.debug(`${error.message}\nRetrying ${url}... ${retries - 1} attempts left`);
        // gives more time for process to complete
        await new Promise(resolve => setTimeout(resolve, this.speedDelay));
        return await this.fetchWithRetry(url, options, retries - 1, expectedProcess);
      }

      throw new Error(`Max retries reached: ${error.message}`, { cause: error });
    }
  }

  // Helper methods
  getResultUrl(url) {
    if (url.startsWith('alignment-tool/')) {
      return 'alignment-tool/result';
    }
    if (url.startsWith('import')) {
      return url;
    }
    return 'measurements/process-result';
  }

  // Helper function to safely parse request body
  parseRequestBody(options) {
    if (!options.body) {
      return null;
    }
    try {
      return JSON.parse(options.body);
    } catch (error) {
      throw new Error(`Failed to parse request body: ${error.message}`, { cause: error });
    }
  }

}

