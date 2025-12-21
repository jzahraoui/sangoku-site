/**
 * REW Client Base
 * Classe de base pour les clients de l'API REST de Room EQ Wizard
 * Fournit la connexion HTTP et les méthodes utilitaires communes
 */
import REWEQ from './rew-eq.js';
import REWImport from './rew-import.js';
import REWAlignmentTool from './rew-alignment-tool.js';
import REWMeasurements from './rew-measurements.js';

export default class RewApi {
  static TIMEOUT_MS = 15000;
  static WAIT_BETWEEN_RETRIES_MS = 100;
  static MAX_POLLING_RETRY = Math.floor(
    RewApi.TIMEOUT_MS / RewApi.WAIT_BETWEEN_RETRIES_MS
  );
  static SPEED_DELAY_INHIBIT_MS = 20;
  static SPEED_DELAY_NORMAL_MS = 500;
  static VERSION_REGEX = /(\d+)\.(\d+)\sBeta\s(\d+)/;
  static MIN_REQUIRED_VERSION = 54071;

  constructor(
    baseURL = 'http://localhost:4735',
    inhibitGraphUpdates = false,
    blocking = false
  ) {
    this.setBaseURL(baseURL);
    this.blocking = blocking;
    this.inhibitGraphUpdates = inhibitGraphUpdates;

    this.rewEq = new REWEQ(this);
    this.rewMeasurements = new REWMeasurements(this);
    this.rewImport = new REWImport(this);
    this.rewAlignmentTool = new REWAlignmentTool(this);
  }

  setBaseURL(baseURL) {
    if (!baseURL) {
      throw new Error('Base URL is required');
    }
    if (typeof baseURL !== 'string') {
      throw new TypeError('Base URL must be a string');
    }
    // Validate URL to prevent SSRF attacks
    const parsedBase = new URL(baseURL);
    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      throw new Error('Base URL must use HTTP or HTTPS protocol');
    }

