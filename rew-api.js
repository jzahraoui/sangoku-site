export default class RewApi {
  constructor(baseUrl = 'http://localhost:4735') {
    this.baseUrl = baseUrl;
    this.speedDelay = 130;
    this.VERSION_REGEX = /(\d+)\.(\d+)\sBeta\s(\d+)/;
    this.MAX_RETRIES = 5;
    this.MAX_RETRY_DELAY = 5;
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
        console.warn(
          `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`
        );
      } else {
        console.info(`Using target curve : ${JSON.stringify(targetCurvePath)}`);
      }
      const normalizedPath = targetCurvePath.replace(/\\/g, '/');
      const tcName = normalizedPath
        .split('/')
        .pop()
        .replace(/\.[^/.]+$/, '')
        .replace(/\s+/g, '');
      return tcName ? `tc${tcName}` : '';
    } catch (error) {
      const message = error.message || 'Error checking target curve';
      throw new Error(message, { cause: error });
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

      versionOK =
        major > 5 ||
        (major === 5 && minor > 40) ||
        (major === 5 && minor === 40 && beta >= 71);

      if (!versionOK) {
        throw new Error(
          `Installed REW version (${versionString}) is outdated and incompatible` +
            `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`
        );
      }
    } catch (error) {
      const message = error.message || 'Error checking version';
      throw new Error(message, { cause: error });
    }

    return versionString;
  }

  // REW API
  async updateAPI(endpoint, bodyValue) {
    try {
      const url = `application/${endpoint}`;
      return await this.fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyValue),
        },
        0
      );
    } catch (error) {
      const message = error.message || 'Error updating API';
      throw new Error(message, { cause: error });
    }
  }

  async clearCommands() {
    try {
      const body = { command: 'Clear command in progress' };
      return await this.updateAPI('command', body);
    } catch (error) {
      const message = error.message || 'Error clearing commands';
      throw new Error(message, { cause: error });
    }
  }

  async fetchREW(indice = null, method = 'GET', body = null, retry = 3) {
    try {
      const requestUrl = `measurements${indice !== null ? `/${indice}` : ''}`;
      const requestOptions = {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'PUT' && body && { body: JSON.stringify(body) }),
      };
      return await this.fetchWithRetry(requestUrl, requestOptions, retry);
    } catch (error) {
      const message = error.message || 'Error fetching REW';
      throw new Error(message, { cause: error });
    }
  }

  async fetchSafe(requestUrl, indice = null, parameters = null) {
    try {
      const url = `measurements${indice ? `/${indice}` : ''}/${requestUrl}`;
      const options = {
        method: parameters ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
        ...(parameters && {
          body: JSON.stringify(parameters),
        }),
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      const message = error.message || 'Fetch failed';
      throw new Error(message, { cause: error });
    }
  }

  async fetchAlign(requestUrl) {
    try {
      const url = `alignment-tool/${requestUrl}`;
      const options = {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      };

      return await this.fetchWithRetry(url, options);
    } catch (error) {
      const message = error.message || 'Fetch failed';
      throw new Error(message, { cause: error });
    }
  }

  /**
   * Executes a process for measurements with retry capability
   * @param {string} processName - Name of the process to execute
   * @param {string|string[]} uuids - Single UUID or array of measurement UUIDs
   * @param {Object} [parameters=null] - Optional parameters for the process
   * @returns {Promise<Object>} Process result
   */
  async postNext(
    processName,
    uuids,
    parameters = null,
    retries = 0,
    commandType = 'command'
  ) {
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
      ...(isProcessMeasurements
        ? { processName, measurementUUIDs: uuids }
        : { command: processName }),
      ...(parameters && { parameters }),
    };
    try {
      const commandRequest = await this.fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        retries
      );

      return commandRequest;
    } catch (error) {
      const message = error.message || '`Process execution failed';
      throw new Error(message, { cause: error });
    }
  }

  async postSafe(requestUrl, parameters, expectedMessage = null, retries = 0) {
    try {
      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
      };

      const commandRequest = await this.fetchWithRetry(requestUrl, fetchOptions, retries);

      return commandRequest;
    } catch (error) {
      const message = error.message || 'Post failed';
      throw new Error(message, { cause: error });
    }
  }

  async putSafe(requestUrl, parameters, retries = 0) {
    try {
      const fetchOptions = {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
      };

      return await this.fetchWithRetry(requestUrl, fetchOptions, retries);
    } catch (error) {
      const message = error.message || 'Put failed';
      throw new Error(message, { cause: error });
    }
  }

  async postAlign(processName, frequency = null) {
    try {
      const result = await this.fetchWithRetry(
        `alignment-tool/command`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: processName,
            ...(frequency !== null && { frequency }),
          }),
        },
        3
      );

      const errorIntoMessage = result.message.results?.[0]?.Error;
      if (errorIntoMessage) {
        const delayMatch = errorIntoMessage.match(
          /delay required to align the responses.*(-?[\d.]+) ms/
        );
        if (delayMatch) {
          return {
            message: 'Delay too large',
            error: errorIntoMessage,
            delay: parseFloat(delayMatch[1]),
          };
        }
      }
      return result;
    } catch (error) {
      const message = error.message || 'Post failed';
      throw new Error(message, { cause: error });
    }
  }
  async postDelete(indice, retry = 3) {
    const url = `measurements/${indice}`;
    const options = {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    };

    try {
      return await this.fetchWithRetry(url, options, retry);
    } catch (error) {
      const message = error.message || 'Delete failed';
      throw new Error(message, { cause: error });
    }
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
      signal: controller.signal,
    };

    try {
      const response = await fetch(completeUrl, fetchOptions);
      // Clear the timeout since the request completed
      clearTimeout(timeoutId);

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.message || `HTTP error! status: ${response.status} for URL: ${completeUrl}`
        );
      }

      // Validate data structure
      if (!data) {
        throw new Error('Invalid response data');
      }

      // Handle expected process validation
      if (expectedProcess) {
        if (
          expectedProcess.processName &&
          data.processName !== expectedProcess.processName
        ) {
          throw new Error(
            `The API response does not concern the expected process ID: expected ${expectedProcess.processName} received ${data.processName}`
          );
        }
        if (!data.message.toUpperCase().includes(expectedProcess.message.toUpperCase())) {
          throw new Error(`API does not give a "Complete" status`);
        }
        //console.debug(`Process ${expectedProcess.processName} completed`);
      }

      let processExpectedResponse;
      const processID = data.message?.match(/.*ID \d+/);

      // Return data based on response status
      if (response.status === 200) {
        if (!processID) return data;
        if (!url.startsWith('measurements')) return data;

        processExpectedResponse = {
          processName: processID?.[0],
          message: 'Completed',
        };

        const resultUrl = this.getResultUrl(url);
        const processResponse = await this.fetchWithRetry(
          resultUrl,
          { method: 'GET' },
          MAX_PULLING_RETRY,
          processExpectedResponse
        );
        return processResponse;
      }

      if (response.status === 202) {
        // Determine result URL and process expected response

        if (url.startsWith('import')) {
          if (!processID) {
            const body = this.parseRequestBody(options);
            if (!body) {
              throw new Error('Missing or invalid body for import request');
            }
            processExpectedResponse = {
              message: body.path || body.identifier,
            };
          } else {
            processExpectedResponse = {
              message: processID?.[0],
            };
          }
        } else {
          if (!processID) {
            throw new Error('Invalid process ID in response');
          }
          processExpectedResponse = {
            processName: processID?.[0],
            message: 'Completed',
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

      const message = error.message || 'Max retries reached';
      throw new Error(message, { cause: error });
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
      const message = error.message || 'Failed to parse request body';
      throw new Error(message, { cause: error });
    }
  }
}
