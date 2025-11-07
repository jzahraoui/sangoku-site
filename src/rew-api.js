export default class RewApi {
  constructor(baseUrl, inhibitGraphUpdates = false, blocking = false) {
    if (!baseUrl) {
      throw new Error('Base URL is required');
    }
    this.baseUrl = baseUrl;
    this.speedDelay = 130;
    this.VERSION_REGEX = /(\d+)\.(\d+)\sBeta\s(\d+)/;
    this.MAX_RETRIES = 5;
    this.MAX_RETRY_DELAY = 5;
    this.blocking = blocking;
    this.inhibitGraphUpdates = inhibitGraphUpdates;
  }

  async setBlocking(blocking = true) {
    try {
      await this.updateAPI('blocking', blocking);
      this.blocking = blocking;
    } catch (error) {
      const message = error.message || 'Error enabling blocking';
      throw new Error(message, { cause: error });
    }
  }

  async setInhibitGraphUpdates(inhibit = true) {
    try {
      await this.updateAPI('inhibit-graph-updates', inhibit);
      this.inhibitGraphUpdates = inhibit;
    } catch (error) {
      const message = error.message || 'Error setting inhibit graph updates';
      throw new Error(message, { cause: error });
    }
  }

  // Move API initialization to separate method
  async initializeAPI() {
    try {
      await this.setInhibitGraphUpdates(this.inhibitGraphUpdates);
      await this.setBlocking(this.blocking);
    } catch (error) {
      const message = error.message || 'API initialization failed';
      throw new Error(message, { cause: error });
    }
  }

  async checkTargetCurve() {
    const tcResponse = await fetch(`${this.baseUrl}/eq/house-curve`);
    const target = tcResponse.ok ? await tcResponse.json() : null;
    const targetCurvePath = target?.message || target;

    if (!targetCurvePath) {
      return '';
    }
    console.info(`Using target curve : ${JSON.stringify(targetCurvePath)}`);
    const normalizedPath = targetCurvePath.replaceAll('\\', '/');
    const tcName = normalizedPath
      .split('/')
      .pop()
      .replace(/\.[^/.]+$/, '')
      .replaceAll(/\s+/g, '');
    return tcName || '';
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

  async putSafe(requestUrl, parameters, retries = 2) {
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

  // Helper to make HTTP requests with consistent error handling
  async fetchWithRetry(url, options, retries = 3, expectedProcess = null) {
    if (!url || !options) {
      throw new Error('Missing parameters');
    }

    const TIMEOUT_MS = 10000;
    const MAX_PULLING_RETRY = 90;
    const completeUrl = `${this.baseUrl}/${url}`;

    // Create an abort controller for the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const fetchOptions = { ...options, signal: controller.signal };

    try {
      const response = await fetch(completeUrl, fetchOptions);
      // Clear the timeout since the request completed
      clearTimeout(timeoutId);

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const parsedMessage = RewApi.safeParseJSON(data.message);
        const errorMessage =
          parsedMessage?.results?.[0]?.Error ||
          data.message ||
          `HTTP error! status: ${response.status} for URL: ${completeUrl}`;
        throw new Error(errorMessage);
      }

      const data = await response.json();

      // Validate data structure
      if (data === undefined || data === null) {
        throw new Error('Invalid response data');
      }

      this.validateExpectedProcess(expectedProcess, data);

      const processID = options.method === 'POST' && this.extractProcessID(data, url);

      // Handle 200: Check if polling is needed for measurements
      if (processID && (response.status === 200 || response.status === 202)) {
        return this.handleStatus202(url, processID, MAX_PULLING_RETRY);
      }

      return data;
    } catch (error) {
      // Clear the timeout if there was an error
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${TIMEOUT_MS / 1000} s`);
      }

      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, this.speedDelay));
        return await this.fetchWithRetry(url, options, retries - 1, expectedProcess);
      }

      throw new Error(error.message || 'Max retries reached', { cause: error });
    }
  }

  extractProcessID(data, url) {
    const idregex = /ID \d+/;

    const extractMatch = str => {
      if (!str) return null;
      const fromJson = RewApi.safeParseJSON(str);
      if (fromJson?.processName) {
        return fromJson.processName;
      }
      const match = idregex.exec(str);
      if (!match) return null;
      const idIndex = str.indexOf(match[0]);
      return str.substring(0, idIndex + match[0].length);
    };

    if (typeof data === 'string') {
      return extractMatch(data);
    }

    const messageMatch = extractMatch(data.message);
    if (messageMatch) return messageMatch;

    if (url !== 'measurements/process-result') {
      return extractMatch(data.processName);
    }

    return null;
  }

  validateExpectedProcess(expectedProcess, data) {
    if (!expectedProcess) return;

    if (typeof expectedProcess === 'string') {
      if (data !== expectedProcess) {
        throw new Error(
          `The API response does not concern the expected process ID: expected:\n${expectedProcess} received:\n${data}`
        );
      }
      return;
    }

    if (expectedProcess.processName && data.processName !== expectedProcess.processName) {
      throw new Error(
        `The API response does not concern the expected process ID: expected ${expectedProcess.processName} received ${data.processName}`
      );
    }

    if (expectedProcess.message) {
      const receivedMessage = data.message || data;
      if (
        !receivedMessage.toUpperCase().includes(expectedProcess.message.toUpperCase())
      ) {
        throw new Error('API does not give a "Complete" status');
      }
    }
  }

  getProcessExpectedResponse(url, processID) {
    return url.startsWith('import')
      ? processID
      : { processName: processID, message: 'Completed' };
  }

  async handleStatus202(url, processID, maxRetries) {
    if (!processID) {
      throw new Error('Invalid process ID in response');
    }

    return await this.fetchWithRetry(
      this.getResultUrl(url),
      { method: 'GET' },
      maxRetries,
      this.getProcessExpectedResponse(url, processID)
    );
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

  static safeParseJSON(str) {
    if (!str || typeof str !== 'string' || !str.trim().startsWith('{')) {
      return null;
    }
    return JSON.parse(str);
  }

  static isValidIpAddress(ip) {
    if (typeof ip !== 'string') return false;
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => {
      const num = Number(part);
      return part === String(num) && num >= 0 && num <= 255;
    });
  }
}