    this.baseURL = baseURL;
  }

  async getBlocking() {
    return this.request('/application/blocking');
  }

  async setBlocking(enable = true) {
    this.blocking = enable;
    return this.request('/application/blocking', 'POST', enable);
  }

  async getInhibitGraphUpdates() {
    return this.request('/application/inhibit-graph-updates');
  }

  async setInhibitGraphUpdates(enable = true) {
    this.inhibitGraphUpdates = enable;
    return this.request('/application/inhibit-graph-updates', 'POST', enable);
  }

  getSpeedDelay() {
    return this.inhibitGraphUpdates
      ? RewApi.SPEED_DELAY_INHIBIT_MS
      : RewApi.SPEED_DELAY_NORMAL_MS;
  }

  // Application
  async getLastError() {
    return this.request('/application/last-error');
  }

  async clearCommands() {
    return this.request('/application/command', 'POST', {
      command: 'Clear command in progress',
    });
  }

  async setLogging(enable = true) {
    return this.request('/application/logging', 'POST', enable);
  }

  async getErrors() {
    return this.request('/application/errors');
  }

  /**
   * Initialisation: Active le mode blocking et vérifie que l'audio est prêt
   * Règle: Attendre quelques secondes après le démarrage de REW avant toute opération
   */
  async initializeAPI() {
    // actual settings
    const inhibitGraph = await this.getInhibitGraphUpdates();
    const blocking = await this.getBlocking();
    // set to desired settings
    if (inhibitGraph !== this.inhibitGraphUpdates)
      await this.setInhibitGraphUpdates(this.inhibitGraphUpdates);
    if (blocking !== this.blocking) await this.setBlocking(this.blocking);
    await this.rewEq.setDefaultEqualiser();

    await this.clearCommands();
  }

  async checkVersion() {
    const response = await this.request('/version');
    if (!response?.message) throw new Error('Invalid version response format');
    const versionString = response.message;
    const versionMatch = RewApi.VERSION_REGEX.exec(versionString);
    if (!versionMatch) throw new Error(`Invalid version format: ${versionString}`);

    const major = Number.parseInt(versionMatch[1], 10);
    const minor = Number.parseInt(versionMatch[2], 10);
    const beta = Number.parseInt(versionMatch[3], 10);
    const versionNum = major * 10000 + minor * 100 + beta;

    if (versionNum < RewApi.MIN_REQUIRED_VERSION) {
      throw new Error(
        `Installed REW version (${versionString}) is outdated and incompatible. ` +
          `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`
      );
    }
    return versionString;
  }

  async request(endpoint, method = 'GET', body = null) {
    if (!endpoint) {
      throw new Error('Missing endpoint');
    }
    if (typeof method !== 'string') {
      throw new TypeError('Method must be a string');
    }
    if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method.toUpperCase())) {
      throw new Error(`Invalid HTTP method: ${method}`);
    }
    if (['POST', 'PUT'].includes(method.toUpperCase()) && body === null) {
      throw new Error('Request body is required for non-GET requests');
    }

    const completeUrl = `${this.baseURL}${endpoint}`;

    // Create an abort controller for the timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RewApi.TIMEOUT_MS);

    const options = {
      method,
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    };
    if (body !== null) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    const parseMessage = obj => {
      if (obj.message && typeof obj.message === 'string') {
        const parsed = RewApi.safeParseJSON(obj.message);
        if (parsed) Object.assign(obj, parsed);
      }
    };

    try {
      const response = await fetch(completeUrl, options);
      // Clear the timeout since the request completed
      clearTimeout(timeoutId);

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ message: response.statusText }));

        // if data contains a message, parse it as JSON if possible
        parseMessage(error);
        const errorMessage =
          error?.results?.[0]?.Error ||
          error.message ||
          `HTTP error! for URL: ${completeUrl}`;
        throw new Error(`[${response.status}] ${errorMessage}`);
      }

      const data = await response.json();

      // Validate data structure
      if (data == null) throw new Error('Invalid response data');

      // Prevent overloading the REW API only for write operations
      if (['POST', 'PUT', 'DELETE'].includes(options.method)) {
        await new Promise(resolve => setTimeout(resolve, this.getSpeedDelay()));
      }

      // if data contains a message, parse it as JSON if possible
      parseMessage(data);

      // if data contains an error message, throw it
      const errorMessage = data.results?.[0]?.Error;
      if (errorMessage) throw new Error(errorMessage);

      return data;
    } catch (error) {
      // Clear the timeout if there was an error
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        const abortError = new Error(
          `Request ${endpoint} timeout after ${RewApi.TIMEOUT_MS / 1000} s`
        );
        abortError.code = 'AbortError';
        throw abortError;
      }

      throw new Error(`Request failed for ${endpoint}: ${error.message}`);
    }
  }

  async fetchWithRetry(
    endpoint,
    method = 'GET',
    body = null,
    retries = 2,
    expectedProcess = null
  ) {
    try {
      const data = await this.request(endpoint, method, body);
      if (expectedProcess) {
        this.validateExpectedProcess(expectedProcess, data);
      }

      if (method === 'GET') {
        return data;
      }

      const processID = this.extractProcessID(data);

      if (!processID) {
        return data;
      }

      const processExpectedResponse = this.getProcessExpectedResponse(
        endpoint,
        processID
      );
      const resultUrl = this.getResultUrl(endpoint);

      // Handle 200: Check if polling is needed for measurements
      if (this.blocking) {
        return this.request(resultUrl);
      }

      return this.fetchWithRetry(
        resultUrl,
        'GET',
        null,
        RewApi.MAX_POLLING_RETRY,
        processExpectedResponse
      );
    } catch (error) {
      if (error.code === 'AbortError') {
        throw new Error(
          `Request ${endpoint} timeout after ${RewApi.TIMEOUT_MS / 1000} s`
        );
      }
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, RewApi.WAIT_BETWEEN_RETRIES_MS));
        return this.fetchWithRetry(endpoint, method, body, retries - 1, expectedProcess);
      }
      throw new Error(`Max retries reached for ${endpoint}: ${error.message}`);
    }
  }

  extractProcessID(data) {
    if (!data) {
      throw new Error('API response is empty');
    }

    const idRegex = /ID \d+/;

    const extractMatch = str => {
      if (!str) return null;
      if (typeof str !== 'string') return null;

      const match = idRegex.exec(str);
      if (!match) return null;
      const idIndex = str.indexOf(match[0]);
      return str.substring(0, idIndex + match[0].length);
    };

    if (typeof data === 'string') {
      return extractMatch(data) || null;
    }
    // if data have message try to extract from there
    if (data.message && typeof data.message === 'string') {
      const result = extractMatch(data.message);
      if (result) return result;
    }

    if (data.processName && typeof data.processName === 'string') {
      const result = extractMatch(data.processName);
      if (result) return result;
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
      if (typeof str !== 'string' || typeof search !== 'string') {
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
      throw new Error(generateErrorMessage(expectedProcess, JSON.stringify(data)));
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
    if (!processID) {
      throw new Error('Process ID is required');
    }

    return url.startsWith('/import')
      ? processID
      : { processName: processID, message: 'Completed' };
  }

  // Helper methods
  getResultUrl(url) {
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

    if (url.startsWith('/alignment-tool/')) {
      return '/alignment-tool/result';
    }
    if (url.startsWith('/import')) {
      return url;
    }
    return '/measurements/process-result';
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

  static decodeBase64ToFloat32(base64String, isLittleEndian = false) {
    if (typeof base64String !== 'string') {
      throw new TypeError('Base64 input must be a string');
    }
    try {
      const binaryString = atob(base64String);
      const bytes = Uint8Array.from(binaryString, char => char.codePointAt(0));
      const view = new DataView(bytes.buffer);
      const sampleCount = view.byteLength / Float32Array.BYTES_PER_ELEMENT;
      const floats = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        floats[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, isLittleEndian);
      }
      return floats;
    } catch (error) {
      throw new Error(`Error decoding base64 data: ${error.message}`, { cause: error });
    }
  }

  static encodeFloat32ToBase64(floatArray, isLittleEndian = false) {
    if (!(floatArray instanceof Float32Array)) {
      throw new TypeError('Input must be a Float32Array');
    }
    try {
      const buffer = new ArrayBuffer(floatArray.length * Float32Array.BYTES_PER_ELEMENT);
      const view = new DataView(buffer);
      for (let i = 0; i < floatArray.length; i++) {
        view.setFloat32(
          i * Float32Array.BYTES_PER_ELEMENT,
          floatArray[i],
          isLittleEndian
        );
      }
      const bytes = new Uint8Array(buffer);
      const CHUNK_SIZE = 0x8000;
      let binaryString = '';
      for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, bytes.length);
        for (let j = i; j < end; j++) {
          binaryString += String.fromCodePoint(bytes[j]);
        }
      }
      return btoa(binaryString);
    } catch (error) {
      throw new Error(`Error encoding data to base64: ${error.message}`, {
        cause: error,
      });
    }
  }
}
