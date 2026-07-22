/**
 * Bridge session service (RCH 2.0).
 *
 * [ORCHESTRATION] service owning the RCH Bridge connection lifecycle:
 * health polling, AVR registration state, the reachability probe feeding the
 * live AVR data synthesis, and the annex AVR actions (zone power, presets,
 * bridge reset/shutdown). No Knockout, no DOM — mirror of rew-session.js.
 *
 * Injected dependencies:
 * - `state`: accessor object over the app state (getters/setters) —
 *   bridgeConnected (rw), bridgeVersion (w), avrRegistered (rw), avrIp (w),
 *   avrModelName (rw), avrReachable (rw), avrBusyReason (rw),
 *   bridgeBaseUrl (r), discoveredAvrs (w), avrPreset (w),
 *   avrPresetSupported (w).
 * - `createApi(baseUrl)`: BridgeApi factory.
 * - hooks: `onConnected` (after the initial handshake), `onAvrDataAvailable`
 *   ({info, status, ip, model} — live synthesis input), `onError` (UI error
 *   channel, reserved for connection failures; probe failures are chain
 *   state, not errors).
 *
 * BUSY semantics: the bridge answers `409 {error:"BUSY", reason}` on
 * AVR-bound endpoints while a measurement or transfer holds the AVR. That is
 * a healthy, busy connection — never a failure. Errors are duck-typed on the
 * envelope contract (`error.code === 'BUSY'`) to keep this service decoupled
 * from the api class.
 */

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const isBusyError = error => error?.code === 'BUSY';

class BridgeSession {
  constructor({
    state,
    createApi,
    onConnected = async () => {},
    onAvrDataAvailable = async () => {},
    onError = () => {},
    pollingInterval = 2000,
    log = noopLog,
  }) {
    this.state = state;
    this.createApi = createApi;
    this.onConnected = onConnected;
    this.onAvrDataAvailable = onAvrDataAvailable;
    this.onError = onError;
    this.pollingInterval = pollingInterval;
    this.log = log;

    this.api = null;
    this.pollerId = null;
    this.pollBusy = false;
    this.pollFailures = 0;
  }

  // Tolerated consecutive poll failures before declaring the bridge lost —
  // a single tick can time out behind a long in-page computation.
  static POLL_FAILURE_LIMIT = 3;

  // --- Connection lifecycle ----------------------------------------------

  async connect() {
    if (this.state.bridgeConnected) return;

    this.log.info('Connecting to RCH Bridge...');
    try {
      this.api = this.createApi(this.state.bridgeBaseUrl);
      this.state.bridgeVersion = await this.api.checkVersion();
      this.state.bridgeConnected = true;
      await this.refreshAvrRegistration();
      if (this.state.avrRegistered) {
        if (!this.state.avrModelName) {
          await this.resolveModelFromDiscovery();
        }
        await this.probeAvr();
      }
      this.pollerId = setInterval(() => this.pollTick(), this.pollingInterval);
      await this.onConnected();
    } catch (error) {
      this.disconnect();
      this.onError(error.message, error);
    }
  }

  disconnect() {
    this.state.bridgeConnected = false;
    if (this.pollerId) {
      clearInterval(this.pollerId);
      this.pollerId = null;
    }
    this.api = null;
    this.pollFailures = 0;
  }

  async toggleConnection() {
    if (this.state.bridgeConnected) {
      this.disconnect();
    } else {
      await this.connect();
    }
  }

  // Lightweight liveness poll: /health + /avr/current only. Never
  // /avr/status — each status call is a TCP round-trip to the amplifier and
  // is refused (BUSY) during measurements/transfers. Suspended while the app
  // is processing (like the REW poller) so it never competes with heavy work.
  async pollTick() {
    if (this.pollBusy || !this.state.bridgeConnected || !this.api) return;
    if (this.state.isProcessing) return;
    this.pollBusy = true;
    try {
      await this.api.health();
      await this.refreshAvrRegistration();
      this.pollFailures = 0;
    } catch (error) {
      this.pollFailures += 1;
      if (this.pollFailures >= BridgeSession.POLL_FAILURE_LIMIT) {
        this.disconnect();
        this.onError(`Bridge polling failed: ${error.message}`, error);
      } else {
        this.log.warn(
          `Bridge poll failed (${this.pollFailures}/${BridgeSession.POLL_FAILURE_LIMIT}): ${error.message}`,
        );
      }
    } finally {
      this.pollBusy = false;
    }
  }

  async refreshAvrRegistration() {
    const current = await this.api.getCurrentAvr();
    const registered = Boolean(current?.registered);
    this.state.avrRegistered = registered;
    this.state.avrIp = current?.ip ?? '';
    if (!registered) {
      this.state.avrReachable = null;
      this.state.avrBusyReason = '';
    }
    return current;
  }

  // --- AVR probe (chain state, never throws) ------------------------------

