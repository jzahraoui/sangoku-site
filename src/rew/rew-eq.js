/**
 * REW EQ Library
 * Librairie pour gérer l'égalisation de Room EQ Wizard via l'API REST
 */

import RewApi from './rew-api.js';

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

  async getTargetShapes() {
    return this.request('/eq/target-shapes');
  }

  async getCrossoverTypes() {
    return this.request('/eq/crossover-types');
  }

  async getSlopes() {
    return this.request('/eq/slopes');
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

  async putDefaultTargetSettings(settings) {
    return this.request('/eq/default-target-settings', 'PUT', settings);
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

  async putDefaultRoomCurveSettings(settings) {
    return this.request('/eq/default-room-curve-settings', 'PUT', settings);
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

  async getCommands() {
    return this.request('/eq/commands');
  }

  async executeCommand(command, parameters = []) {
    if (typeof command !== 'string') {
      throw new TypeError('command must be a string');
    }
    if (!Array.isArray(parameters)) {
      throw new TypeError('parameters must be an array');
    }
    return this.request('/eq/command', 'POST', { command, parameters });
  }

  async generateTargetMeasurement() {
    return this.executeCommand('Generate target measurement');
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

  async subscribe(url, parameters = null) {
    return this.request(
      '/eq/subscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async unsubscribe(url, parameters = null) {
    return this.request(
      '/eq/unsubscribe',
      'POST',
      RewApi.createSubscriber(url, parameters),
    );
  }

  async getSubscribers() {
    return this.request('/eq/subscribers');
  }
}

export default REWEQ;
