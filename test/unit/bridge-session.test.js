import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBridgeSession } from '../../src/services/bridge-session.js';

function makeState(overrides = {}) {
  return {
    bridgeConnected: false,
    bridgeVersion: '',
    avrRegistered: false,
    avrIp: '',
    avrModelName: '',
    avrReachable: null,
    avrBusyReason: '',
    bridgeBaseUrl: 'http://127.0.0.1:7735',
    discoveredAvrs: [],
    ...overrides,
  };
}

function makeApi(overrides = {}) {
  return {
    checkVersion: vi.fn().mockResolvedValue('1.0.0'),
    health: vi.fn().mockResolvedValue({ status: 'ready', version: '1.0.0' }),
    getCurrentAvr: vi.fn().mockResolvedValue({ ip: null, registered: false }),
    getAvrInfo: vi.fn().mockResolvedValue({ ip: '10.0.0.2', info: { EQType: 'MultEQXT32' } }),
    getAvrStatus: vi.fn().mockResolvedValue({ ip: '10.0.0.2', status: { ChSetup: [] } }),
    registerAvr: vi.fn().mockResolvedValue({ registered: true }),
    unregisterAvr: vi.fn().mockResolvedValue({ unregistered: true }),
    discoverAvrs: vi.fn().mockResolvedValue({ avrs: [] }),
    getZoneMain: vi.fn().mockResolvedValue({ state: 'on' }),
    setZoneMain: vi.fn().mockResolvedValue({ success: true, state: 'on' }),
    getPreset: vi.fn().mockResolvedValue({ preset: 1, supported: true }),
    setPreset: vi.fn().mockResolvedValue({ supported: true, preset: 1, success: true }),
    resetBridge: vi.fn().mockResolvedValue({ reset: true }),
    shutdown: vi.fn().mockResolvedValue({ status: 'stopping' }),
    ...overrides,
  };
}

function busyError(reason = 'measurement') {
  const error = new Error('[409] AVR busy');
  error.code = 'BUSY';
  error.reason = reason;
  return error;
}

function makeSession({ state = makeState(), api = makeApi(), hooks = {} } = {}) {
  const onConnected = hooks.onConnected ?? vi.fn();
  const onAvrDataAvailable = hooks.onAvrDataAvailable ?? vi.fn();
  const onError = hooks.onError ?? vi.fn();
  const session = createBridgeSession({
    state,
    createApi: vi.fn(() => api),
    onConnected,
    onAvrDataAvailable,
    onError,
    pollingInterval: 1000,
  });
  return { session, state, api, onConnected, onAvrDataAvailable, onError };
}

