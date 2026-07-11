/**
 * REW Import Library
 * Librairie pour gérer les imports de Room EQ Wizard via l'API REST
 */

import RewApi from './rew-api.js';

class REWImport {
  constructor(client) {
    if (!client) throw new Error('Client is required');
    if (!(client instanceof RewApi)) {
      throw new TypeError('client must be an instance of RewApi');
    }
    this.client = client;
  }

  async request(endpoint, method, body, retries = 0) {
    return this.client.fetchWithRetry(endpoint, method, body, retries);
  }

  static buildFilePathPayload(filePath, options = {}) {
    if (typeof options === 'string') {
      return { path: filePath, channels: options };
    }
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    return { path: filePath, ...options };
  }

  static hasValue(value) {
    return value !== null && value !== undefined;
  }

  async subscribe(url, parameters = null) {
    return this.request(
      '/import/subscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async unsubscribe(url, parameters = null) {
    return this.request(
      '/import/unsubscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async getSubscribers() {
    return this.request('/import/subscribers');
  }

  // ==================== FREQUENCY RESPONSE ====================

  async importFrequencyResponse(filePath, options = {}) {
    return this.request(
      '/import/frequency-response',
      'POST',
      REWImport.buildFilePathPayload(filePath, options),
    );
  }

  async getLastFrequencyResponseImport() {
    return this.request('/import/frequency-response');
  }

  // Note: fetchWithRetry handles blocking mode and polling for the result.
  async importFrequencyResponseData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be an object');
    }
    if (!REWImport.hasValue(data.magnitude) || !REWImport.hasValue(data.phase)) {
      throw new Error('Data must contain magnitude and phase');
    }
    if (!REWImport.hasValue(data.startFreq)) {
      throw new Error('Data must contain startFreq');
    }
    if (!REWImport.hasValue(data.freqStep) && !REWImport.hasValue(data.ppo)) {
      throw new Error('Data must contain freqStep or ppo');
    }
    // magnitude and phase should be Float32Array or base64 strings
    if (!(data.magnitude instanceof Float32Array) && typeof data.magnitude !== 'string') {
      throw new TypeError('Magnitude must be a Float32Array or base64 string');
    }
    if (!(data.phase instanceof Float32Array) && typeof data.phase !== 'string') {
      throw new TypeError('Phase must be a Float32Array or base64 string');
    }
    const payload = { ...data };
    if (payload.magnitude instanceof Float32Array) {
      payload.magnitude = RewApi.encodeFloat32ToBase64(payload.magnitude);
    }
    if (payload.phase instanceof Float32Array) {
      payload.phase = RewApi.encodeFloat32ToBase64(payload.phase);
    }
    return this.request('/import/frequency-response-data', 'POST', payload);
  }

  async getLastFrequencyResponseDataImport() {
    return this.request('/import/frequency-response-data');
  }

  // ==================== IMPULSE RESPONSE ====================

  async importImpulseResponse(filePath, channels = 'All', options = {}) {
    const bodyOptions =
      typeof channels === 'object' && channels !== null
        ? channels
        : { ...options, channels };
    return this.request(
      '/import/impulse-response',
      'POST',
      REWImport.buildFilePathPayload(filePath, bodyOptions),
    );
  }

  async getLastImpulseResponseImport() {
    return this.request('/import/impulse-response');
  }

  async importImpulseResponseData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be an object');
    }
    if (!REWImport.hasValue(data.data)) {
      throw new Error('Data must contain data property');
    }
    if (!REWImport.hasValue(data.sampleRate)) {
      throw new Error('Data must contain sampleRate');
    }
    // data.data should be Float32Array or base64 strings
    if (!(data.data instanceof Float32Array) && typeof data.data !== 'string') {
      throw new TypeError('Data must be a Float32Array or base64 string');
    }
    const payload = { ...data };
    if (payload.data instanceof Float32Array) {
      payload.data = RewApi.encodeFloat32ToBase64(payload.data);
    }
    return this.request('/import/impulse-response-data', 'POST', payload);
  }

  async getLastImpulseResponseDataImport() {
    return this.request('/import/impulse-response-data');
  }

  // ==================== RTA FILE ====================

  async importRTAFile(filePath, channel, saveOption = 'current') {
    return this.request('/import/rta-file', 'POST', {
      path: filePath,
      channel,
      saveOption,
    });
  }

  async getRTAFileProgress() {
    return this.request('/import/rta-file/progress');
  }

  async getRTAFileSaveOptions() {
    return this.request('/import/rta-file/save-options');
  }

  async getLastRTAFileImport() {
    return this.request('/import/rta-file');
  }

  // ==================== SWEEP RECORDINGS ====================

  async setSweepStimulus(filePath) {
    return this.request('/import/sweep-recordings/stimulus', 'POST', filePath);
  }

  async getSweepStimulus() {
    return this.request('/import/sweep-recordings/stimulus');
  }

  async importSweepResponse(filePath, channels = 'All', options = {}) {
    const bodyOptions =
      typeof channels === 'object' && channels !== null
        ? channels
        : { ...options, channels };
    return this.request('/import/sweep-recordings/response', 'POST', {
      path: filePath,
      ...bodyOptions,
    });
  }

  async getLastSweepResponseImport() {
    return this.request('/import/sweep-recordings/response');
  }
}

export default REWImport;
