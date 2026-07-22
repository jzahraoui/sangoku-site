/**
 * RCH Bridge Client
 * Facade HTTP du micro-serveur local rch-bridge (pilotage AVR Denon/Marantz :
 * enregistrement, telnet, transfert de calibration, mesure Audyssey).
 * Contrat d'erreur du bridge : enveloppe JSON {error, message?, reason?, details?},
 * jamais vehiculee dans une reponse 200 (docs bridge error-codes.md).
 */
import { transportMethods, transportStatics } from '../rew/rew-transport.js';

const AVR_REGISTER_PATH = '/avr/register';
const ZONEMAIN_PATH = '/avr/zonemain';
const PRESET_PATH = '/avr/preset';
const TRANSFER_PATH = '/transfer';
const MEASURE_SESSION_PATH = '/measure/session';
const SUBLEVEL_PATH = '/measure/sublevel';

/**
 * Erreur typee du bridge : porte le statut HTTP et l'enveloppe
 * {error, reason, details} renvoyee par le serveur quand elle existe.
 * `code` vaut null pour les echecs purement client (reseau, timeout local).
 */
class BridgeApiError extends Error {
  constructor(
    message,
    { status = 0, code = null, reason = null, details = null, cause = null } = {},
  ) {
    super(message, cause ? { cause } : undefined);
    this.name = 'BridgeApiError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.details = details;
  }

  // Verrou d'exclusivite mesure/transfert du bridge : l'AVR est occupe,
  // la connexion reste saine (a ne jamais traiter comme une panne).
  get isBusy() {
    return this.code === 'BUSY';
  }
}

const environmentStatics = {
  isWebKitVendor() {
    return (
      typeof navigator !== 'undefined' && /apple/i.test(navigator.vendor ?? '')
    );
  },

  isChromiumBrowser() {
    return typeof navigator !== 'undefined' && navigator.userAgentData != null;
  },

  isSecurePage() {
    return globalThis.location?.protocol === 'https:';
  },

  // WebKit bloque le mixed content vers localhost sans aucun contournement :
  // depuis une page https, la requete ne part jamais (docs bridge
  // browser-support.md).
  isBlockedWebKitContext() {
    return this.isWebKitVendor() && this.isSecurePage();
  },

  describeNetworkFailure(baseURL) {
    if (this.isBlockedWebKitContext()) {
      return (
        'Safari cannot reach the RCH Bridge from an https page (WebKit blocks ' +
        'requests to localhost). Please use Chrome, Edge or Firefox.'
      );
    }
    const base = `Failed to connect to RCH Bridge at ${baseURL}. Make sure the bridge is running.`;
    if (this.isChromiumBrowser()) {
      return (
        `${base} If the browser asked for a "local network" permission and it was ` +
        'denied, re-enable it from the icon in the address bar (Site settings), ' +
        'then reload the page.'
      );
    }
    return base;
  },
};

