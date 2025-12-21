/**
 * REW Measurements Library
 * Librairie pour gérer les measurements de Room EQ Wizard via l'API REST
 * Concentrée sur l'endpoint /measurements avec toutes les règles de gestion
 */

import RewApi from './rew-api.js';

class REWMeasurements {
  constructor(client) {
    if (!client) throw new Error('Client is required');
    if (!(client instanceof RewApi)) {
      throw new TypeError('client must be an instance of RewApi');
    }
    this.client = client;
    this.measurementCommands = null;
    this.arithmeticFunctions = null;
  }

  /**
   * Generate frequency array based on start frequency and step or PPO
   * @param {number} dataLength - Length of the array to generate
   * @param {number} startFreq - Starting frequency
   * @param {number} [freqStep] - Frequency step for linear spacing
   * @param {number} [ppo] - Points per octave for logarithmic spacing
   * @returns {Float32Array} Float32Array of frequency values
   */
  generateFrequencyArray(dataLength, startFreq, freqStep = null, ppo = null) {
    if (!dataLength || dataLength <= 0) {
      throw new Error('dataLength must be a positive number');
    }
    if (!startFreq || startFreq <= 0) {
      throw new Error('startFreq must be a positive number');
    }
    if (!freqStep && !ppo) {
      throw new Error('Either freqStep or ppo is required');
    }

    const generator = freqStep
      ? (_, i) => startFreq + i * freqStep
      : (_, i) => startFreq * Math.pow(2, i / ppo);

    return Float32Array.from({ length: dataLength }, generator);
  }

  async request(endpoint, method, body) {
    return this.client.fetchWithRetry(endpoint, method, body);
  }

  async getMaxMeasurements() {
    return this.request('/measurements/max-measurements');
  }

  /**
   * Liste tous les measurements
   * Retourne un tableau de MeasurementSummary avec UUID
   */
  async list() {
    return this.request('/measurements');
  }

  /**
   * Récupère un measurement par UUID ou index
   * Règle: TOUJOURS utiliser UUID plutôt que index (les index changent)
   */
  async get(id) {
    return this.request(`/measurements/${id}`);
  }

  /**
   * Récupère l'UUID du measurement sélectionné
   */
  async getSelectedUUID() {
    return this.request('/measurements/selected-uuid');
  }

  /**
   * Sélectionne un measurement par UUID
   * Règle: Utiliser UUID pour éviter les problèmes avec les groupes
   */
  async selectByUUID(uuid) {
    return this.request('/measurements/selected-uuid', 'POST', uuid);
  }

  /**
   * Supprime un measurement par UUID ou index
   * ATTENTION: Pas de confirmation!
   */
  async delete(id) {
    return this.request(`/measurements/${id}`, 'DELETE');
  }

  /**
   * Supprime tous les measurements
   * ATTENTION: Pas de confirmation!
   */
  async deleteAll() {
    return this.request('/measurements', 'DELETE');
  }

  /**
   * Change le nom et/ou les notes d'un measurement
   */
  async update(id, { title, notes }) {
    const body = {};
    if (title === undefined && notes === undefined) {
      throw new Error('title or notes is required');
    }
    if (title !== undefined) body.title = title;
    if (notes !== undefined) body.notes = notes;
    return this.request(`/measurements/${id}`, 'PUT', body);
  }

  /**
   * Récupère la réponse en fréquence
   * Règle: Les données log-spaced utilisent PPO, automatiquement lissées à PPO/2
   * @param {string} id - UUID ou index
   * @param {object} options - { unit: 'SPL'|'dBFS'|..., smoothing: '1/12'|..., ppo: 96 }
   */
  async getFrequencyResponse(id, options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.smoothing) params.append('smoothing', options.smoothing);
    if (options.ppo) params.append('ppo', options.ppo);

    const query = params.toString();
    const data = await this.request(
      `/measurements/${id}/frequency-response${query ? '?' + query : ''}`
    );

    const magnitudeArray = RewApi.decodeBase64ToFloat32(data.magnitude);

