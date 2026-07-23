import { describe, expect, it, vi } from 'vitest';
import { createBridgeMeasurement } from '../../src/services/bridge-measurement.js';
import { createImportSession } from '../../src/services/import-session.js';
import { encodeFloat32ToBase64 } from '../../src/rew/rew-codec.js';

const READY = 'ready';
const MEASURING = 'measuring';

function makeState(overrides = {}) {
  return {
    measureState: 'idle',
    measurePosition: null,
    measureProgress: 0,
    measurePhase: '',
    measureCurrentChannel: null,
    measureChannelPlan: [],
    measureMaxPositions: 0,
    measurePositionsDone: [],
    measureNextPosition: 1,
    measureWarnings: [],
    measureSwLvlMatch: false,
    sublevelSub: null,
    sublevelSpl: null,
    ...overrides,
  };
}

function responseFixture(overrides = {}) {
  return {
    sampleCount: 4,
    sampleRateHz: 48000,
    dtype: 'Float',
    encoding: 'base64/float32le',
    samples: encodeFloat32ToBase64(Float32Array.from([0, 0.5, 0.25, 0.125]), true),
    plausibilityWarning: false,
    levelReference: { dbSplAtFullScale: 108.2852, trimConstantDb: 10.5 },
    ...overrides,
  };
}

function sessionView(overrides = {}) {
  return {
    state: READY,
    avr: {
      maxPositions: 32,
      swLvlMatch: true,
      levelReference: { dbSplAtFullScale: 108.2852, trimConstantDb: 10.5 },
      rawInfo: { EQType: 'MultEQXT32', Ifver: '00.08' },
      rawStatus: { ChSetup: [] },
    },
    channelPlan: [
      { channel: 'FrontLeft', code: 'FL', order: 0, isSub: false },
      { channel: 'Center', code: 'C', order: 1, isSub: false },
      { channel: 'SWMix1', code: 'SWMIX1', order: 42, isSub: true },
    ],
    positions: {},
    availableResponses: [],
    warnings: [],
    currentOperation: null,
    lastError: null,
    ...overrides,
  };
}

function makeApi(overrides = {}) {
  return {
    startMeasureSession: vi.fn().mockResolvedValue({ state: 'starting' }),
    getMeasureSession: vi.fn().mockResolvedValue(sessionView()),
    startMeasurePosition: vi.fn().mockResolvedValue({ state: MEASURING, position: 1 }),
    getMeasureResponse: vi.fn().mockResolvedValue(responseFixture()),
    startSublevel: vi.fn().mockResolvedValue({ state: 'subleveling' }),
    getSublevel: vi
      .fn()
      .mockResolvedValue({ state: 'running', sub: 'SW1', spl: 72.5, count: 1 }),
    stopSublevel: vi.fn().mockResolvedValue({ state: READY }),
    completeMeasureSession: vi
      .fn()
      .mockResolvedValue({ state: 'completed', exitOk: true }),
    cancelMeasureSession: vi.fn().mockResolvedValue({ state: 'cancelled' }),
    ...overrides,
  };
}

function makeService({
  api = makeApi(),
  state = makeState(),
  rewPolling = true,
  model = 'Denon AVC-A1H',
  importer = { importImpulseResponse: vi.fn().mockResolvedValue(undefined) },
} = {}) {
  const bridgeSession = {
    assertConnected: vi.fn(),
    state: { avrModelName: model },
    api,
  };
  const session = {
    state: { isPolling: rewPolling },
    setProcessing: vi.fn().mockResolvedValue(undefined),
  };
  const onAvrSnapshot = vi.fn();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createBridgeMeasurement({
    bridgeSession,
    session,
    importer,
    state,
    onAvrSnapshot,
    pollIntervalMs: 1,
    log,
  });
  return { service, api, state, session, importer, onAvrSnapshot, log };
}

async function startReadySession(context) {
  await context.service.startSession();
}

function bridgeError(code, status = 422) {
  const error = new Error(`[${status}] ${code}`);
  error.code = code;
  error.status = status;
  return error;
}