describe('BridgeSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connect', () => {
    it('stores the version, refreshes registration and starts polling', async () => {
      const { session, state, api, onConnected } = makeSession();

      await session.connect();

      expect(state.bridgeConnected).toBe(true);
      expect(state.bridgeVersion).toBe('1.0.0');
      expect(api.getCurrentAvr).toHaveBeenCalled();
      expect(onConnected).toHaveBeenCalled();
      expect(session.pollerId).not.toBeNull();
    });

    it('probes the AVR when one is already registered', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
      });
      const { session, state, onAvrDataAvailable } = makeSession({ api });

      await session.connect();

      expect(state.avrRegistered).toBe(true);
      expect(state.avrIp).toBe('10.0.0.2');
      expect(state.avrReachable).toBe(true);
      expect(onAvrDataAvailable).toHaveBeenCalledWith(
        expect.objectContaining({
          info: { EQType: 'MultEQXT32' },
          status: { ChSetup: [] },
          ip: '10.0.0.2',
        }),
      );
    });

    it('resolves the model of a pre-registered AVR through discovery', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
        discoverAvrs: vi.fn().mockResolvedValue({
          avrs: [
            { ip: '10.0.0.9', name: 'Marantz CINEMA 50' },
            { ip: '10.0.0.2', name: 'Denon AVC-A1H', model: 'Denon AVC-A1H' },
          ],
        }),
      });
      const { session, state, onAvrDataAvailable } = makeSession({ api });

      await session.connect();

      expect(state.avrModelName).toBe('Denon AVC-A1H');
      expect(onAvrDataAvailable).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'Denon AVC-A1H' }),
      );
      session.disconnect();
    });

    it('skips discovery when the model is already known', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
      });
      const { session } = makeSession({
        api,
        state: makeState({ avrModelName: 'Denon AVR-X3800H' }),
      });

      await session.connect();

      expect(api.discoverAvrs).not.toHaveBeenCalled();
      session.disconnect();
    });

    it('keeps connecting when discovery cannot resolve the model', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
        discoverAvrs: vi.fn().mockRejectedValue(new Error('scan failed')),
      });
      const { session, state, onAvrDataAvailable } = makeSession({ api });

      await session.connect();

      expect(state.bridgeConnected).toBe(true);
      expect(state.avrModelName).toBe('');
      expect(onAvrDataAvailable).toHaveBeenCalled();
      session.disconnect();
    });

    it('does not probe when no AVR is registered', async () => {
      const { session, state, api } = makeSession();

      await session.connect();

      expect(state.avrRegistered).toBe(false);
      expect(api.getAvrInfo).not.toHaveBeenCalled();
      expect(state.avrReachable).toBeNull();
    });

    it('reports connection failures through the error channel and disconnects', async () => {
      const api = makeApi({
        checkVersion: vi.fn().mockRejectedValue(new Error('bridge too old')),
      });
      const { session, state, onError } = makeSession({ api });

      await session.connect();

      expect(state.bridgeConnected).toBe(false);
      expect(session.pollerId).toBeNull();
      expect(onError).toHaveBeenCalledWith('bridge too old', expect.any(Error));
    });

    it('is a no-op when already connected', async () => {
      const { session, state, api } = makeSession({
        state: makeState({ bridgeConnected: true }),
      });

      await session.connect();

      expect(api.checkVersion).not.toHaveBeenCalled();
      expect(state.bridgeVersion).toBe('');
    });
  });

  describe('polling', () => {
    it('keeps the connection alive on healthy ticks', async () => {
      const { session, state, api } = makeSession();
      await session.connect();
      api.health.mockClear();

      await vi.advanceTimersByTimeAsync(2000);

      expect(api.health).toHaveBeenCalledTimes(2);
      expect(state.bridgeConnected).toBe(true);
      session.disconnect();
    });

    it('tolerates isolated tick failures', async () => {
      const { session, state, api, onError } = makeSession();
      await session.connect();
      api.health.mockRejectedValueOnce(new Error('transient hiccup'));

      await vi.advanceTimersByTimeAsync(2000);

      expect(state.bridgeConnected).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(session.pollFailures).toBe(0);
      session.disconnect();
    });

    it('disconnects and reports after consecutive tick failures', async () => {
      const { session, state, api, onError } = makeSession();
      await session.connect();
      api.health.mockRejectedValue(new Error('Failed to connect to RCH Bridge'));

      await vi.advanceTimersByTimeAsync(3000);

      expect(state.bridgeConnected).toBe(false);
      expect(session.pollerId).toBeNull();
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('Bridge polling failed'),
        expect.any(Error),
      );
    });

    it('suspends ticks while the app is processing', async () => {
      const { session, state, api } = makeSession();
      await session.connect();
      state.isProcessing = true;
      api.health.mockClear();

      await vi.advanceTimersByTimeAsync(3000);

      expect(api.health).not.toHaveBeenCalled();
      expect(state.bridgeConnected).toBe(true);
      session.disconnect();
    });

    it('tracks registration changes made outside the app', async () => {
      const { session, state, api } = makeSession();
      await session.connect();
      api.getCurrentAvr.mockResolvedValue({ ip: '10.0.0.9', registered: true });

      await vi.advanceTimersByTimeAsync(1000);

      expect(state.avrRegistered).toBe(true);
      expect(state.avrIp).toBe('10.0.0.9');
      session.disconnect();
    });
  });

  describe('probeAvr', () => {
    it('treats BUSY as a healthy busy connection', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
        getAvrInfo: vi.fn().mockRejectedValue(busyError('measurement')),
      });
      const { session, state, onAvrDataAvailable, onError } = makeSession({ api });
      await session.connect();

      expect(state.avrReachable).toBe(true);
      expect(state.avrBusyReason).toBe('measurement');
      expect(onAvrDataAvailable).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      session.disconnect();
    });

    it('marks the AVR unreachable on transport failures without raising an error', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
        getAvrStatus: vi.fn().mockRejectedValue(new Error('[502] CONNECTION_REFUSED')),
      });
      const { session, state, onError } = makeSession({ api });
      await session.connect();

      expect(state.avrReachable).toBe(false);
      expect(state.avrBusyReason).toBe('');
      expect(onError).not.toHaveBeenCalled();
      session.disconnect();
    });

    it('clears a stale busy reason on a successful probe', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
      });
      const { session, state } = makeSession({
        api,
        state: makeState({ avrBusyReason: 'transfer' }),
      });
      await session.connect();

      expect(state.avrBusyReason).toBe('');
      expect(state.avrReachable).toBe(true);
      session.disconnect();
    });

    it('returns false when not connected or not registered', async () => {
      const { session } = makeSession();

      await expect(session.probeAvr()).resolves.toBe(false);
    });
  });

  describe('AVR registration actions', () => {
    it('registers, stores the model and probes', async () => {
      const { session, state, api } = makeSession();
      await session.connect();

      await session.registerAvr('10.0.0.5', 'Denon AVR-X3800H');

      expect(api.registerAvr).toHaveBeenCalledWith('10.0.0.5', 'Denon AVR-X3800H');
      expect(state.avrRegistered).toBe(true);
      expect(state.avrIp).toBe('10.0.0.5');
      expect(state.avrModelName).toBe('Denon AVR-X3800H');
      expect(api.getAvrInfo).toHaveBeenCalled();
      session.disconnect();
    });

    it('resolves the model through discovery when none is provided', async () => {
      const api = makeApi({
        discoverAvrs: vi.fn().mockResolvedValue({
          avrs: [{ ip: '10.0.0.5', model: 'Denon AVC-A1H' }],
        }),
      });
      const { session, state } = makeSession({
        api,
        state: makeState({ avrModelName: 'Denon AVR-X3800H' }),
      });
      await session.connect();

      await session.registerAvr('10.0.0.5');

      // The stale model of a previously registered AVR must not survive: the
      // model always comes from the API (SSDP scan matched by IP).
      expect(api.discoverAvrs).toHaveBeenCalled();
      expect(state.avrModelName).toBe('Denon AVC-A1H');
      session.disconnect();
    });

    it('clears a stale model when discovery cannot identify the new AVR', async () => {
      const { session, state } = makeSession({
        state: makeState({ avrModelName: 'Denon AVR-X3800H' }),
      });
      await session.connect();

      await session.registerAvr('10.0.0.5');

      expect(state.avrModelName).toBe('');
      session.disconnect();
    });

    it('unregisters and clears the chain state', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
      });
      const { session, state } = makeSession({ api });
      await session.connect();

      await session.unregisterAvr();

      expect(state.avrRegistered).toBe(false);
      expect(state.avrIp).toBe('');
      expect(state.avrModelName).toBe('');
      expect(state.avrReachable).toBeNull();
      session.disconnect();
    });

    it('stores the discovery results', async () => {
      const avrs = [{ ip: '10.0.0.7', name: 'Denon AVR-X3800H' }];
      const api = makeApi({ discoverAvrs: vi.fn().mockResolvedValue({ avrs }) });
      const { session, state } = makeSession({ api });
      await session.connect();

      await expect(session.discover()).resolves.toEqual(avrs);
      expect(state.discoveredAvrs).toEqual(avrs);
      session.disconnect();
    });

    it('rejects actions while disconnected', async () => {
      const { session } = makeSession();

      await expect(session.registerAvr('10.0.0.5')).rejects.toThrow(
        'connect to the RCH Bridge',
      );
      await expect(session.discover()).rejects.toThrow('connect to the RCH Bridge');
      await expect(session.setZoneMain('on')).rejects.toThrow(
        'connect to the RCH Bridge',
      );
    });
  });

  describe('annex actions', () => {
    it('re-probes the AVR after powering the zone on', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
      });
      const { session } = makeSession({ api });
      await session.connect();
      api.getAvrInfo.mockClear();

      await session.setZoneMain('on');

      expect(api.setZoneMain).toHaveBeenCalledWith('on');
      expect(api.getAvrInfo).toHaveBeenCalled();
      session.disconnect();
    });

    it('does not probe after powering the zone off', async () => {
      const api = makeApi({
        getCurrentAvr: vi.fn().mockResolvedValue({ ip: '10.0.0.2', registered: true }),
      });
      const { session } = makeSession({ api });
      await session.connect();
      api.getAvrInfo.mockClear();

      await session.setZoneMain('off');

      expect(api.getAvrInfo).not.toHaveBeenCalled();
      session.disconnect();
    });

    it('disconnects after asking the bridge to shut down', async () => {
      const { session, state, api } = makeSession();
      await session.connect();

      await session.shutdownBridge();

      expect(api.shutdown).toHaveBeenCalled();
      expect(state.bridgeConnected).toBe(false);
      expect(session.pollerId).toBeNull();
    });
  });
});
