/**
 * REW Import Library
 * Librairie pour gérer les imports de Room EQ Wizard via l'API REST
 */

import RewApi from './rew-api.js';

class REWImport {
  constructor(client = null) {
    this.client = client || new RewApi();
  }

  async request(endpoint, method, body) {
    return this.client.fetchWithRetry(endpoint, method, body);
  }

  decodeBase64ToFloat32(base64String) {
    return this.client.decodeBase64ToFloat32(base64String);
  }

  encodeFloat32ToBase64(floatArray) {
    return this.client.encodeFloat32ToBase64(floatArray);
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

  async importFrequencyResponseData(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Data must be an object');
    }
    if (!data.magnitude || !data.phase) {
      throw new Error('Data must contain magnitude and phase');
    }
    // if magnitude and phase are provided as Float32Array, encode them to base64
    if (Array.isArray(data.magnitude)) {
      data.magnitude = this.encodeFloat32ToBase64(data.magnitude);
    }
    if (Array.isArray(data.phase)) {
      data.phase = this.encodeFloat32ToBase64(data.phase);
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
    // if magnitude and phase are provided as Float32Array, encode them to base64
    if (Array.isArray(data.data)) {
      data.data = this.encodeFloat32ToBase64(data.data);
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