describe('BridgeMeasurement', () => {
  describe('startSession', () => {
    it('polls until ready, installs the plan and reports the AVR snapshot', async () => {
      const context = makeService();
      context.api.getMeasureSession
        .mockResolvedValueOnce(sessionView({ state: 'starting' }))
        .mockResolvedValueOnce(sessionView());

      await context.service.startSession();

      expect(context.api.startMeasureSession).toHaveBeenCalledWith('Denon AVC-A1H');
      expect(context.api.getMeasureSession).toHaveBeenCalledTimes(2);
      expect(context.state.measureState).toBe(READY);
      expect(context.state.measureMaxPositions).toBe(32);
      expect(context.state.measureSwLvlMatch).toBe(true);
      expect(context.state.measureNextPosition).toBe(1);
      expect(context.onAvrSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ maxPositions: 32, rawInfo: expect.any(Object) }),
      );
    });

    it('maps the channel plan to app command ids, keeping the wire codes', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          channelPlan: [
            { channel: 'FrontLeft', code: 'FL', order: 0, isSub: false },
            { channel: 'SWMix1', code: 'SWMIX1', order: 42, isSub: true },
            { channel: 'SWFront2sp', code: 'SWFront2sp', order: 42, isSub: true },
          ],
        }),
      );

      await context.service.startSession();

      expect(context.state.measureChannelPlan).toEqual([
        { channel: 'FrontLeft', code: 'FL', commandId: 'FL', isSub: false },
        { channel: 'SWMix1', code: 'SWMIX1', commandId: 'SW1', isSub: true },
        { channel: 'SWFront2sp', code: 'SWFront2sp', commandId: 'SW1', isSub: true },
      ]);
    });

    it('turns the 422 preconditions into actionable messages and returns to idle', async () => {
      const cases = [
        ['MIC_NOT_PLUGGED', /microphone is not plugged/],
        ['HEADPHONE_PLUGGED', /Headphones are plugged/],
        ['BTTX_CONNECTED', /Bluetooth transmitter/],
        ['AVR_POWER_OFF', /main zone is off/],
        ['IFVER_MISMATCH', /interface version/],
      ];
      for (const [code, pattern] of cases) {
        const context = makeService({
          api: makeApi({
            startMeasureSession: vi.fn().mockRejectedValue(bridgeError(code)),
          }),
        });
        await expect(context.service.startSession()).rejects.toThrow(pattern);
        expect(context.state.measureState).toBe('idle');
      }
    });

    it('keeps the error code on the wrapped precondition error', async () => {
      const context = makeService({
        api: makeApi({
          startMeasureSession: vi
            .fn()
            .mockRejectedValue(bridgeError('MIC_NOT_PLUGGED')),
        }),
      });

      await expect(context.service.startSession()).rejects.toMatchObject({
        code: 'MIC_NOT_PLUGGED',
      });
    });

    it('refuses to start without REW connected', async () => {
      const context = makeService({ rewPolling: false });

      await expect(context.service.startSession()).rejects.toThrow(/connect to REW/);
      expect(context.api.startMeasureSession).not.toHaveBeenCalled();
    });

    it('refuses to start while a session is already open', async () => {
      const context = makeService();
      await startReadySession(context);

      await expect(context.service.startSession()).rejects.toThrow(
        /while the measurement state is "ready"/,
      );
    });

    it('fails and resets when the session ends during the ready wait', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({ state: 'failed', lastError: { message: 'ENTER_AUDY refused' } }),
      );

      await expect(context.service.startSession()).rejects.toThrow(/ENTER_AUDY refused/);
      expect(context.state.measureState).toBe('idle');
    });
  });

  describe('measurePosition', () => {
    it('polls, tracks the progress and imports each new response once', async () => {
      const context = makeService();
      await startReadySession(context);
      const availableFirst = [{ position: 1, channel: 'FL' }];
      const availableAll = [
        { position: 1, channel: 'FL' },
        { position: 1, channel: 'SWMIX1' },
      ];
      context.api.getMeasureSession
        .mockResolvedValueOnce(
          sessionView({
            state: MEASURING,
            currentOperation: { kind: 'position', position: 1, phase: 'sweep', progress: 0.25 },
            availableResponses: availableFirst,
          }),
        )
        // Same list twice: the differential must not import FL again.
        .mockResolvedValueOnce(
          sessionView({
            state: MEASURING,
            currentOperation: { kind: 'position', position: 1, phase: 'retrieve', progress: 0.8 },
            availableResponses: availableFirst,
          }),
        )
        .mockResolvedValueOnce(
          sessionView({
            availableResponses: availableAll,
            positions: { 1: { position: 1, state: 'done' } },
          }),
        );

      const result = await context.service.measurePosition(1);

      expect(result).toEqual({ state: 'done', position: 1 });
      expect(context.importer.importImpulseResponse).toHaveBeenCalledTimes(2);
      const firstCall = context.importer.importImpulseResponse.mock.calls[0];
      expect(firstCall[1].name).toBe('FL_P01');
      expect(firstCall[1].data).toBeInstanceOf(Float32Array);
      expect(Array.from(firstCall[1].data)).toEqual([0, 0.5, 0.25, 0.125]);
      // Model file-import convention (A1H non-Cirrus → 80 dB), never the
      // raw-capture dbSplAtFullScale of the bridge levelReference.
      expect(firstCall[2]).toMatchObject({ sampleRate: 48000, splOffset: 80 });
      const secondCall = context.importer.importImpulseResponse.mock.calls[1];
      expect(secondCall[1].name).toBe('SW1_P01');
      // The response fetch uses the WIRE code, never the normalized SW1.
      expect(context.api.getMeasureResponse).toHaveBeenCalledWith(1, 'SWMIX1');
      expect(context.state.measureState).toBe(READY);
      expect(context.state.measureProgress).toBe(100);
      expect(context.state.measurePositionsDone).toEqual([1]);
      expect(context.state.measureNextPosition).toBe(2);
    });

    it('runs the import under the processing lock', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({ positions: { 1: { position: 1, state: 'done' } } }),
      );

      await context.service.measurePosition(1);

      expect(context.session.setProcessing.mock.calls.map(call => call[0])).toEqual([
        true,
        false,
      ]);
    });

    it('imports with applyCal false and the model convention offset through the real importer', async () => {
      const rewImport = { importImpulseResponseData: vi.fn().mockResolvedValue({}) };
      const created = {};
      const session = {
        state: { isPolling: true },
        setProcessing: vi.fn().mockResolvedValue(undefined),
        rewImport,
        addMeasurementFromRewOperation: vi.fn(async operation => {
          await operation();
          return created;
        }),
      };
      const api = makeApi();
      const bridgeSession = { assertConnected: vi.fn(), state: {}, api };
      const state = makeState();
      const service = createBridgeMeasurement({
        bridgeSession,
        session,
        importer: createImportSession(),
        state,
        pollIntervalMs: 1,
      });
      await service.startSession();
      api.getMeasureSession.mockResolvedValue(
        sessionView({
          availableResponses: [{ position: 1, channel: 'FL' }],
          positions: { 1: { position: 1, state: 'done' } },
        }),
      );

      await service.measurePosition(1);

      expect(rewImport.importImpulseResponseData).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: 'FL_P01',
          sampleRate: 48000,
          splOffset: 80,
          applyCal: false,
        }),
      );
      expect(created.IRPeakValue).toBe(0.5);
    });

    it('imports at 105 dB for a Cirrus-DSP model (file-import convention)', async () => {
      const context = makeService({ model: 'Denon AVR-X3600H' });
      await startReadySession(context);
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          availableResponses: [{ position: 1, channel: 'FL' }],
          positions: { 1: { position: 1, state: 'done' } },
        }),
      );

      await context.service.measurePosition(1);

      expect(context.importer.importImpulseResponse.mock.calls[0][2].splOffset).toBe(105);
    });

    it('rejects a channels subset for position 1', async () => {
      const context = makeService();
      await startReadySession(context);

      await expect(context.service.measurePosition(1, ['FL'])).rejects.toThrow(
        /full channel plan/,
      );
      expect(context.api.startMeasurePosition).not.toHaveBeenCalled();
      expect(context.state.measureState).toBe(READY);
    });

    it('rejects an empty channel selection for positions >= 2', async () => {
      const context = makeService();
      await startReadySession(context);

      await expect(context.service.measurePosition(2, [])).rejects.toThrow(
        /at least one channel/,
      );
    });

    it('forwards the wire-code subset for positions >= 2', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({ positions: { 2: { position: 2, state: 'done' } } }),
      );

      await context.service.measurePosition(2, ['FL', 'SWMIX1']);

      expect(context.api.startMeasurePosition).toHaveBeenCalledWith(2, ['FL', 'SWMIX1']);
    });

    it('refuses concurrent operations while measuring', async () => {
      const context = makeService();
      await startReadySession(context);
      context.state.measureState = MEASURING;

      await expect(context.service.measurePosition(2)).rejects.toThrow(
        /while the measurement state is "measuring"/,
      );
      await expect(context.service.complete()).rejects.toThrow(
        /while the measurement state is "measuring"/,
      );
      await expect(context.service.startSublevel('SW1')).rejects.toThrow(
        /while the measurement state is "measuring"/,
      );
    });

    it('re-attaches to a ready session left open on the bridge (page reload)', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          availableResponses: [
            { position: 1, channel: 'FL' },
            { position: 1, channel: 'C' },
          ],
          positions: { 1: { position: 1, state: 'done' } },
        }),
      );

      const resumed = await context.service.resumeSession();

      expect(resumed).toBe(READY);
      expect(context.state.measureState).toBe(READY);
      expect(context.state.measureChannelPlan).toHaveLength(3);
      expect(context.state.measurePositionsDone).toEqual([1]);
      expect(context.state.measureNextPosition).toBe(2);
      expect(context.onAvrSnapshot).toHaveBeenCalled();
      expect(context.api.startMeasureSession).not.toHaveBeenCalled();
      // Already-listed responses were imported before the reload: no re-import.
      expect(context.api.getMeasureResponse).not.toHaveBeenCalled();
      expect(context.importer.importImpulseResponse).not.toHaveBeenCalled();
    });

    it('returns null when the bridge holds no session or an ended one', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockRejectedValue(bridgeError('NOT_FOUND', 404));
      expect(await context.service.resumeSession()).toBeNull();
      expect(context.state.measureState).toBe('idle');

      context.api.getMeasureSession.mockResolvedValue(sessionView({ state: 'cancelled' }));
      expect(await context.service.resumeSession()).toBeNull();
      expect(context.state.measureState).toBe('idle');
    });

    it('re-attaches to a running sweep and imports only the new responses', async () => {
      const context = makeService();
      const running = sessionView({
        state: MEASURING,
        currentOperation: { kind: 'position', position: 2, phase: 'sweep', progress: 0.5 },
        availableResponses: [{ position: 1, channel: 'FL' }],
        positions: {
          1: { position: 1, state: 'done' },
          2: { position: 2, state: 'running' },
        },
      });
      context.api.getMeasureSession.mockResolvedValueOnce(running).mockResolvedValue(
        sessionView({
          availableResponses: [
            { position: 1, channel: 'FL' },
            { position: 2, channel: 'FL' },
          ],
          positions: {
            1: { position: 1, state: 'done' },
            2: { position: 2, state: 'done' },
          },
        }),
      );

      const resumed = await context.service.resumeSession();
      expect(resumed).toBe(MEASURING);
      expect(context.state.measurePosition).toBe(2);
      await context.service.resumeTask;

      expect(context.state.measureState).toBe(READY);
      // Only the response measured after the re-attach is imported.
      expect(context.api.getMeasureResponse).toHaveBeenCalledTimes(1);
      expect(context.api.getMeasureResponse).toHaveBeenCalledWith(2, 'FL');
      expect(context.session.setProcessing).toHaveBeenCalledWith(true);
      expect(context.session.setProcessing).toHaveBeenCalledWith(false);
    });

    it('re-attaches to a running sub level matching and backfills the sub', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockResolvedValue(sessionView({ state: 'subleveling' }));

      const resumed = await context.service.resumeSession();
      expect(resumed).toBe('sublevel');
      expect(context.state.measureState).toBe('sublevel');

      await new Promise(resolve => setTimeout(resolve, 5));
      expect(context.state.sublevelSub).toBe('SW1');
      expect(context.state.sublevelSpl).toBe(72.5);
      await context.service.stopSublevel();
    });

    it('tracks then clears the channel under work across a position', async () => {
      const context = makeService();
      await startReadySession(context);
      let channelDuringImport = null;
      context.api.getMeasureResponse.mockImplementation(async () => {
        channelDuringImport = context.state.measureCurrentChannel;
        return responseFixture();
      });
      context.api.getMeasureSession
        .mockResolvedValueOnce(
          sessionView({
            state: MEASURING,
            currentOperation: {
              kind: 'position',
              position: 1,
              channel: 'SWMIX1',
              phase: 'sweep',
              progress: 0.4,
            },
          }),
        )
        .mockResolvedValue(
          sessionView({
            availableResponses: [{ position: 1, channel: 'SWMIX1' }],
            positions: { 1: { position: 1, state: 'done' } },
          }),
        );

      await context.service.measurePosition(1);

      // The wire code of the swept/imported channel surfaces as the app id.
      expect(channelDuringImport).toBe('SW1');
      // Cleared once the position completes.
      expect(context.state.measureCurrentChannel).toBeNull();
    });

    it('exposes the session warnings and the per-response plausibility flags', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getMeasureResponse.mockResolvedValue(
        responseFixture({ plausibilityWarning: true }),
      );
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          warnings: [
            { code: 'SPEAKER_PHASE_WARNING', channels: ['C'] },
            { code: 'SPEAKER_ASYMMETRY_WARNING', pairs: [{ left: 'FL', right: 'FR' }] },
          ],
          availableResponses: [{ position: 1, channel: 'FL' }],
          positions: { 1: { position: 1, state: 'done' } },
        }),
      );

      await context.service.measurePosition(1);

      expect(context.state.measureWarnings).toEqual([
        'Reverse polarity reported on: C',
        'Speaker layout asymmetry reported (1 pair(s))',
        'FL_P01: the AVR flagged this response as implausible',
      ]);
      expect(context.state.measureState).toBe(READY);
    });

    it('warns when several subwoofers are collapsed by a non-Directional mode', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          avr: {
            ...sessionView().avr,
            subwooferSetup: { num: 4, maxSubwoofer: 4, mode: 'Standard', layout: 'Na' },
          },
        }),
      );

      await context.service.startSession();

      expect(context.state.measureWarnings).toEqual([
        expect.stringContaining('Subwoofer mode "Standard": the 4 subwoofers'),
      ]);
    });

    it('stays silent on the sub warning in Directional mode', async () => {
      const context = makeService();
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          avr: {
            ...sessionView().avr,
            subwooferSetup: {
              num: 4,
              maxSubwoofer: 4,
              mode: 'Directional',
              layout: 'FL/FR/RL/RR',
            },
          },
        }),
      );

      await context.service.startSession();

      expect(context.state.measureWarnings).toEqual([]);
    });

    it('keeps sweeping when one response import fails, then surfaces a warning', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getMeasureResponse.mockRejectedValue(new Error('[404] NOT_FOUND'));
      const running = sessionView({
        state: MEASURING,
        availableResponses: [{ position: 1, channel: 'FL' }],
      });
      context.api.getMeasureSession
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValue(
          sessionView({
            availableResponses: [{ position: 1, channel: 'FL' }],
            positions: { 1: { position: 1, state: 'done' } },
          }),
        );

      await context.service.measurePosition(1);

      expect(context.api.getMeasureResponse).toHaveBeenCalledTimes(3);
      expect(context.state.measureWarnings).toContainEqual(
        expect.stringContaining('FL_P01: import failed'),
      );
      expect(context.state.measureState).toBe(READY);
    });

    it('reports a failed position and stays ready', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getMeasureSession.mockResolvedValue(
        sessionView({
          positions: {
            1: { position: 1, state: 'failed', error: { message: 'sweep aborted' } },
          },
        }),
      );

      await expect(context.service.measurePosition(1)).rejects.toThrow(
        /Position 1 failed: sweep aborted/,
      );
      expect(context.state.measureState).toBe(READY);
    });

    it('returns cleanly when the session is cancelled mid-measurement', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getMeasureSession
        .mockResolvedValueOnce(
          sessionView({
            state: MEASURING,
            currentOperation: { kind: 'position', position: 1, phase: 'sweep', progress: 0.2 },
          }),
        )
        .mockResolvedValue(sessionView({ state: 'cancelled' }));

      const result = await context.service.measurePosition(1);

      expect(result).toEqual({ state: 'cancelled' });
      expect(context.state.measureState).toBe('idle');
      expect(context.state.measureChannelPlan).toEqual([]);
      expect(context.session.setProcessing).toHaveBeenLastCalledWith(false);
    });
  });

  describe('sublevel', () => {
    it('starts the routine, polls the live SPL and stops on demand', async () => {
      const context = makeService();
      await startReadySession(context);

      await context.service.startSublevel('SW2');

      expect(context.api.startSublevel).toHaveBeenCalledWith('SW2');
      expect(context.state.measureState).toBe('sublevel');
      expect(context.state.sublevelSub).toBe('SW2');
      await vi.waitFor(() => expect(context.state.sublevelSpl).toBe(72.5));

      await context.service.stopSublevel();

      expect(context.api.stopSublevel).toHaveBeenCalledTimes(1);
      expect(context.state.measureState).toBe(READY);
      expect(context.state.sublevelSub).toBeNull();
      expect(context.state.sublevelSpl).toBeNull();
    });

    it('returns to ready when the routine stops on the bridge side', async () => {
      const context = makeService();
      await startReadySession(context);
      context.api.getSublevel
        .mockResolvedValueOnce({ state: 'running', sub: 'SW1', spl: 70.1 })
        .mockResolvedValue({ state: 'stopped', sub: 'SW1', spl: 74.9 });

      await context.service.startSublevel('SW1');
      await context.service.sublevelTask;

      expect(context.state.measureState).toBe(READY);
      expect(context.state.sublevelSub).toBeNull();
    });

    it('maps SUBLEVEL_NOT_SUPPORTED to an actionable message and stays ready', async () => {
      const context = makeService({
        api: makeApi({
          startSublevel: vi
            .fn()
            .mockRejectedValue(bridgeError('SUBLEVEL_NOT_SUPPORTED')),
        }),
      });
      await startReadySession(context);

      await expect(context.service.startSublevel('SW1')).rejects.toThrow(
        /does not support per-subwoofer level matching/,
      );
      expect(context.state.measureState).toBe(READY);
      expect(context.state.sublevelSub).toBeNull();
    });

    it('refuses stopping when no routine is running', async () => {
      const context = makeService();
      await startReadySession(context);

      await expect(context.service.stopSublevel()).rejects.toThrow(
        /while the measurement state is "ready"/,
      );
    });
  });

  describe('complete', () => {
    it('completes and returns to idle', async () => {
      const context = makeService();
      await startReadySession(context);

      const result = await context.service.complete();

      expect(result.state).toBe('completed');
      expect(context.state.measureState).toBe('idle');
      expect(context.state.measureChannelPlan).toEqual([]);
    });

    it('surfaces exitOk false with a power-cycle recommendation', async () => {
      const context = makeService({
        api: makeApi({
          completeMeasureSession: vi
            .fn()
            .mockResolvedValue({ state: 'completed', exitOk: false }),
        }),
      });
      await startReadySession(context);

      const result = await context.service.complete();

      expect(result.exitOk).toBe(false);
      expect(context.state.measureState).toBe('idle');
      expect(context.log.warn).toHaveBeenCalledWith(
        expect.stringContaining('power-cycle'),
      );
    });

    it('stays ready when the completion call fails', async () => {
      const context = makeService({
        api: makeApi({
          completeMeasureSession: vi
            .fn()
            .mockRejectedValue(bridgeError('BUSY', 409)),
        }),
      });
      await startReadySession(context);

      await expect(context.service.complete()).rejects.toThrow();
      expect(context.state.measureState).toBe(READY);
    });
  });

  describe('cancel', () => {
    it('cancels a ready session and resets to idle', async () => {
      const context = makeService();
      await startReadySession(context);

      await context.service.cancel();

      expect(context.api.cancelMeasureSession).toHaveBeenCalled();
      expect(context.state.measureState).toBe('idle');
      expect(context.state.measureChannelPlan).toEqual([]);
      expect(context.state.measureWarnings).toEqual([]);
    });

    it('tolerates an already-gone session (404)', async () => {
      const context = makeService({
        api: makeApi({
          cancelMeasureSession: vi
            .fn()
            .mockRejectedValue(bridgeError('NOT_FOUND', 404)),
        }),
      });
      await startReadySession(context);

      await context.service.cancel();

      expect(context.state.measureState).toBe('idle');
    });

    it('stops a running sublevel routine before cancelling', async () => {
      const context = makeService();
      await startReadySession(context);
      await context.service.startSublevel('SW1');

      await context.service.cancel();

      expect(context.state.measureState).toBe('idle');
      expect(context.state.sublevelSub).toBeNull();
    });

    it('refuses cancelling when no session exists', async () => {
      const context = makeService();

      await expect(context.service.cancel()).rejects.toThrow(/No measurement session/);
    });
  });
});