  /**
   * Fetches /avr/info + /avr/status from the registered AVR and feeds the
   * live-synthesis hook. Failures are reflected in `avrReachable` /
   * `avrBusyReason` (operational-chain state) instead of the error channel.
   * @returns {Promise<boolean>} true when fresh AVR data was delivered
   */
  async probeAvr() {
    if (!this.state.bridgeConnected || !this.state.avrRegistered || !this.api) {
      return false;
    }
    try {
      const { info } = await this.api.getAvrInfo();
      const { status } = await this.api.getAvrStatus();
      this.state.avrReachable = true;
      this.state.avrBusyReason = '';
      await this.refreshPreset();
      await this.onAvrDataAvailable({
        info,
        status,
        ip: this.state.avrIp,
        model: this.state.avrModelName,
      });
      return true;
    } catch (error) {
      if (isBusyError(error)) {
        // The AVR is held by a measurement or transfer: connection is healthy.
        this.state.avrReachable = true;
        this.state.avrBusyReason = error.reason || 'busy';
        return false;
      }
      this.state.avrReachable = false;
      this.log.warn(`AVR probe failed: ${error.message}`);
      return false;
    }
  }

  // --- AVR registration ----------------------------------------------------

  async registerAvr(ip, model = null) {
    this.assertConnected();
    await this.api.registerAvr(ip, model || null);
    this.state.avrRegistered = true;
    this.state.avrIp = ip;
    if (model) {
      this.state.avrModelName = model;
    } else {
      // The model is never typed by the user: forget any previous value (it
      // may belong to another AVR) and resolve it from the API (SSDP scan
      // matched by the registered IP).
      this.state.avrModelName = '';
      await this.resolveModelFromDiscovery();
    }
    await this.probeAvr();
  }

  async unregisterAvr() {
    this.assertConnected();
    await this.api.unregisterAvr();
    this.state.avrRegistered = false;
    this.state.avrIp = '';
    this.state.avrModelName = '';
    this.state.avrReachable = null;
    this.state.avrBusyReason = '';
    this.state.avrPreset = null;
    this.state.avrPresetSupported = null;
  }

  async discover() {
    this.assertConnected();
    const { avrs } = await this.api.discoverAvrs();
    this.state.discoveredAvrs = avrs ?? [];
    return this.state.discoveredAvrs;
  }

  // The bridge only persists the registered IP, not the model name — when a
  // pre-registered AVR comes back at connect time, try to resolve its model
  // by matching the IP against an SSDP scan (the model drives the
  // AvrCaracteristics tables of the live synthesis).
  async resolveModelFromDiscovery() {
    try {
      const avrs = await this.discover();
      const match = avrs.find(avr => avr.ip === this.state.avrIp);
      const modelName = match?.model ?? match?.name;
      if (modelName) {
        this.state.avrModelName = modelName;
        this.log.info(`AVR model resolved by discovery: ${modelName}`);
        return true;
      }
    } catch (error) {
      this.log.warn(`AVR model discovery failed: ${error.message}`);
    }
    return false;
  }

  // --- Annex AVR / bridge actions ------------------------------------------

  async getZoneMain() {
    this.assertConnected();
    return this.api.getZoneMain();
  }

  async setZoneMain(stateValue) {
    this.assertConnected();
    const result = await this.api.setZoneMain(stateValue);
    if (stateValue === 'on') {
      // The amp just woke up: refresh the live AVR data.
      await this.probeAvr();
    }
    return result;
  }

  async getPreset() {
    this.assertConnected();
    return this.api.getPreset();
  }

  // Reads the active speaker preset into the state — called at probe time,
  // never polled (each call is a telnet round-trip to the AVR). Failures are
  // tolerated: the last known preset state is kept.
  async refreshPreset() {
    try {
      const result = await this.api.getPreset();
      this.applyPresetResult(result, null);
    } catch (error) {
      if (!isBusyError(error)) {
        this.log.warn(`Speaker preset read failed: ${error.message}`);
      }
    }
  }

  async setPreset(preset) {
    this.assertConnected();
    const result = await this.api.setPreset(preset);
    this.applyPresetResult(result, preset);
    return result;
  }

  applyPresetResult(result, requestedPreset) {
    if (result?.supported === false) {
      this.state.avrPresetSupported = false;
      this.state.avrPreset = null;
      return;
    }
    this.state.avrPresetSupported = true;
    this.state.avrPreset = result?.preset ?? requestedPreset ?? null;
  }

  async resetBridge() {
    this.assertConnected();
    return this.api.resetBridge();
  }

  async shutdownBridge() {
    this.assertConnected();
    const result = await this.api.shutdown();
    this.disconnect();
    return result;
  }

  assertConnected() {
    if (!this.state.bridgeConnected || !this.api) {
      throw new Error('Please connect to the RCH Bridge first');
    }
  }
}

function createBridgeSession(deps) {
  return new BridgeSession(deps);
}

export { BridgeSession, createBridgeSession };