    const freqs = this.generateFrequencyArray(
      magnitudeArray.length,
      data.startFreq,
      data.freqStep,
      data.ppo
    );

    // Décode les données Base64 en tableaux float32
    return {
      ...data,
      freqs,
      endFreq: freqs.at(-1) ?? 0,
      magnitude: magnitudeArray,
      phase: data.phase ? RewApi.decodeBase64ToFloat32(data.phase) : null,
    };
  }

  /**
   * Gets the frequency response
   * of the target for the measurement at index id or with UUID id,
   * index starts from 1
   * GET /measurements/{id}/target-response
   */
  async getTargetResponse(id, options = {}) {
    if (!id) {
      throw new Error('id is required');
    }
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.ppo) params.append('ppo', options.ppo);

    const query = params.toString();
    const data = await this.request(
      `/measurements/${id}/target-response${query ? '?' + query : ''}`
    );

    const magnitudeArray = RewApi.decodeBase64ToFloat32(data.magnitude);

    const freqs = this.generateFrequencyArray(
      magnitudeArray.length,
      data.startFreq,
      data.freqStep,
      data.ppo
    );

    return {
      ...data,
      freqs,
      endFreq: freqs.at(-1) ?? 0,
      magnitude: magnitudeArray,
    };
  }

  /**
   * Récupère le group delay
   */
  async getGroupDelay(id, options = {}) {
    const params = new URLSearchParams();
    if (options.smoothing) params.append('smoothing', options.smoothing);
    if (options.ppo) params.append('ppo', options.ppo);

    const query = params.toString();
    const data = await this.request(
      `/measurements/${id}/group-delay${query ? '?' + query : ''}`
    );

    return {
      ...data,
      delayArray: RewApi.decodeBase64ToFloat32(data.magnitude),
    };
  }

  /**
   * Récupère la réponse impulsionnelle
   *
   * repsonse example
   * {
   *   "unit": "dBFS",
   *   "startTime": -0.03053968516398206,
   *   "sampleInterval": 0.000020833333333333333,
   *   "sampleRate": 48000,
   *   "timingReference": "Acoustic reference",
   *   "timingRefTime": -0.01318170882936498,
   *   "timingOffset": 0,
   *   "delay": 0.01015496119789816,
   *   "data": ...
   * }
   * @param {object} options - { unit: 'Percent'|'dBFS'|..., windowed: true|false, normalised: true|false }
   */
  async getImpulseResponse(id, options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.windowed !== undefined) params.append('windowed', options.windowed);
    if (options.normalised !== undefined) params.append('normalised', options.normalised);
    if (options.samplerate) params.append('samplerate', options.samplerate);

    const query = params.toString();
    const data = await this.request(
      `/measurements/${id}/impulse-response${query ? '?' + query : ''}`
    );

    return {
      ...data,
      dataArray: RewApi.decodeBase64ToFloat32(data.data),
    };
  }

  /**
   * Gets the filters impulse response for the measurement at index id or with UUID id, index starts from 1
   * GET /measurements/{id}/filters-impulse-response
   */
  async getFiltersImpulseResponse(id, options = {}) {
    const params = new URLSearchParams();
    params.append('length', options.length);
    params.append('samplerate', options.samplerate);

    const query = params.toString();
    const data = await this.request(
      `/measurements/${id}/filters-impulse-response${query ? '?' + query : ''}`
    );

    return {
      ...data,
      dataArray: RewApi.decodeBase64ToFloat32(data.data),
    };
  }

  /**
   * Gets the predicted impulse response for
   * the equalised measurement at index id or with UUID id,
   * index starts from 1
   * GET /measurements/{id}/eq/impulse-response
   */
  async getPredictedImpulseResponse(id, options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.windowed !== undefined) params.append('windowed', options.windowed);
    if (options.normalised !== undefined) params.append('normalised', options.normalised);
    if (options.samplerate) params.append('samplerate', options.samplerate);

    const query = params.toString();
    const data = await this.request(
      `/measurements/${id}/eq/impulse-response${query ? '?' + query : ''}`
    );

    return {
      ...data,
      dataArray: RewApi.decodeBase64ToFloat32(data.data),
    };
  }

  /**
   * equaliser
   */
  async getEqualiser(id) {
    return this.request(`/measurements/${id}/equaliser`);
  }

  /**
   * Modifie les paramètres de equaliser
   */
  async setEqualiser(id, equaliser) {
    if (!equaliser || typeof equaliser !== 'object') {
      throw new Error('Invalid equaliser settings');
    }
    return this.request(`/measurements/${id}/equaliser`, 'POST', equaliser);
  }

  /**
   * Récupère les paramètres de fenêtrage IR
   */
  async getIRWindows(id) {
    return this.request(`/measurements/${id}/ir-windows`);
  }

  /**
   * Modifie les paramètres de fenêtrage IR
   */
  async setIRWindows(id, windows) {
    return this.request(`/measurements/${id}/ir-windows`, 'PUT', windows);
  }
  /**
   * room-curve-settings
   */
  async getRoomCurveSettings(id) {
    return this.request(`/measurements/${id}/room-curve-settings`);
  }

  /**
   * Modifie les paramètres de room curve
   * example:
   * {
   *   "addRoomCurve": false,
   *   "lowFreqRiseStartHz": 200,
   *   "lowFreqRiseEndHz": 20,
   *   "lowFreqRiseSlopedBPerOctave": 1,
   *   "highFreqFallStartHz": 1000,
   *   "highFreqFallSlopedBPerOctave": 0.5
   * }
   */
  async setRoomCurveSettings(id, settings) {
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid room curve settings');
    }

    if (typeof settings.addRoomCurve !== 'boolean') {
      throw new TypeError('Invalid addRoomCurve value');
    }
    return this.request(`/measurements/${id}/room-curve-settings`, 'PUT', settings);
  }

  /**
   * reset-room-curve-settings
   */
  async resetRoomCurveSettings(id) {
    return this.request(`/measurements/${id}/room-curve-settings`, 'PUT', {
      addRoomCurve: false,
    });
  }

  /**
   * Get the target level in dB SPL for the measurement at index id or with UUID id, index starts from 1
   * GET /target-level
   */
  async getTargetLevel(id) {
    return this.request(`/measurements/${id}/target-level`);
  }
  /**
   * Set the target level in dB SPL for the measurement at index id or with UUID id, index starts from 1
   * PUT /target-level
   */
  async setTargetLevel(id, level) {
    if (typeof level !== 'number') {
      throw new TypeError('Invalid target level');
    }
    return this.request(`/measurements/${id}/target-level`, 'POST', level);
  }

  /**
   * target-settings
   *
   * example:
   *
   * {
   *  "shape": "None",
   *  "bassManagementSlopedBPerOctave": 24,
   *  "bassManagementCutoffHz": 80,
   *  "lowFreqSlopedBPerOctave": 24,
   *  "lowFreqCutoffHz": 10,
   *  "lowPassCrossoverType": "None",
   *  "highPassCrossoverType": "BU2",
   *  "lowPassCutoffHz": 1000,
   *  "highPassCutoffHz": 20
   *}
   *
   */
  async getTargetSettings(id) {
    return this.request(`/measurements/${id}/target-settings`);
  }

  /**
   * Change some target settings
   * for the measurement at index id or with UUID id,
   * index starts from 1
   */
  async setTargetSettings(id, someSettings) {
    if (!someSettings || typeof someSettings !== 'object') {
      throw new Error('Invalid target settings');
    }
    return this.request(`/measurements/${id}/target-settings`, 'PUT', someSettings);
  }

  /**
   *
   * Change the target settings
   * for the measurement at index id or with UUID id,
   * index starts from 1
   * POST
   */
  async postTargetSettings(id, settings) {
    if (!settings || typeof settings !== 'object') {
      throw new Error('Invalid target settings');
    }
    return this.request(`/measurements/${id}/target-settings`, 'POST', settings);
  }

  /**
   * reset-target-settings
   */
  async resetTargetSettings(id) {
    const defaultSettings = { shape: 'None' };
    const commandResult = await this.getTargetSettings(id);

    // compare commandResult with defaultSettings
    if (commandResult.shape !== defaultSettings.shape) {
      await this.postTargetSettings(id, defaultSettings);
    }
  }

  /**
   * Get the filters for the measurement at index id or with UUID id, index starts from 1
   * GET /filters
   *
   */
  async getFilters(id) {
    return this.request(`/measurements/${id}/filters`);
  }

  /**
   * Change the filters for the measurement at index id or with UUID id, index starts from 1
   * PUT /filters
   *
   */
  async setFilters(id, filters) {
    if (!filters || typeof filters !== 'object') {
      throw new Error('Invalid filters');
    }
    return this.request(`/measurements/${id}/filters`, 'PUT', filters);
  }

  /**
   * Change the filters for the measurement at index id or with UUID id, index starts from 1
   * POST /filters
   */
  async postFilters(id, filters) {
    if (!filters || typeof filters !== 'object') {
      throw new Error('Invalid filters');
    }
    return this.request(`/measurements/${id}/filters`, 'POST', filters);
  }

  /**
   * Récupère les données de distorsion
   * @param {object} options - { unit: 'percent'|'dBr'|..., ppo: 12 }
   */
  async getDistortion(id, options = {}) {
    const params = new URLSearchParams();
    if (options.unit) params.append('unit', options.unit);
    if (options.ppo) params.append('ppo', options.ppo);

    const query = params.toString();
    return this.request(`/measurements/${id}/distortion${query ? '?' + query : ''}`);
  }

  /**
   * Get the list of commands for an individual measurement
   *
   * example response:
   *
   * [
   *   "Save",
   *   "Minimum phase version",
   *   "Excess phase version",
   *   "Mic in box correction",
   *   "Response copy",
   *   "Response magnitude copy",
   *   "Merge cal data to IR",
   *   "Trim IR to windows",
   *   "Smooth",
   *   "Generate waterfall",
   *   "Generate equalised waterfall",
   *   "Generate spectrogram",
   *   "Generate equalised spectrogram",
   *   "Estimate IR delay",
   *   "Offset t=0",
   *   "Add SPL offset",
   *   "Generate RT60",
   *   "Invert",
   *   "Wrap phase",
   *   "Unwrap phase",
   *   "Generate minimum phase"
   * ]
   *
   * @param {*} id
   * @returns
   */
  async getMeasurementCommands(id) {
    if (this.measurementCommands === null) {
      this.measurementCommands = await this.request(`/measurements/${id}/commands`);
    }
    return this.measurementCommands;
  }

  /**
   * Exécute une commande sur un measurement
   * Commandes: Save, Smooth, Generate waterfall, Generate spectrogram, etc.
   * Règle: Les chemins de fichiers doivent échapper les backslashes (\\) ou utiliser /
   */
  async executeCommand(id, command, parameters = {}, resultUrl = null) {
    const body = { command, parameters };
    if (resultUrl) body.resultUrl = resultUrl;
    return this.request(`/measurements/${id}/command`, 'POST', body);
  }

  /**
   * Sauvegarde un measurement
   * Règle: Échapper les backslashes dans les chemins
   */
  async save(id, filename) {
    return this.executeCommand(id, 'Save', { filename });
  }

  /**
   * Mic in box correction
   * Règle: Utiliser des chemins avec des / ou échapper les backslashes
   */
  async micInBoxCorrection(id, calFilePath) {
    return this.executeCommand(id, 'Mic in box correction', { calFilePath });
  }
  /**
   * Merge cal data to IR
   * Règle: Utiliser des chemins avec des / ou échapper les backslashes
   */
  async mergeCalDataToIR(id, calFilePath) {
    return this.executeCommand(id, 'Merge cal data to IR', { calFilePath });
  }
  /**
   * Lisse un measurement
   */
  async smooth(id, smoothing) {
    return this.executeCommand(id, 'Smooth', { smoothing });
  }

  /**
   * Génère un waterfall
   */
  async generateWaterfall(id, config) {
    return this.executeCommand(id, 'Generate waterfall', config);
  }

  /**
   * Genère un equalised waterfall
   * Règle: Nécessite que l'equaliser soit configuré
   */
  async generateEqualisedWaterfall(id, config) {
    return this.executeCommand(id, 'Generate equalised waterfall', config);
  }

  /**
   * Génère un spectrogramme
   */
  async generateSpectrogram(id, config) {
    return this.executeCommand(id, 'Generate spectrogram', config);
  }
  /**
   * Génère un equalised spectrogramme
   * Règle: Nécessite que l'equaliser soit configuré
   */
  async generateEqualisedSpectrogram(id, config) {
    return this.executeCommand(id, 'Generate equalised spectrogram', config);
  }
  /**
   * Estimate IR delay
   */
  async estimateIRDelay(id, options) {
    return this.executeCommand(id, 'Estimate IR delay', options);
  }

  /**
   * Offset t=0
   */
  async offsetTZero(id, offset, unit = 'seconds') {
    return this.executeCommand(id, 'Offset t=0', { offset, unit });
  }

  /**
   * Ajoute un offset SPL
   */
  async addSPLOffset(id, offset) {
    return this.executeCommand(id, 'Add SPL offset', { offset });
  }

  /**
   * Génère RT60
   */
  async generateRT60(id, options) {
    return this.executeCommand(id, 'Generate RT60', options);
  }

  /**
   * Inverse
   * */
  async invert(id) {
    return this.executeCommand(id, 'Invert');
  }

  /**
   * Inverse phase
   */
  async invertPhase(id) {
    return this.executeCommand(id, 'Invert phase');
  }
  /**
   * Wrap phase
   */
  async wrapPhase(id, frequency) {
    return this.executeCommand(id, 'Wrap phase', { frequency });
  }

  /**
   * Unwrap phase
   */
  async unwrapPhase(id, frequency) {
    return this.executeCommand(id, 'Unwrap phase', { frequency });
  }

  /**
   * Trim IR to windows
   * options: { preDelayMs: number, postDelayMs: number }
   * Règle: Les délais sont en ms
   * */
  async trimIRToWindows(id, options) {
    return this.executeCommand(id, 'Trim IR to windows', options);
  }

  /**
   * Minimum phase version
   * Règle: Crée un nouveau measurement
   * */
  async minimumPhaseVersion(id, parameters) {
    return this.executeCommand(id, 'Minimum phase version', parameters);
  }
  /**
   * Excess phase version
   * Règle: Crée un nouveau measurement
   * */
  async excessPhaseVersion(id, parameters) {
    return this.executeCommand(id, 'Excess phase version', parameters);
  }
  /**
   * Response copy
   * Règle: Crée un nouveau measurement
   * */
  async responseCopy(id) {
    return this.executeCommand(id, 'Response copy');
  }
  /**
   * Response magnitude copy
   * Règle: Crée un nouveau measurement
   * */
  async responseMagnitudeCopy(id) {
    return this.executeCommand(id, 'Response magnitude copy');
  }

  /**
   * Génère une version minimum phase
   */
  async generateMinimumPhase(id, options) {
    return this.executeCommand(id, 'Generate minimum phase', options);
  }

  /**
   * Récupère les résultats RT60
   */
  async getRT60(id, octaveFrac = 1) {
    return this.request(`/measurements/${id}/rt60?octaveFrac=${octaveFrac}`);
  }

  /**
   * Get the list of EQ commands
   * GET /measurements/eq/commands
   *
   * example response:
   * [
   *  "Calculate target level",
   *  "Match target",
   *  "Optimise gains",
   *  "Optimise gains and Qs",
   *  "Optimise gains, Qs and Fcs",
   *  "Generate predicted measurement",
   *  "Generate filters measurement",
   *  "Generate target measurement"
   *]
   *
   */
  async getEQCommands() {
    return this.request('/measurements/eq/commands');
  }

  /**
   * Send an EQ command for the measurement at index id or with UUID id, index starts from 1
   * @param {*} id
   * @param {*} command
   * @param {*} parameters
   * @param {*} resultUrl
   * @returns
   */
  async executeEQCommand(id, command, parameters = null, resultUrl = null) {
    const body = { command };
    if (parameters) body.parameters = parameters;
    if (resultUrl) body.resultUrl = resultUrl;
    return this.request(`/measurements/${id}/eq/command`, 'POST', body);
  }

  async calculateTargetLevel(id) {
    return this.executeEQCommand(id, 'Calculate target level');
  }

  async matchTarget(id) {
    return this.executeEQCommand(id, 'Match target');
  }

  async optimiseGains(id) {
    return this.executeEQCommand(id, 'Optimise gains');
  }

  async optimiseGainsAndQs(id) {
    return this.executeEQCommand(id, 'Optimise gains and Qs');
  }

  async optimiseGainsQsAndFcs(id) {
    return this.executeEQCommand(id, 'Optimise gains, Qs and Fcs');
  }

  async generatePredictedMeasurement(id) {
    return this.executeEQCommand(id, 'Generate predicted measurement');
  }

  async generateFiltersMeasurement(id) {
    return this.executeEQCommand(id, 'Generate filters measurement');
  }

  async generateTargetMeasurement(id) {
    return this.executeEQCommand(id, 'Generate target measurement');
  }

  /**
   *
   * @returns the list of process commands
   * 
   * GET /measurements/process-commands
   * example response:
   * [
   *  "Align SPL",
   *  "Time align",
   *  "Align IR start",
   *  "Cross corr align",
   *  "Vector average",
   *  "RMS average",
   *  "dB average",
   *  "Magn plus phase average",
   *  "dB plus phase average",
   *  "Vector sum",
   *  "Smooth",
   *  "Arithmetic",
   *  "Remove IR delays"
]
   */
  async getProcessCommands() {
    return this.request('/measurements/process-commands');
  }

  /**
   * Traite plusieurs measurements
   * Règle: Utiliser UUID dans measurementUUIDs plutôt que measurementIndices
   */
  async processMeasurements(
    processName,
    measurementUUIDs,
    parameters = {},
    resultUrl = null
  ) {
    if (!Array.isArray(measurementUUIDs) || measurementUUIDs.length === 0) {
      throw new Error('measurementUUIDs must be a non-empty array');
    }
    const body = {
      processName,
      measurementUUIDs,
      parameters,
    };
    if (resultUrl) body.resultUrl = resultUrl;
    return this.request('/measurements/process-measurements', 'POST', body);
  }

  /**
   * Aligne le SPL de plusieurs measurements
   */
  async alignSPL(measurementUUIDs, targetdB, frequencyHz = 1000, spanOctaves = 2) {
    return this.processMeasurements('Align SPL', measurementUUIDs, {
      targetdB: String(targetdB),
      frequencyHz: String(frequencyHz),
      spanOctaves,
    });
  }

  /**
   * Aligne temporellement plusieurs measurements
   */
  async timeAlign(measurementUUIDs) {
    return this.processMeasurements('Time align', measurementUUIDs);
  }

  /**
   * Aligne le début de l'IR de plusieurs measurements
   */
  async alignIRStart(measurementUUIDs) {
    return this.processMeasurements('Align IR start', measurementUUIDs);
  }

  /**
   * Aligne par corrélation croisée plusieurs measurements
   */
  async crossCorrAlign(measurementUUIDs) {
    return this.processMeasurements('Cross corr align', measurementUUIDs);
  }

  /**
   * Smooth plusieurs measurements
   */
  async smoothMeasurements(measurementUUIDs, smoothing) {
    return this.processMeasurements('Smooth', measurementUUIDs, { smoothing });
  }

  /**
   * remove smoothing
   *
   */
  async removeSmoothing(measurementUUIDs) {
    return this.smoothMeasurements(measurementUUIDs, 'None');
  }
  /**
   * Aligne par corrélation croisée plusieurs measurements
   */
  async removeIRDelays(measurementUUIDs) {
    return this.processMeasurements('Remove IR delays', measurementUUIDs);
  }
  /**
   * Moyenne vectorielle
   */
  async vectorAverage(measurementUUIDs) {
    return this.processMeasurements('Vector average', measurementUUIDs);
  }

  /**
   * Moyenne RMS
   */
  async rmsAverage(measurementUUIDs) {
    return this.processMeasurements('RMS average', measurementUUIDs);
  }

  /**
   * Moyenne dB
   */
  async dbAverage(measurementUUIDs) {
    return this.processMeasurements('dB average', measurementUUIDs);
  }

  /**
   * Moyenne dB + phase
   */
  async dbPlusPhaseAverage(measurementUUIDs) {
    return this.processMeasurements('dB plus phase average', measurementUUIDs);
  }

  /**
   * Somme vectorielle
   */
  async vectorSum(measurementUUIDs) {
    return this.processMeasurements('Vector sum', measurementUUIDs);
  }

  /**
   * Arithmétique sur deux measurements (A et B)
   */
  async arithmetic(measurementUUIDs, func, options = {}) {
    if (!Array.isArray(measurementUUIDs) || measurementUUIDs.length < 2) {
      throw new Error('measurementUUIDs must be an array of at least two UUIDs');
    }
    const params = { function: func };
    for (const key of Object.keys(options)) {
      if (options[key] !== null) params[key] = options[key];
    }
    return this.processMeasurements('Arithmetic', measurementUUIDs, params);
  }

  /**
   * A + B
   */
  async arithmeticAPlusB(measurementAUUID, measurementBUUID) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'A + B');
  }

  /**
   * A - B
   */
  async arithmeticAMinusB(measurementAUUID, measurementBUUID) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'A - B');
  }

  /**
   * A * B
   */
  async arithmeticATimesB(measurementAUUID, measurementBUUID) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'A * B');
  }

  /**
   * A / B
   */
  async arithmeticADividedByB(
    measurementAUUID,
    measurementBUUID,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'A / B', {
      maxGain,
      lowerLimit,
      upperLimit,
    });
  }

  /**
   * 1 / A
   */
  async arithmeticOneDividedByA(
    measurementAUUID,
    measurementBUUID,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null,
    targetLevel = null,
    autoTarget = false,
    excludeNotches = true
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], '1 / A', {
      maxGain,
      lowerLimit,
      upperLimit,
      targetLevel,
      autoTarget,
      excludeNotches,
    });
  }

  /**
   * 1 / B
   */
  async arithmeticOneDividedByB(
    measurementAUUID,
    measurementBUUID,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null,
    targetLevel = null,
    autoTarget = false,
    excludeNotches = true
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], '1 / B', {
      maxGain,
      lowerLimit,
      upperLimit,
      targetLevel,
      autoTarget,
      excludeNotches,
    });
  }

  /**
   * 1 / |A|
   */
  async arithmeticOneDividedByAbsA(
    measurementAUUID,
    measurementBUUID,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null,
    targetLevel = null,
    autoTarget = false,
    excludeNotches = true
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], '1 / |A|', {
      maxGain,
      lowerLimit,
      upperLimit,
      targetLevel,
      autoTarget,
      excludeNotches,
    });
  }

  /**
   * 1 / |B|
   */
  async arithmeticOneDividedByAbsB(
    measurementAUUID,
    measurementBUUID,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null,
    targetLevel = null,
    autoTarget = false,
    excludeNotches = true
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], '1 / |B|', {
      maxGain,
      lowerLimit,
      upperLimit,
      targetLevel,
      autoTarget,
      excludeNotches,
    });
  }

  /**
   * A * B conjugate
   */
  async arithmeticATimesBConjugate(measurementAUUID, measurementBUUID) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'A * B conjugate');
  }

  /**
   * |A| / |B|
   */
  async arithmeticAbsADividedByAbsB(
    measurementAUUID,
    measurementBUUID,
    maxGain = null,
    lowerLimit = null,
    upperLimit = null
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], '|A| / |B|', {
      maxGain,
      lowerLimit,
      upperLimit,
    });
  }

  /**
   * (A + B) / 2
   */
  async arithmeticAPlusBDividedBy2(measurementAUUID, measurementBUUID) {
    return this.arithmetic([measurementAUUID, measurementBUUID], '(A + B) / 2');
  }

  /**
   * Merge B to A
   */
  async arithmeticMergeBToA(
    measurementAUUID,
    measurementBUUID,
    frequencyHz = 200,
    blend = false
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'Merge B to A', {
      frequencyHz: String(frequencyHz),
      blend,
    });
  }

  /**
   * Invert A phase
   */
  async arithmeticInvertAPhase(
    measurementAUUID,
    measurementBUUID,
    lowerLimit = null,
    upperLimit = null
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'Invert A phase', {
      lowerLimit,
      upperLimit,
    });
  }

  /**
   * Invert B phase
   */
  async arithmeticInvertBPhase(
    measurementAUUID,
    measurementBUUID,
    lowerLimit = null,
    upperLimit = null
  ) {
    return this.arithmetic([measurementAUUID, measurementBUUID], 'Invert B phase', {
      lowerLimit,
      upperLimit,
    });
  }

  /**
   * Commandes globales sur les measurements
   */
  async executeGlobalCommand(command, parameters = []) {
    return this.request('/measurements/command', 'POST', { command, parameters });
  }

  /**
   * Charge des fichiers measurements
   * Règle: Échapper les backslashes ou utiliser /
   */
  async load(filenames) {
    return this.executeGlobalCommand('Load', filenames);
  }

  /**
   * Sauvegarde tous les measurements
   */
  async saveAll(filename, note = '') {
    return this.executeGlobalCommand('Save all', [filename, note]);
  }

  /**
   * Trie les measurements alphabétiquement
   */
  async sortAlphabetically() {
    return this.executeGlobalCommand('Sort alphabetically');
  }

  /**
   * Crée un measurement Dirac
   */
  async createDirac(sampleRate, numSamples, peakIndex) {
    return this.executeGlobalCommand('Dirac', [
      String(sampleRate),
      String(numSamples),
      String(peakIndex),
    ]);
  }

  /**
   * Récupère les unités disponibles
   */
  async getFrequencyResponseUnits() {
    return this.request('/measurements/frequency-response/units');
  }

  async getImpulseResponseUnits() {
    return this.request('/measurements/impulse-response/units');
  }

  async getSmoothingChoices() {
    return this.request('/measurements/frequency-response/smoothing-choices');
  }

  async getDistortionUnits() {
    return this.request('/measurements/distortion-units');
  }

  async getDistortionPPOChoices() {
    return this.request('/measurements/distortion-ppo-choices');
  }

  /**
   *
   * example response:
   * [
   *   "A + B",
   *   "A - B",
   *   "A * B",
   *   "A * B conjugate",
   *   "A / B",
   *   "|A| / |B|",
   *   "(A + B) / 2",
   *   "Merge B to A",
   *   "1 / A",
   *   "1 / B",
   *   "1 / |A|",
   *   "1 / |B|",
   *   "Invert A phase",
   *   "Invert B phase"
   * ]
   *
   * @returns  list of functions for the Arithmetic process command
   */
  async getArithmeticFunctions() {
    if (this.arithmeticFunctions === null) {
      this.arithmeticFunctions = await this.request('/measurements/arithmetic-functions');
    }
    return this.arithmeticFunctions;
  }

  /**
   * Souscrit aux changements de measurements
   */
  async subscribe(url) {
    return this.request('/measurements/subscribe', 'POST', { url });
  }

  /**
   * Se désinscrit des changements
   */
  async unsubscribe(url) {
    return this.request('/measurements/unsubscribe', 'POST', { url });
  }

  /**
   * Récupère la liste des souscripteurs
   */
  async getSubscribers() {
    return this.request('/measurements/subscribers');
  }
}

export default REWMeasurements;
