/**
 * REW Alignment Tool Library
 * Librairie pour gérer l'alignment tool de Room EQ Wizard via l'API REST
 */
import RewApi from './rew-api.js';

class REWAlignmentTool {
  constructor(client) {
    if (!client) throw new Error('Client is required');
    if (!(client instanceof RewApi)) {
      throw new TypeError('client must be an instance of RewApi');
    }
    this.client = client;
  }

  async request(endpoint, method, body, retries = 2) {
    return this.client.fetchWithRetry(endpoint, method, body, retries);
  }

  /**
   *
   * GET /alignment-tool/commands
   *
   * example response:
   *
   * [
   *   "Level phase",
   *   "Undo level phase",
   *   "Align phase slopes",
   *   "Align phase",
   *   "Filter IRs",
   *   "Align IRs",
   *   "Clear filter",
   *   "Aligned copy of A",
   *   "Aligned copy of B",
   *   "Aligned sum",
   *   "Reset all"
   * ]
   *
   * @returns  list of commands
   */
  async getCommands() {
    return this.request('/alignment-tool/commands');
  }

  async executeCommand(command, parameters = null, resultUrl = null, retries = 0) {
    if (typeof command !== 'string') {
      throw new TypeError('command must be a string');
    }
    if (parameters && typeof parameters !== 'object') {
      throw new TypeError('parameters must be an object');
    }
    const body = { command, ...parameters };
    if (resultUrl) body.resultUrl = resultUrl;
    return this.request('/alignment-tool/command', 'POST', body, retries);
  }

  /**
   * Level phase
   */
  async levelPhase(parameters) {
    return this.executeCommand('Level phase', parameters);
  }

  /**
   * Undo level phase
   * */
  async undoLevelPhase(parameters) {
    return this.executeCommand('Undo level phase', parameters);
  }
  /**
   * Align phase slopes
   */
  async alignPhaseSlopes(parameters) {
    return this.executeCommand('Align phase slopes', parameters);
  }

  /**
   * Align phase
   */
  async alignPhase(parameters) {
    return this.executeCommand('Align phase', parameters);
  }

  /**
   * Filter IRs
   */
  async filterIRs(parameters) {
    return this.executeCommand('Filter IRs', parameters);
  }

  /**
   * Align IRs
   */
  async alignIRs(parameters, retries = 0) {
    return this.executeCommand('Align IRs', { frequency: parameters }, retries);
  }

  /**
   * Clear filter
   */
  async clearFilter(parameters) {
    return this.executeCommand('Clear filter', parameters);
  }

  /**
   * Aligned copy of A
   */
  async alignedCopyA(parameters) {
    return this.executeCommand('Aligned copy of A', parameters);
  }

  /**
   * Aligned copy of B
   */
  async alignedCopyB(parameters) {
    return this.executeCommand('Aligned copy of B', parameters);
  }

  /**
   * Aligned sum
   */
  async alignedSum() {
    return this.executeCommand('Aligned sum');
  }

  /**
   * Reset all
   */
  async resetAll() {
    return this.executeCommand('Reset all');
  }

  async getMode() {
    return this.request('/alignment-tool/mode');
  }

  async setMode(mode) {
    return this.request('/alignment-tool/mode', 'POST', mode);
  }

  async getModes() {
    return this.request('/alignment-tool/modes');
  }

  async getFrequency() {
    return this.request('/alignment-tool/frequency');
  }

  async getIndexA() {
    return this.request('/alignment-tool/index-a');
  }

  async setIndexA(index) {
    return this.request('/alignment-tool/index-a', 'POST', index);
  }

  async getIndexB() {
    return this.request('/alignment-tool/index-b');
  }

  async setIndexB(index) {
    return this.request('/alignment-tool/index-b', 'POST', index);
  }

  async getGainA() {
    return this.request('/alignment-tool/gain-a');
  }

  async setGainA(gain) {
    return this.request('/alignment-tool/gain-a', 'POST', gain);
  }

  async getGainB() {
    return this.request('/alignment-tool/gain-b');
  }

  async setGainB(gain) {
    return this.request('/alignment-tool/gain-b', 'POST', gain);
  }

  async getDelayA() {
    return this.request('/alignment-tool/delay-a');
  }

  async setDelayA(delay) {
    return this.request('/alignment-tool/delay-a', 'POST', delay);
  }

  async getDelayB() {
    return this.request('/alignment-tool/delay-b');
  }

  async setDelayB(delay) {
    return this.request('/alignment-tool/delay-b', 'POST', delay);
  }

