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
    RewApi.TIMEOUT_MS / RewApi.WAIT_BETWEEN_RETRIES_MS,
  );
  static SPEED_DELAY_INHIBIT_MS = 20;
  static SPEED_DELAY_NORMAL_MS = 500;
  static VERSION_REGEX = /^\s*(?:REW\s+)?v?(\d{1,3})\.(\d{1,3})\s+beta\s+(\d{1,4})\b/i;
  static MIN_REQUIRED_VERSION = 54071;
  static ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
  static BODY_REQUIRED_METHODS = new Set(['POST', 'PUT', 'PATCH']);
  static WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
  static IMPORT_DATA_ENDPOINTS = new Set([
    '/import/frequency-response-data',
    '/import/impulse-response-data',
  ]);

  constructor(
    baseURL = 'http://localhost:4735',
    inhibitGraphUpdates = false,
    blocking = false,
  ) {
    this.setBaseURL(baseURL);
    this.blocking = blocking;
    this.inhibitGraphUpdates = inhibitGraphUpdates;
    this.importBlockingBypassCount = 0;
    this.importBlockingRestorePending = false;

    this.rewEq = new REWEQ(this);
    this.rewMeasurements = new REWMeasurements(this);
    this.rewImport = new REWImport(this);
    this.rewAlignmentTool = new REWAlignmentTool(this);
  }

  setBaseURL(baseURL) {
    if (typeof baseURL !== 'string') {
      throw new TypeError('Base URL must be a string');
    }

    const trimmedBaseURL = baseURL.trim();
    if (!trimmedBaseURL) {
      throw new Error('Base URL is required');
    }

    let parsedBase;
    try {
      parsedBase = new URL(trimmedBaseURL);
    } catch (error) {
      throw new Error(`Invalid base URL: ${baseURL}`, { cause: error });
    }

    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      throw new Error('Base URL must use HTTP or HTTPS protocol');
    }
    if (parsedBase.username || parsedBase.password) {
      throw new Error('Base URL must not include credentials');
    }

    parsedBase.hash = '';
    parsedBase.search = '';

    this.baseURL = RewApi.trimTrailingSlashes(parsedBase.href);
  }

  static trimTrailingSlashes(value) {
    let endIndex = value.length;
    while (endIndex > 0 && value[endIndex - 1] === '/') {
      endIndex -= 1;
    }
    return value.slice(0, endIndex);
  }

  getRequestUrl(endpoint) {
    // getEndpointPath validates the endpoint shape (relative, leading slash, string).
    // We discard its return value because we want to preserve any query string in the
    // final URL while still rejecting absolute URLs and protocol-relative paths.
    RewApi.getEndpointPath(endpoint);
    return `${this.baseURL}${endpoint}`;
  }

  static normalizeMethod(method) {
    if (typeof method !== 'string') {
      throw new TypeError('Method must be a string');
    }

    const methodUpper = method.toUpperCase();
    if (!RewApi.ALLOWED_METHODS.has(methodUpper)) {
      throw new Error(`Invalid HTTP method: ${method}`);
    }
    return methodUpper;
  }

  static hasRequestBody(body) {
    return body !== null && body !== undefined;
  }

  static getEndpointPath(endpoint) {
    if (!endpoint) {
      throw new Error('Missing endpoint');
    }
    if (typeof endpoint !== 'string') {
      throw new TypeError('Endpoint must be a string');
    }
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
      throw new Error('Endpoint must be a relative API path starting with /');
    }

    return endpoint.split('?', 1)[0];
  }

  static mergeParsedMessage(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.message !== 'string') return;

    const parsed = RewApi.safeParseJSON(data.message);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(data, parsed);
    }
  }

  static extractErrorMessage(data) {
    if (!data || typeof data !== 'object') return null;
    return data.results?.[0]?.Error || null;
  }

  async getBlocking() {
    return this.request('/application/blocking');
  }

  async setBlocking(enable = true) {
    const response = await this.request('/application/blocking', 'POST', enable);
    this.blocking = enable;
    return response;
  }

  async getInhibitGraphUpdates() {
    return this.request('/application/inhibit-graph-updates');
  }

  async setInhibitGraphUpdates(enable = true) {
    const response = await this.request(
      '/application/inhibit-graph-updates',
      'POST',
      enable,
    );
    this.inhibitGraphUpdates = enable;
    return response;
  }

  getSpeedDelay() {
    return this.inhibitGraphUpdates
      ? RewApi.SPEED_DELAY_INHIBIT_MS
      : RewApi.SPEED_DELAY_NORMAL_MS;
  }

  // Application
  async getCommands() {
    return this.request('/application/commands');
  }

  async executeCommand(command, parameters = []) {
    if (typeof command !== 'string') {
      throw new TypeError('command must be a string');
    }
    if (!Array.isArray(parameters)) {
      throw new TypeError('parameters must be an array');
    }
    return this.request('/application/command', 'POST', { command, parameters });
  }

  async getLastError() {
    return this.request('/application/last-error');
  }

  async getErrors() {
    return this.request('/application/errors');
  }

  async subscribeErrors(url, parameters = null) {
    return this.request(
      '/application/errors/subscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async unsubscribeErrors(url, parameters = null) {
    return this.request(
      '/application/errors/unsubscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async getErrorSubscribers() {
    return this.request('/application/errors/subscribers');
  }

  async getLastWarning() {
    return this.request('/application/last-warning');
  }

  async getWarnings() {
    return this.request('/application/warnings');
  }

  async subscribeWarnings(url, parameters = null) {
    return this.request(
      '/application/warnings/subscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async unsubscribeWarnings(url, parameters = null) {
    return this.request(
      '/application/warnings/unsubscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async getWarningSubscribers() {
    return this.request('/application/warnings/subscribers');
  }

  async clearCommands() {
    return this.executeCommand('Clear command in progress');
  }

  async getLogging() {
    return this.request('/application/logging');
  }

  async setLogging(enable = true) {
    return this.request('/application/logging', 'POST', enable);
  }

  /**
   * Reconcile REW server state with the configured client state:
   *  - aligns `inhibit-graph-updates` and `blocking` with constructor flags,
   *  - sets the default equalizer model,
   *  - clears any in-progress command.
   *
   * Note: REW should be fully started (audio ready) before calling this; the API itself
   * does not expose a readiness probe.
   */
  async initializeAPI() {
    const inhibitGraph = await this.getInhibitGraphUpdates();
    if (inhibitGraph !== this.inhibitGraphUpdates) {
      await this.setInhibitGraphUpdates(this.inhibitGraphUpdates);
    }

    const blocking = await this.getBlocking();
    if (blocking !== this.blocking) {
      await this.setBlocking(this.blocking);
    }

    await this.rewEq.setDefaultEqualiser();
    await this.clearCommands();
  }

  async checkVersion() {
    const response = await this.request('/version');
    if (typeof response?.message !== 'string') {
      throw new TypeError('Invalid version response format');
    }
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
          `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`,
      );
    }
    return versionString;
  }

  async request(endpoint, method = 'GET', body = null) {
    const methodUpper = RewApi.normalizeMethod(method);
    const hasBody = RewApi.hasRequestBody(body);

    if (RewApi.BODY_REQUIRED_METHODS.has(methodUpper) && !hasBody) {
      throw new Error(`Request body is required for ${methodUpper} requests`);
    }

    const completeUrl = this.getRequestUrl(endpoint);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RewApi.TIMEOUT_MS);

    const options = {
      method: methodUpper,
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    };
    if (hasBody) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(completeUrl, options);

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ message: response.statusText }));

        // if data contains a message, parse it as JSON if possible
        RewApi.mergeParsedMessage(error);
        const errorMessage =
          RewApi.extractErrorMessage(error) ||
          (typeof error === 'string' ? error : error.message) ||
          `HTTP error! for URL: ${completeUrl}`;
        throw new Error(`[${response.status}] ${errorMessage}`);
      }

      const data = response.status === 204 ? {} : await response.json();

      // Validate data structure
      if (data == null) throw new Error('Invalid response data');

      // Prevent overloading the REW API only for write operations
      if (RewApi.WRITE_METHODS.has(methodUpper)) {
        await new Promise(resolve => setTimeout(resolve, this.getSpeedDelay()));
      }

      // if data contains a message, parse it as JSON if possible
      RewApi.mergeParsedMessage(data);

      // if data contains an error message, throw it
      const errorMessage = RewApi.extractErrorMessage(data);
      if (errorMessage) throw new Error(errorMessage);

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        const abortError = new Error(
          `Request ${endpoint} timeout after ${RewApi.TIMEOUT_MS / 1000} s`,
        );
        abortError.code = 'AbortError';
        throw abortError;
      }

      throw new Error(`Request failed for ${endpoint}: ${error.message}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async restoreImportBlockingIfNeeded() {
    if (this.importBlockingBypassCount === 0 && this.importBlockingRestorePending) {
      this.importBlockingRestorePending = false;
      await this.setBlocking(true);
    }
  }

  async fetchWithRetry(
    endpoint,
    method = 'GET',
    body = null,
    retries = 2,
    expectedProcess = null,
    skipImportBlockingBypass = false,
  ) {
    const methodUpper = RewApi.normalizeMethod(method);

    if (!skipImportBlockingBypass && this.shouldPollImportData(endpoint, methodUpper)) {
      const shouldToggleBlockingOff = this.importBlockingBypassCount === 0;
      this.importBlockingBypassCount += 1;

      try {
        if (shouldToggleBlockingOff) {
          this.importBlockingRestorePending = true;
          await this.setBlocking(false);
        }
        return await this.fetchWithRetry(
          endpoint,
          methodUpper,
          body,
          retries,
          expectedProcess,
          true,
        );
      } finally {
        this.importBlockingBypassCount -= 1;
        await this.restoreImportBlockingIfNeeded();
      }
    }

    try {
      const data = await this.request(endpoint, methodUpper, body);
      expectedProcess && this.validateExpectedProcess(expectedProcess, data);

      if (methodUpper === 'GET') {
        return data;
      }

      const processID = this.extractProcessID(data);

      if (!processID) {
        return data;
      }

      const processExpectedResponse = this.getProcessExpectedResponse(
        endpoint,
        processID,
      );
      const resultUrl = this.getResultUrl(endpoint, body);

      // Handle 200: Check if polling is needed for measurements
      if (this.blocking) {
        return this.request(resultUrl);
      }

      return this.fetchWithRetry(
        resultUrl,
        'GET',
        null,
        RewApi.MAX_POLLING_RETRY,
        processExpectedResponse,
      );
    } catch (error) {
      if (error.code === 'AbortError') {
        throw new Error(
          `Request ${endpoint} timeout after ${RewApi.TIMEOUT_MS / 1000} s`,
          { cause: error },
        );
      }
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, RewApi.WAIT_BETWEEN_RETRIES_MS));
        return this.fetchWithRetry(
          endpoint,
          methodUpper,
          body,
          retries - 1,
          expectedProcess,
          skipImportBlockingBypass,
        );
      }
      throw new Error(`Max retries reached for ${endpoint}: ${error.message}`, {
        cause: error,
      });
    }
  }

  shouldPollImportData(endpoint, method = 'GET') {
    const methodUpper = RewApi.normalizeMethod(method);
    if (methodUpper === 'GET') {
      return false;
    }

    const endpointPath = RewApi.getEndpointPath(endpoint);
    return (
      RewApi.IMPORT_DATA_ENDPOINTS.has(endpointPath) &&
      (this.blocking || this.importBlockingBypassCount > 0)
    );
  }

  extractProcessID(data) {
    if (!data) {
      throw new Error('API response is empty');
    }

    const idRegex = /ID \d+/;

    const extractMatch = str => {
      if (typeof str !== 'string' || !str) return null;

      const match = idRegex.exec(str);
      if (!match) return null;
      // Return the prefix up to and including the matched "ID <n>" so it can be used
      // as a unique process identifier when matching against later REW responses.
      return str.substring(0, match.index + match[0].length);
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

    const stringify = value => {
      if (typeof value === 'string') return value;
      if (value === undefined) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const getReceivedField = fieldName => {
      if (typeof data === 'string') return data;
      if (!data || typeof data !== 'object') return stringify(data);
      return stringify(data[fieldName]);
    };

    if (isExpectedString) {
      const received =
        typeof data === 'string'
          ? data
          : [data?.processName, data?.message, stringify(data)].filter(Boolean).join(' ');
      if (!caseInsensitiveIncludes(received, expectedProcess)) {
        throw new Error(generateErrorMessage(expectedProcess, received));
      }
      return;
    }

    for (const fieldName of ['message', 'processName']) {
      const expected = expectedProcess[fieldName];
      if (!expected) continue;

      const received = getReceivedField(fieldName);
      if (!caseInsensitiveIncludes(received, expected)) {
        throw new Error(generateErrorMessage(expected, received));
      }
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
  getResultUrl(url, body = null) {
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

    if (body?.resultUrl) {
      RewApi.getEndpointPath(body.resultUrl);
      return body.resultUrl;
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

  static createSubscriber(url, parameters = null) {
    if (typeof url !== 'string' || !url) {
      throw new TypeError('Subscriber URL must be a non-empty string');
    }

    const subscriber = { url };
    if (parameters !== null && parameters !== undefined) {
      if (typeof parameters !== 'object' || Array.isArray(parameters)) {
        throw new TypeError('Subscriber parameters must be an object');
      }
      subscriber.parameters = parameters;
    }
    return subscriber;
  }

  static decodeBase64ToFloat32(base64String, isLittleEndian = false) {
    if (typeof base64String !== 'string') {
      throw new TypeError('Base64 input must be a string');
    }
    try {
      const binaryString = atob(base64String);
      // atob returns a binary (Latin-1) string; charCodeAt is the correct API for
      // single-byte values in [0, 255].
      const bytes = Uint8Array.from(binaryString, char => char.codePointAt(0) ?? 0);
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new Error('Float32 payload byte length must be a multiple of 4');
      }
      const view = new DataView(bytes.buffer);
      const sampleCount = view.byteLength / Float32Array.BYTES_PER_ELEMENT;
      const floats = new Float32Array(sampleCount);
      for (let index = 0; index < sampleCount; index++) {
        floats[index] = view.getFloat32(
          index * Float32Array.BYTES_PER_ELEMENT,
          isLittleEndian,
        );
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
      for (let index = 0; index < floatArray.length; index++) {
        view.setFloat32(
          index * Float32Array.BYTES_PER_ELEMENT,
          floatArray[index],
          isLittleEndian,
        );
      }
      const bytes = new Uint8Array(buffer);
      const CHUNK_SIZE = 0x8000;
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, bytes.length);
        chunks.push(String.fromCodePoint(...bytes.subarray(offset, end)));
      }
      return btoa(chunks.join(''));
    } catch (error) {
      throw new Error(`Error encoding data to base64: ${error.message}`, {
        cause: error,
      });
    }
  }
}