const versionStatics = {
  parseSemver(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(
      typeof version === 'string' ? version.trim() : '',
    );
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  },

  compareVersions(left, right) {
    const a = this.parseSemver(left);
    const b = this.parseSemver(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  },
};

class BridgeApi {
  static TIMEOUT_MS = 30000;
  static ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);
  // Version bridge minimale supportee par RCH ; a relever quand le bridge
  // embarque un changement de contrat attendu ici (ex. jeton crossover 70 Hz).
  static MIN_BRIDGE_VERSION = '1.0.0';

  constructor(baseURL = 'http://127.0.0.1:7735') {
    this.setBaseURL(baseURL);
  }

  static isBusy(error) {
    return error instanceof BridgeApiError && error.isBusy;
  }

  static toApiError(response, payload) {
    const envelope = payload && typeof payload === 'object' ? payload : {};
    const code = typeof envelope.error === 'string' ? envelope.error : null;
    const message =
      envelope.message || code || response.statusText || `HTTP ${response.status}`;
    return new BridgeApiError(`[${response.status}] ${message}`, {
      status: response.status,
      code,
      reason: envelope.reason ?? null,
      details: envelope.details ?? null,
    });
  }

  async request(endpoint, method = 'GET', body = null) {
    const ApiClass = this.constructor;
    const methodUpper = ApiClass.normalizeMethod(method);
    const hasBody = ApiClass.hasRequestBody(body);
    const completeUrl = this.getRequestUrl(endpoint);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ApiClass.TIMEOUT_MS);

    const options = {
      method: methodUpper,
      headers: { Accept: 'application/json' },
      // Private Network Access (Chromium) : attribue explicitement la requete
      // au loopback pour declencher la demande de permission « reseau local »
      // (docs bridge browser-support.md) ; option ignoree ailleurs.
      targetAddressSpace: 'loopback',
      signal: controller.signal,
    };
    if (hasBody) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(completeUrl, options);
      const payload =
        response.status === 204 ? {} : await response.json().catch(() => null);

      if (!response.ok) {
        throw ApiClass.toApiError(response, payload);
      }
      if (payload === null) {
        throw new BridgeApiError(`Invalid JSON response from ${endpoint}`, {
          status: response.status,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof BridgeApiError) throw error;
      if (error.name === 'AbortError') {
        throw new BridgeApiError(
          `Request ${endpoint} timeout after ${ApiClass.TIMEOUT_MS / 1000} s`,
          { code: 'TIMEOUT_CLIENT' },
        );
      }
      throw new BridgeApiError(ApiClass.describeNetworkFailure(this.baseURL), {
        code: 'NETWORK',
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // --- Sante / cycle de vie -----------------------------------------------

  health() {
    return this.request('/health');
  }

  /**
   * Verifie la joignabilite ET la version minimale du bridge.
   * @returns {Promise<string>} la version annoncee par /health
   */
  async checkVersion() {
    const ApiClass = this.constructor;
    const health = await this.health();
    const version = typeof health.version === 'string' ? health.version : '';
    const comparison = ApiClass.compareVersions(
      version,
      ApiClass.MIN_BRIDGE_VERSION,
    );
    if (comparison === null || comparison < 0) {
      throw new BridgeApiError(
        `RCH Bridge version ${version || 'unknown'} is not supported: version ` +
          `${ApiClass.MIN_BRIDGE_VERSION} or newer is required. Please download ` +
          'the latest bridge from the Resources page.',
        { code: 'VERSION_TOO_OLD' },
      );
    }
    return version;
  }

  shutdown() {
    return this.request('/shutdown', 'POST');
  }

  resetBridge() {
    return this.request('/reset', 'POST');
  }

  // --- Enregistrement / lecture AVR ---------------------------------------

  registerAvr(ip, model = null) {
    if (!this.constructor.isValidIpAddress(ip)) {
      return Promise.reject(new TypeError(`Invalid AVR IP address: ${ip}`));
    }
    return this.request(AVR_REGISTER_PATH, 'POST', model ? { ip, model } : { ip });
  }

  unregisterAvr() {
    return this.request(AVR_REGISTER_PATH, 'DELETE');
  }

  getCurrentAvr() {
    return this.request('/avr/current');
  }

  getAvrStatus() {
    return this.request('/avr/status');
  }

  getAvrInfo() {
    return this.request('/avr/info');
  }

  discoverAvrs() {
    return this.request('/avr/discover', 'POST');
  }

  // --- Controle telnet (preflight) ----------------------------------------

  getZoneMain() {
    return this.request(ZONEMAIN_PATH);
  }

  setZoneMain(state) {
    return this.request(ZONEMAIN_PATH, 'POST', { state });
  }

  getPreset() {
    return this.request(PRESET_PATH);
  }

  setPreset(preset) {
    return this.request(PRESET_PATH, 'POST', { preset });
  }

  // --- Transfert de calibration -------------------------------------------

  validateCalibration(archive) {
    return this.request('/avr/validate', 'POST', archive);
  }

  startTransfer(archive) {
    return this.request(TRANSFER_PATH, 'POST', archive);
  }

  getTransfer() {
    return this.request(TRANSFER_PATH);
  }

  cancelTransfer() {
    return this.request(TRANSFER_PATH, 'DELETE');
  }

  // --- Mesure Audyssey ----------------------------------------------------

  startMeasureSession(model = null) {
    return this.request(MEASURE_SESSION_PATH, 'POST', model ? { model } : {});
  }

  getMeasureSession() {
    return this.request(MEASURE_SESSION_PATH);
  }

  startMeasurePosition(position, channels = null) {
    return this.request(
      '/measure/position',
      'POST',
      channels ? { position, channels } : { position },
    );
  }

  getMeasureResponse(position, channel, raw = false) {
    const query = new URLSearchParams({
      position: String(position),
      channel,
    });
    if (raw) query.set('raw', 'true');
    return this.request(`/measure/response?${query.toString()}`);
  }

  startSublevel(sub = null) {
    return this.request(SUBLEVEL_PATH, 'POST', sub === null ? {} : { sub });
  }

  getSublevel() {
    return this.request(SUBLEVEL_PATH);
  }

  stopSublevel() {
    return this.request(SUBLEVEL_PATH, 'DELETE');
  }

  completeMeasureSession() {
    return this.request(`${MEASURE_SESSION_PATH}/complete`, 'POST');
  }

  cancelMeasureSession() {
    return this.request(MEASURE_SESSION_PATH, 'DELETE');
  }
}

Object.assign(BridgeApi, transportStatics, environmentStatics, versionStatics);

const { setBaseURL, getRequestUrl } = transportMethods;
Object.assign(BridgeApi.prototype, { setBaseURL, getRequestUrl });

export default BridgeApi;
export { BridgeApiError };