  async getInvertA() {
    return this.request('/alignment-tool/invert-a');
  }

  async setInvertA(invert) {
    return this.request('/alignment-tool/invert-a', 'POST', invert);
  }

  async getInvertB() {
    return this.request('/alignment-tool/invert-b');
  }

  async setInvertB(invert) {
    return this.request('/alignment-tool/invert-b', 'POST', invert);
  }

  async getMaxPositiveDelay() {
    return this.request('/alignment-tool/max-positive-delay');
  }

  async setMaxPositiveDelay(delay) {
    return this.request('/alignment-tool/max-positive-delay', 'POST', delay);
  }

  async getMaxNegativeDelay() {
    return this.request('/alignment-tool/max-negative-delay');
  }

  async setMaxNegativeDelay(delay) {
    return this.request('/alignment-tool/max-negative-delay', 'POST', delay);
  }

  /**
   * GET /alignment-tool/remove-time-delay
   * Get whether the first measurement should have delay removed when using the tool via the GUI
   * @param {*} options
   * @returns
   */
  async getRemoveTimeDelay() {
    return this.request('/alignment-tool/remove-time-delay');
  }

  /**
   * POST /alignment-tool/remove-time-delay
   * Set whether the first measurement should have delay removed when using the tool via the GUI
   * @param {*} remove
   * @returns
   */
  async setRemoveTimeDelay(remove) {
    if (typeof remove !== 'boolean') {
      throw new TypeError('remove must be a boolean');
    }
    return this.request('/alignment-tool/remove-time-delay', 'POST', remove);
  }

  /**
   * Get the UUID of measurement A
   * GET /alignment-tool/uuid-a
   * @return {Promise<string>} UUID of measurement A
   */
  async getUuidA() {
    return this.request('/alignment-tool/uuid-a');
  }

  /**
   * Set the UUID of measurement A
   * POST /alignment-tool/uuid-a
   * @param {string} uuid UUID of measurement A
   * @return {Promise<void>}
   */
  async setUuidA(uuid) {
    return this.request('/alignment-tool/uuid-a', 'POST', uuid);
  }

  /**
   * Get the UUID of measurement B
   * GET /alignment-tool/uuid-b
   * @return {Promise<string>} UUID of measurement B
   */
  async getUuidB() {
    return this.request('/alignment-tool/uuid-b');
  }

  /**
   * Set the UUID of measurement B
   * POST /alignment-tool/uuid-b
   * @param {string} uuid UUID of measurement B
   * @return {Promise<void>}
   */
  async setUuidB(uuid) {
    return this.request('/alignment-tool/uuid-b', 'POST', uuid);
  }

  async getAlignedFrequencyResponse(options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.smoothing) params.append('smoothing', options.smoothing);
    if (options.ppo) params.append('ppo', options.ppo);

    const query = params.toString();
    const data = await this.request(
      `/alignment-tool/aligned-frequency-response${query ? '?' + query : ''}`
    );

    return {
      ...data,
      magnitude: RewApi.decodeBase64ToFloat32(data.magnitude),
      phase: data.phase ? RewApi.decodeBase64ToFloat32(data.phase) : null,
    };
  }

  async getFilteredImpulseResponseA(options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.windowed !== undefined) params.append('windowed', options.windowed);
    if (options.normalised !== undefined) params.append('normalised', options.normalised);

    const query = params.toString();
    const data = await this.request(
      `/alignment-tool/filtered-impulse-response-a${query ? '?' + query : ''}`
    );

    return {
      ...data,
      dataArray: RewApi.decodeBase64ToFloat32(data.data),
    };
  }

  async getFilteredImpulseResponseB(options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.windowed !== undefined) params.append('windowed', options.windowed);
    if (options.normalised !== undefined) params.append('normalised', options.normalised);

    const query = params.toString();
    const data = await this.request(
      `/alignment-tool/filtered-impulse-response-b${query ? '?' + query : ''}`
    );

    return {
      ...data,
      dataArray: RewApi.decodeBase64ToFloat32(data.data),
    };
  }

  async getResult() {
    return this.request('/alignment-tool/result');
  }

  async alignPaseBatch(indexA, indexB, mode, frequency) {
    await this.setIndexA(indexA);
    await this.setIndexB(indexB);
    await this.setMode(mode);
    return this.executeCommand('Align phase', frequency);
  }

  async alignIRsBatch(uuidA, uuidB, frequency) {
    await this.setUuidA(uuidA);
    await this.setUuidB(uuidB);
    await this.setMode('Impulse');
    return this.alignIRs(frequency, 0);
  }
}

export default REWAlignmentTool;
