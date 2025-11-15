export default class RewApi {
  static TIMEOUT_MS = 15000;
  static WAIT_BETWEEN_RETRIES_MS = 100;
  static MAX_POLLING_RETRY = Math.floor(
    RewApi.TIMEOUT_MS / RewApi.WAIT_BETWEEN_RETRIES_MS
  );
  static SPEED_DELAY_INHIBIT_MS = 20;
  static SPEED_DELAY_NORMAL_MS = 300;
  static VERSION_REGEX = /(\d+)\.(\d+)\sBeta\s(\d+)/;
  static MIN_REQUIRED_VERSION = 54071;

  constructor(baseUrl, inhibitGraphUpdates = false, blocking = false) {
    if (!baseUrl) {
      throw new Error('Base URL is required');
    }
    if (typeof baseUrl !== 'string') {
      throw new TypeError('Base URL must be a string');
    }
    // Validate URL to prevent SSRF attacks
    const parsedBase = new URL(baseUrl);
    if (parsedBase.hostname !== 'localhost') {
      throw new Error('Base URL is not localhost');
    }
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      throw new Error('Base URL must use HTTP or HTTPS protocol');
    }

    this.baseUrl = baseUrl;
    this.speedDelay = inhibitGraphUpdates
      ? RewApi.SPEED_DELAY_INHIBIT_MS
      : RewApi.SPEED_DELAY_NORMAL_MS;
    this.blocking = blocking;
    this.inhibitGraphUpdates = inhibitGraphUpdates;
    this.maxMeasurements = 0;
    this.version = '0.0 Beta 0';
    this.targetCurve = 'None';
  }

  async setBlocking(blocking = true) {
    try {
      // ask the REW API for the current blocking mode
      const currentBlocking = await this.fetchWithRetry('application/blocking', {
        method: 'GET',
      });
      if (currentBlocking !== blocking) {
        // Update blocking mode on the REW API
        await this.postSafe('application/blocking', blocking);
      }
      this.blocking = blocking;
    } catch (error) {
      const message = error.message || 'Error enabling blocking';
      throw new Error(message, { cause: error });
    }
  }

  async setInhibitGraphUpdates(inhibit = true) {
    try {
      await this.postSafe('application/inhibit-graph-updates', inhibit);
      this.inhibitGraphUpdates = inhibit;
      this.speedDelay = inhibit
        ? RewApi.SPEED_DELAY_INHIBIT_MS
        : RewApi.SPEED_DELAY_NORMAL_MS;
    } catch (error) {
      const message = error.message || 'Error setting graph updates inhibition';
      throw new Error(message, { cause: error });
    }
  }

  async getLastError() {
    return await this.fetchWithRetry('application/last-error', { method: 'GET' });
  }

  async getMaxMeasurements() {
    return await this.fetchWithRetry('measurements/max-measurements', {
      method: 'GET',
    });
  }

  async clearCommands() {
    return await this.fetchWithRetry('application/command', {
      body: JSON.stringify({ command: 'Clear command in progress' }),
      method: 'POST',
    });
  }

  // Move API initialization to separate method
  async initializeAPI() {
    try {
      await this.setInhibitGraphUpdates(this.inhibitGraphUpdates);
      await this.setBlocking(this.blocking);
      this.maxMeasurements = await this.getMaxMeasurements();
      this.version = await this.checkVersion();
      this.targetCurve = await this.checkTargetCurve();
    } catch (error) {
      const message = error.message || 'API initialization failed';
      throw new Error(message, { cause: error });
    }
  }

  async checkTargetCurve() {
    const target = await this.fetchWithRetry('eq/house-curve', { method: 'GET' });

    const targetCurvePath = target?.message || target;
    if (!targetCurvePath || typeof targetCurvePath !== 'string') return 'None';

    const filename = targetCurvePath.replaceAll('\\', '/').split('/').pop();
    const dotIndex = filename.lastIndexOf('.');
    return (dotIndex > 0 ? filename.slice(0, dotIndex) : filename).replaceAll(' ', '');
  }

  async checkVersion() {
    const response = await this.fetchWithRetry('version', { method: 'GET' });

    if (!response?.message) throw new Error('Invalid version response format');
    const versionString = response.message;
    const versionMatch = RewApi.VERSION_REGEX.exec(versionString);
    if (!versionMatch) throw new Error(`Invalid version format: ${versionString}`);

    const major = Number.parseInt(versionMatch[1], 10);
    const minor = Number.parseInt(versionMatch[2], 10);
    const beta = Number.parseInt(versionMatch[3], 10);
    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(beta)) {
      throw new TypeError(`Invalid version numbers: ${versionString}`);
    }
    const versionNum = major * 10000 + minor * 100 + beta;

    if (versionNum < RewApi.MIN_REQUIRED_VERSION) {
      throw new Error(
        `Installed REW version (${versionString}) is outdated and incompatible. ` +
          `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`
      );
    }

    return versionString;
  }

  async fetchREW(indice = null, method = 'GET', rawBody = null, retries = 3) {
    if (method !== 'GET' && method !== 'PUT') {
      throw new Error(`Invalid method: ${method}`);
    }
    if (method === 'PUT' && (rawBody === null || rawBody === undefined)) {
      throw new Error('Body is required for PUT requests');
    }
    try {
      const indicePath = indice === null ? '' : `/${indice}`;
      const requestUrl = `measurements${indicePath}`;
      let body = null;
      if (method === 'PUT') {
        body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
      }
      const requestOptions = {
        method,
        ...(body && { body }),
      };
      return await this.fetchWithRetry(requestUrl, requestOptions, retries);
    } catch (error) {
      const message =
        error.message ||
        `Error fetching REW measurements with body ${String(
          rawBody
        )} with method ${method}`;
      throw new Error(message, { cause: error });
    }
  }

  async fetchSafe(requestUrl, indice = null, parameters = null, retries = 3) {
    if (!requestUrl) {
      throw new Error('Request URL is required');
    }
    try {
      const indicePath = indice === null ? '' : `/${indice}`;
      const url = `measurements${indicePath}/${requestUrl}`;
      const options = {
        method: parameters ? 'POST' : 'GET',
        ...(parameters && {
          body: JSON.stringify(parameters),
        }),
      };

      return await this.fetchWithRetry(url, options, retries);
    } catch (error) {
      const message = error.message || 'Fetch failed';
      throw new Error(message, { cause: error });
    }
  }

  async fetchAlign(requestUrl) {
    if (!requestUrl) {
      throw new Error('Request URL is required');
    }
    try {
      const url = `alignment-tool/${requestUrl}`;
      return await this.fetchWithRetry(url, { method: 'GET' });
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
    if (typeof uuids !== 'string' && !Array.isArray(uuids)) {
      throw new TypeError('UUIDs must be a string or an array of strings');
    }

    const isProcessMeasurements = Array.isArray(uuids);

    if (isProcessMeasurements) {
      // check if uuids items are not null or undefined
      for (const uuid of uuids) {
        if (!uuid) {
          throw new Error('All UUIDs must be valid non-empty strings');
        }
      }
    }

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
      return await this.fetchWithRetry(
        url,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        retries
      );
    } catch (error) {
      const message = error.message || 'Process execution failed';
      throw new Error(message, { cause: error });
    }
  }

  async postSafe(requestUrl, parameters, retries = 0, method = 'POST') {
    try {
      if (!requestUrl) {
        throw new Error('Request URL is required');
      }
      if (parameters === undefined) {
        throw new Error('Parameters are required');
      }
      if (method !== 'POST' && method !== 'PUT') {
        throw new Error('Method must be either POST or PUT');
      }

      const body =
        typeof parameters === 'string' ? parameters : JSON.stringify(parameters);
      const fetchOptions = {
        method,
        body,
      };

      return await this.fetchWithRetry(requestUrl, fetchOptions, retries);
    } catch (error) {
      const message = error.message || 'Post failed';
      throw new Error(message, { cause: error });
    }
  }

  async putSafe(requestUrl, parameters, retries = 0) {
    return await this.postSafe(requestUrl, parameters, retries, 'PUT');
  }

  async postAlign(processName, frequency = null, retries = 3) {
    try {
      const result = await this.fetchWithRetry(
        `alignment-tool/command`,
        {
          method: 'POST',
          body: JSON.stringify({
            command: processName,
            ...(frequency !== null && { frequency }),
          }),
        },
        retries
      );

      const errorIntoMessage = result.message?.results?.[0]?.Error;
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
  async postDelete(indice, retries = 0) {
    if (indice === null || indice === undefined) {
      throw new Error('Indice is required');
    }

    if (typeof indice !== 'string' && typeof indice !== 'number') {
      throw new TypeError('Indice must be a string or number');
    }

    const url = `measurements/${indice}`;

    try {
      return await this.fetchWithRetry(url, { method: 'DELETE' }, retries);
    } catch (error) {
      const message = error.message || 'Delete failed';
      throw new Error(message, { cause: error });
    }
  }

  // Helper to make HTTP requests with consistent error handling
  async fetchWithRetry(url, options, retries = 3, expectedProcess = null) {
    if (
      !url ||
      options === null ||
      options === undefined ||
      typeof options !== 'object'
    ) {
      throw new Error('Missing parameters');
    }

    const completeUrl = `${this.baseUrl}/${url}`;

    // Create an abort controller for the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RewApi.TIMEOUT_MS);
    const fetchOptions = {
      ...options,
      headers: {
        ...(options.body && { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      signal: controller.signal,
    };

    try {
      const response = await fetch(completeUrl, fetchOptions);
      // Clear the timeout since the request completed
      clearTimeout(timeoutId);

      if (!response.ok) {
        const data = await response.json().catch(err => {
          console.warn('Failed to parse error response:', err);
          return {};
        });
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

      const processID =
        options.method === 'POST' ? this.extractProcessID(data, url) : null;

      // Prevent overloading the REW API only for write operations
      if (['POST', 'PUT', 'DELETE'].includes(options.method)) {
        await new Promise(resolve => setTimeout(resolve, this.speedDelay));
      }

      // Handle 200: Check if polling is needed for measurements
      if (processID && response.status === 200) {
        return this.handleStatus202(url, processID, 0);
      } else if (!this.blocking && processID && response.status === 202) {
        return this.handleStatus202(url, processID, RewApi.MAX_POLLING_RETRY);
      }

      return data;
    } catch (error) {
      // Clear the timeout if there was an error
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request ${url} timeout after ${RewApi.TIMEOUT_MS / 1000} s`);
      }

      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, RewApi.WAIT_BETWEEN_RETRIES_MS));
        return await this.fetchWithRetry(url, options, retries - 1, expectedProcess);
      }
      if (retries <= 0) {
        throw new Error(`Max retries reached for ${url}`);
      }

      throw new Error(error.message, { cause: error });
    }
  }

  extractProcessID(data, url) {
    const idRegex = /ID \d+/;

    const extractMatch = str => {
      if (!str) return null;
      const fromJson = RewApi.safeParseJSON(str);
      if (fromJson?.processName) {
        return fromJson.processName;
      }
      const match = idRegex.exec(str);
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
    if (!data) throw new Error('API response is empty');

    const isDataString = typeof data === 'string';
    const isExpectedString = typeof expectedProcess === 'string';

    const generateErrorMessage = (expected, received) => {
      return `The API response does not concern the requested task. expected: "${expected}" received: "${received}"`;
    };

    const caseInsensitiveIncludes = (str, search) => {
      if (!str || !search || typeof str !== 'string' || typeof search !== 'string') {
        return false;
      }
      return str.toLowerCase().includes(search.toLowerCase());
    };

    if (isDataString) {
      const expected = isExpectedString ? expectedProcess : expectedProcess.message;
      if (expected && !caseInsensitiveIncludes(data, expected)) {
        throw new Error(generateErrorMessage(expected, data));
      }
      return;
    }

    if (isExpectedString) {
      throw new TypeError(generateErrorMessage(expectedProcess, JSON.stringify(data)));
    }

    if (
      expectedProcess.message &&
      data.message &&
      !caseInsensitiveIncludes(data.message, expectedProcess.message)
    ) {
      throw new Error(generateErrorMessage(expectedProcess.message, data.message));
    }

    if (
      expectedProcess.processName &&
      !caseInsensitiveIncludes(data.processName, expectedProcess.processName)
    ) {
      throw new Error(
        generateErrorMessage(expectedProcess.processName, data.processName)
      );
    }
  }

  getProcessExpectedResponse(url, processID) {
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

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
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

    if (url.startsWith('alignment-tool/')) {
      return 'alignment-tool/result';
    }
    if (url.startsWith('import')) {
      return url;
    }
    return 'measurements/process-result';
  }

  static safeParseJSON(str) {
    if (!str || typeof str !== 'string') {
      return null;
    }
    const trimmed = str.trim();
    if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) {
      return null;
    }
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  static isValidIpAddress(ip) {
    if (typeof ip !== 'string') return false;
    const parts = ip.split('.');
    if (parts.length !== 4) return false;

    for (const part of parts) {
      const num = Number(part);
      if (part !== String(num) || num < 0 || num > 255) {
        return false;
      }
    }
    return true;
  }
}
