/**
 * REW EQ Library
 * Librairie pour gérer l'égalisation de Room EQ Wizard via l'API REST
 */

import RewApi from './rew-api.js';
import lm from './logs.js';

class REWEQ {
  static defaulEqtSettings = { manufacturer: 'Generic', model: 'Generic' };

  constructor(client) {
    if (!client) throw new Error('Client is required');
    if (!(client instanceof RewApi)) {
      throw new TypeError('client must be an instance of RewApi');
    }
    this.client = client;
    this.defaulEqtSettings = REWEQ.defaulEqtSettings;
  }

  async checkTargetCurve() {
    const target = await this.getHouseCurve();

    const targetCurvePath = target?.message || target;
    if (!targetCurvePath || typeof targetCurvePath !== 'string') {
      lm.warn(
        'Warning: No target curve found in REW. Please set a target curve in REW for optimal performance.'
      );
      return 'None';
    }

    const filename = targetCurvePath.replaceAll('\\', '/').split('/').pop();
    const dotIndex = filename.lastIndexOf('.');
    return (dotIndex > 0 ? filename.slice(0, dotIndex) : filename).replaceAll(' ', '');
  }

  async request(endpoint, method, body) {
    return this.client.fetchWithRetry(endpoint, method, body);
  }

  async getEqualisers(manufacturer = null) {
    const params = manufacturer
      ? `?manufacturer=${encodeURIComponent(manufacturer)}`
      : '';
    return this.request(`/eq/equalisers${params}`);
  }

  async getManufacturers() {
    return this.request('/eq/manufacturers');
  }

  async getDefaultEqualiser() {
    return this.request('/eq/default-equaliser');
  }

  async setDefaultEqualiser(equaliser) {
    // use default EQT settings if none provided
    if (!equaliser) {
      equaliser = REWEQ.defaulEqtSettings;
    }
    return this.request('/eq/default-equaliser', 'POST', equaliser);
  }

  async getDefaultTargetSettings() {
    return this.request('/eq/default-target-settings');
  }

  async setDefaultTargetSettings(settings) {
    return this.request('/eq/default-target-settings', 'POST', settings);
  }

  async getDefaultTargetLevel() {
    return this.request('/eq/default-target-level');
  }

  async setDefaultTargetLevel(level) {
    return this.request('/eq/default-target-level', 'POST', level);
  }

  async getDefaultRoomCurveSettings() {
    return this.request('/eq/default-room-curve-settings');
  }

  async setDefaultRoomCurveSettings(settings) {
    return this.request('/eq/default-room-curve-settings', 'POST', settings);
  }

  async getHouseCurve() {
    return this.request('/eq/house-curve');
  }

  async setHouseCurve(filePath) {
    return this.request('/eq/house-curve', 'POST', filePath);
  }

  async clearHouseCurve() {
    return this.request('/eq/house-curve', 'DELETE');
  }

  async getHouseCurveLogInterpolation() {
    return this.request('/eq/house-curve-log-interpolation');
  }

  async setHouseCurveLogInterpolation(enabled) {
    return this.request('/eq/house-curve-log-interpolation', 'POST', enabled);
  }

  async getMatchTargetSettings() {
    return this.request('/eq/match-target-settings');
  }

  /**
   * Set some match target settings
   * PUT /eq/match-target-settings
   * @param {*} settings
   * @returns
   */
  async putMatchTargetSettings(settings) {
    return this.request('/eq/match-target-settings', 'PUT', settings);
  }

  async setMatchTargetSettings(settings) {
    return this.request('/eq/match-target-settings', 'POST', settings);
  }

  async subscribe(url) {
    return this.request('/eq/subscribe', 'POST', { url });
  }

  async unsubscribe(url) {
    return this.request('/eq/unsubscribe', 'POST', { url });
  }

  async getSubscribers() {
    return this.request('/eq/subscribers');
  }
}

export default REWEQ;
