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

  async subscribe(url) {
    return this.request('/import/subscribe', 'POST', { url });
  }

  async unsubscribe(url) {
    return this.request('/import/unsubscribe', 'POST', { url });
  }

  async getSubscribers() {
    return this.request('/import/subscribers');
  }

  // ==================== FREQUENCY RESPONSE ====================

  async importFrequencyResponse(filePath) {
    return this.request('/import/frequency-response', 'POST', { path: filePath });
  }

  async getLastFrequencyResponseImport() {
    return this.request('/import/frequency-response');
  }

  // code do not wait for the server to process the data !
  async importFrequencyResponseData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be an object');
    }
    if (!data.magnitude || !data.phase) {
      throw new Error('Data must contain magnitude and phase');
    }
    // magnitude and phase should be Float32Array or base64 strings
    if (!(data.magnitude instanceof Float32Array) && typeof data.magnitude !== 'string') {
      throw new TypeError('Magnitude must be a Float32Array or base64 string');
    }
    if (!(data.phase instanceof Float32Array) && typeof data.phase !== 'string') {
      throw new TypeError('Phase must be a Float32Array or base64 string');
    }
    if (data.magnitude instanceof Float32Array) {
      data.magnitude = RewApi.encodeFloat32ToBase64(data.magnitude);
    }
    if (data.phase instanceof Float32Array) {
      data.phase = RewApi.encodeFloat32ToBase64(data.phase);
    }
    return this.request('/import/frequency-response-data', 'POST', data);
  }

  async getLastFrequencyResponseDataImport() {
    return this.request('/import/frequency-response-data');
  }

  // ==================== IMPULSE RESPONSE ====================

  async importImpulseResponse(filePath, channels = 'All') {
    return this.request('/import/impulse-response', 'POST', { path: filePath, channels });
  }

  async getLastImpulseResponseImport() {
    return this.request('/import/impulse-response');
  }

  async importImpulseResponseData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be an object');
    }
    if (!data.data) {
      throw new Error('Data must contain data property');
    }
    // data.data should be Float32Array or base64 strings
    if (!(data.data instanceof Float32Array) && typeof data.data !== 'string') {
      throw new TypeError('Magnitude must be a Float32Array or base64 string');
    }
    if (data.data instanceof Float32Array) {
      data.data = RewApi.encodeFloat32ToBase64(data.data);
    }
    return this.request('/import/impulse-response-data', 'POST', data);
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

  async importSweepResponse(filePath, channels = 'All') {
    return this.request('/import/sweep-recordings/response', 'POST', {
      path: filePath,
      channels,
    });
  }

  async getLastSweepResponseImport() {
    return this.request('/import/sweep-recordings/response');
  }
}

export default REWImport;
