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
      const targetCurvePath = target?.message || target;
      const missingTargetCurve = !targetCurvePath;

      if (missingTargetCurve) {
        console.warn(
          `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`
        );
        return 'tcDefault';
      } else {
        console.info(`Using target curve : ${JSON.stringify(targetCurvePath)}`);
        const normalizedPath = targetCurvePath.replaceAll('\\', '/');
        const tcName = normalizedPath
          .split('/')
          .pop()
          .replace(/\.[^/.]+$/, '')
          .replace(/\s+/g, '');
        return tcName ? `${tcName}` : '';
      }
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

      const [, major, minor, beta] = versionMatch.map(v => Number.parseInt(v, 10));

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
      const indicePath = indice === null ? '' : `/${indice}`;
      const requestUrl = `measurements${indicePath}`;
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
      const indicePath = indice === null ? '' : `/${indice}`;
      const url = `measurements${indicePath}/${requestUrl}`;
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

  async postSafe(requestUrl, parameters, retries = 0) {
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
            delay: Number.parseFloat(delayMatch[1]),
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
    const MAX_PULLING_RETRY = 90;

    // Create an abort controller for the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/${url}`, {
        ...options,
        signal: controller.signal,
      });
      // Clear the timeout since the request completed
      clearTimeout(timeoutId);

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.message ||
            `HTTP error! status: ${response.status} for URL: ${this.baseUrl}/${url}`
        );
      }

      // Validate data structure
      if (data === undefined || data === null) {
        throw new Error('Invalid response data');
      }

      this._validateExpectedProcess(data, expectedProcess);

      const processID = data.message?.match(/.*ID \d+/);

      if (response.status === 200 && (!processID || !url.startsWith('measurements'))) {
        return data;
      }

      if (response.status === 200 || response.status === 202) {
        const processExpectedResponse =
          response.status === 200
            ? { processName: processID[0], message: 'Completed' }
            : this.buildExpectedResponse(url, processID, options);

        return await this.fetchWithRetry(
          this.getResultUrl(url),
          { method: 'GET' },
          MAX_PULLING_RETRY,
          processExpectedResponse
        );
      }

      return data;
    } catch (error) {
      // Clear the timeout if there was an error
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      }

      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, this.speedDelay));
        return await this.fetchWithRetry(url, options, retries - 1, expectedProcess);
      }

      throw new Error(error.message || 'Max retries reached', { cause: error });
    }
  }

  _validateExpectedProcess(data, expectedProcess) {
    if (!expectedProcess) return;

    if (expectedProcess.processName && data.processName !== expectedProcess.processName) {
      throw new Error(
        `The API response does not concern the expected process ID: expected ${expectedProcess.processName} received ${data.processName}`
      );
    }

    const receivedMessage = data.message || data;
    if (!receivedMessage.toUpperCase().includes(expectedProcess.message.toUpperCase())) {
      throw new Error('API does not give a "Complete" status');
    }
  }

  buildExpectedResponse(url, processID, options) {
    if (!processID) {
      throw new Error('Invalid process ID in response');
    }
    if (url.startsWith('import')) {
      if (processID) {
        return { message: processID[0] };
      }
      const body = this.parseRequestBody(options);
      if (!body) {
        throw new Error('Missing or invalid body for import request');
      }
      return { message: body.path || body.identifier };
    }

    return { processName: processID[0], message: 'Completed' };
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
