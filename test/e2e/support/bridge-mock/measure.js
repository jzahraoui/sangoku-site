import { encodeFloat32ToBase64 } from '../../../../src/rew/rew-codec.js';

const IR_LENGTH = 16384;
const SAMPLE_RATE_HZ = 48000;
const LEVEL_REFERENCE = Object.freeze({ dbSplAtFullScale: 108.2852, trimConstantDb: 10.5 });

const NOT_FOUND = 'NOT_FOUND';
const BUSY = 'BUSY';
const INVALID_POSITION = 'INVALID_POSITION';

const TERMINAL_SESSION_STATES = new Set(['completed', 'failed', 'cancelled']);

// Measurement plan aligned with the DEFAULT_STATUS ChSetup of the bridge mock
// (FL/C/FR/SWMIX1/SWMIX2). The sub WIRE codes (SWMIX1/SWMIX2) intentionally
// differ from the normalized SW1/SW2 command ids so the journeys exercise the
// wire-code mapping of GET /measure/response.
const CHANNEL_PLAN = Object.freeze([
  Object.freeze({ channel: 'FrontLeft', code: 'FL', order: 0, isSub: false }),
  Object.freeze({ channel: 'Center', code: 'C', order: 1, isSub: false }),
  Object.freeze({ channel: 'FrontRight', code: 'FR', order: 2, isSub: false }),
  Object.freeze({ channel: 'SWMix1', code: 'SWMIX1', order: 42, isSub: true }),
  Object.freeze({ channel: 'SWMix2', code: 'SWMIX2', order: 43, isSub: true }),
]);

/** Deterministic decaying synthetic impulse (peak < 1, distinct per channel). */
function syntheticIrBase64(channelIndex, position) {
  const ir = new Float32Array(IR_LENGTH);
  const peak = 480 + channelIndex * 48 + position;
  const amplitude = 0.6 - channelIndex * 0.05;
  for (let k = 0; k < 600; k++) {
    ir[peak + k] = amplitude * Math.exp(-k / 40) * Math.cos(k / 3);
  }
  return encodeFloat32ToBase64(ir, true);
}

/**
 * Scripted measurement endpoints of the RCH Bridge mock. Each
 * `GET /measure/session` advances a running position by one step
 * (`measureSteps` polls to completion, like `transferSteps` for transfers);
 * `availableResponses` grows along the way so journeys exercise the
 * on-the-fly differential import.
 */
class MeasureMock {
  constructor({
    measureSteps = 3,
    sublevelSpls = [68.4, 71.2, 74.9],
    sessionPrecondition = null,
    completeExitOk = true,
    info = null,
    status = null,
    model = null,
  } = {}) {
    this.measureSteps = measureSteps;
    this.sublevelSpls = sublevelSpls;
    this.sessionPrecondition = sessionPrecondition;
    this.completeExitOk = completeExitOk;
    this.info = info;
    this.status = status;
    this.model = model;
    this.session = null;
    this.sublevel = null;
    // Captured POST /measure/position bodies, for journey assertions.
    this.positionRequests = [];
  }

  dispatch(method, pathname, searchParams, body) {
    switch (`${method} ${pathname}`) {
      case 'POST /measure/session':
        return this.handleSessionStart();
      case 'GET /measure/session':
        return this.handleSessionStatus();
      case 'POST /measure/position':
        return this.handlePositionStart(body);
      case 'GET /measure/response':
        return this.handleResponse(searchParams);
      case 'POST /measure/sublevel':
        return this.handleSublevelStart(body);
      case 'GET /measure/sublevel':
        return this.handleSublevelStatus();
      case 'DELETE /measure/sublevel':
        return this.handleSublevelStop();
      case 'POST /measure/session/complete':
        return this.handleComplete();
      case 'DELETE /measure/session':
        return this.handleCancel();
      default:
        return undefined;
    }
  }

  avrSnapshot() {
    return {
      ifver: this.info?.Ifver ?? '00.08',
      dtype: this.info?.DType ?? 'Float',
      eqType: this.info?.EQType ?? 'MultEQXT32',
      maxPositions: 32,
      ampAssign: this.status?.AmpAssign ?? null,
      spPreset: this.status?.SpPreset ?? null,
      subwooferSetup: {
        num: 2,
        maxSubwoofer: this.status?.SWSetup?.SWNum ?? 2,
        mode: this.status?.SWSetup?.SWMode ?? 'Directional',
        layout: this.status?.SWSetup?.SWLayout ?? 'Na',
      },
      swLvlMatch: true,
      micCorrection: {
        model: this.model,
        isCirrus: false,
        micCorrected: true,
        bridgeCorrection: null,
      },
      levelReference: LEVEL_REFERENCE,
      rawInfo: this.info,
      rawStatus: this.status,
    };
  }

  sessionView() {
    const session = this.session;
    return {
      state: session.state,
      avr: this.avrSnapshot(),
      channelPlan: CHANNEL_PLAN,
      positions: session.positions,
      reversePolarityChannels: session.reversePolarityChannels,
      asymmetryWarnings: [],
      reclassifications: [],
      availableResponses: [...session.availableResponses],
      warnings: session.warnings,
      micStatus: { micPlugged: true, headphonePlugged: false },
      currentOperation: session.currentOperation,
      lastError: null,
      exitOk: null,
      exitError: null,
    };
  }

  handleSessionStart() {
    if (this.sessionPrecondition) {
      return {
        __status: 422,
        error: this.sessionPrecondition,
        message: `precondition failed: ${this.sessionPrecondition}`,
      };
    }
    if (this.session && !TERMINAL_SESSION_STATES.has(this.session.state)) {
      return { __status: 409, error: BUSY, message: 'measurement session already active' };
    }
    this.session = {
      state: 'starting',
      readyAfter: 1,
      positions: {},
      availableResponses: [],
      reversePolarityChannels: [],
      warnings: [],
      currentOperation: { kind: 'starting', progress: 0 },
      running: null,
    };
    this.sublevel = null;
    return { __status: 202, state: 'starting' };
  }

  handleSessionStatus() {
    if (!this.session) {
      return { __status: 404, error: NOT_FOUND, message: 'no measurement session' };
    }
    if (this.session.state === 'starting') {
      this.session.readyAfter -= 1;
      if (this.session.readyAfter <= 0) {
        this.session.state = 'ready';
        this.session.currentOperation = null;
      }
    }
    this.advanceRunningPosition();
    return this.sessionView();
  }

  addAvailable(position, code) {
    const exists = this.session.availableResponses.some(
      entry => entry.position === position && entry.channel === code,
    );
    if (!exists) this.session.availableResponses.push({ position, channel: code });
  }

  advanceRunningPosition() {
    const run = this.session.running;
    if (!run) return;
    run.step += 1;
    const fraction = Math.min(1, run.step / this.measureSteps);
    const channelIndex = Math.min(
      run.channels.length - 1,
      Math.floor(fraction * run.channels.length),
    );
    this.session.currentOperation = {
      kind: 'position',
      position: run.position,
      channel: run.channels[channelIndex]?.code ?? null,
      phase: fraction < 0.5 ? 'sweep' : 'retrieve',
      progress: fraction,
    };
    // Responses become retrievable progressively during the retrieve phase.
    const availableCount = Math.floor(fraction * run.channels.length);
    for (let index = 0; index < availableCount; index++) {
      this.addAvailable(run.position, run.channels[index].code);
    }
    if (run.step >= this.measureSteps) {
      for (const channel of run.channels) {
        this.addAvailable(run.position, channel.code);
      }
      this.session.positions[run.position] = {
        position: run.position,
        state: 'done',
        channels: run.channels.map(channel => channel.code),
        reports: {},
        irAvailable: run.channels.map(channel => channel.code),
        error: null,
        measuredAt: new Date().toISOString(),
      };
      if (run.position === 1) {
        // Non-blocking detection warning exercised by the measure journey.
        this.session.reversePolarityChannels = ['C'];
        this.session.warnings = [{ code: 'SPEAKER_PHASE_WARNING', channels: ['C'] }];
      }
      this.session.currentOperation = null;
      this.session.state = 'ready';
      this.session.running = null;
    }
  }

  handlePositionStart(body) {
    const position = body?.position;
    const channels = body?.channels;
    if (!this.session || TERMINAL_SESSION_STATES.has(this.session.state)) {
      return { __status: 409, error: BUSY, message: 'no active measurement session' };
    }
    if (!Number.isInteger(position) || position < 1 || position > 32) {
      return {
        __status: 400,
        error: INVALID_POSITION,
        message: 'position must be an integer 1..32',
      };
    }
    if (position === 1 && channels !== undefined && channels !== null) {
      return {
        __status: 400,
        error: INVALID_POSITION,
        message: 'a channels subset is not allowed for position 1',
      };
    }
    if (this.session.state !== 'ready') {
      return {
        __status: 409,
        error: BUSY,
        message: `session not ready (state: ${this.session.state})`,
      };
    }
    if (position >= 2 && this.session.positions[1]?.state !== 'done') {
      return {
        __status: 422,
        error: INVALID_POSITION,
        message: 'position 1 must be measured (detection) before positions >= 2',
      };
    }
    let planChannels = CHANNEL_PLAN;
    if (channels !== undefined && channels !== null) {
      const planCodes = new Set(CHANNEL_PLAN.map(entry => entry.code));
      const unknown = channels.filter(code => !planCodes.has(code));
      if (unknown.length > 0) {
        return {
          __status: 400,
          error: 'INVALID_CHANNELS',
          message: `channels not in the session plan: ${unknown.join(', ')}`,
        };
      }
      planChannels = CHANNEL_PLAN.filter(entry => channels.includes(entry.code));
    }
    this.positionRequests.push({ position, channels: channels ?? null });
    this.session.state = 'measuring';
    this.session.running = { position, channels: planChannels, step: 0 };
    return { __status: 202, state: 'measuring', position };
  }

  handleResponse(searchParams) {
    const position = Number(searchParams.get('position'));
    const channel = searchParams.get('channel');
    const available = this.session?.availableResponses.some(
      entry => entry.position === position && entry.channel === channel,
    );
    if (!available) {
      return {
        __status: 404,
        error: NOT_FOUND,
        message: `no response for position ${position} channel ${channel}`,
      };
    }
    const channelIndex = CHANNEL_PLAN.findIndex(entry => entry.code === channel);
    return {
      position,
      channel,
      sampleCount: IR_LENGTH,
      sampleRateHz: SAMPLE_RATE_HZ,
      dtype: 'Float',
      responseCoef: 1,
      encoding: 'base64/float32le',
      samples: syntheticIrBase64(channelIndex, position),
      plausibilityWarning: false,
      micCorrection: { status: 'avr-corrected' },
      levelReference: LEVEL_REFERENCE,
    };
  }

  handleSublevelStart(body) {
    if (!this.session || this.session.state !== 'ready') {
      return { __status: 409, error: BUSY, message: 'session not ready' };
    }
    const sub = typeof body?.sub === 'string' ? body.sub : 'SW1';
    this.session.state = 'subleveling';
    this.sublevel = {
      active: true,
      sub,
      swIndex: Math.max(0, Number(sub.replace('SW', '')) - 1),
      reads: 0,
    };
    return { __status: 202, state: 'subleveling', sub };
  }

  sublevelStatusBody() {
    const readCount = Math.min(this.sublevel.reads, this.sublevelSpls.length);
    return {
      state: this.sublevel.active ? 'running' : 'stopped',
      sub: this.sublevel.sub,
      swIndex: this.sublevel.swIndex,
      spl: this.sublevelSpls[Math.max(0, readCount - 1)] ?? null,
      count: this.sublevel.reads,
      samples: this.sublevelSpls.slice(0, readCount),
      discarded: 0,
      error: null,
    };
  }

  handleSublevelStatus() {
    if (!this.sublevel) {
      return { __status: 404, error: NOT_FOUND, message: 'no sublevel routine' };
    }
    if (this.sublevel.active) this.sublevel.reads += 1;
    return this.sublevelStatusBody();
  }

  handleSublevelStop() {
    if (!this.sublevel) {
      return { __status: 404, error: NOT_FOUND, message: 'no sublevel routine' };
    }
    this.sublevel.active = false;
    if (this.session?.state === 'subleveling') {
      this.session.state = 'ready';
    }
    return { state: 'ready', ...this.sublevelStatusBody() };
  }

  handleComplete() {
    if (!this.session || TERMINAL_SESSION_STATES.has(this.session.state)) {
      return { __status: 404, error: NOT_FOUND, message: 'no active measurement session' };
    }
    if (this.session.running) {
      return { __status: 409, error: BUSY, message: 'an operation is in progress' };
    }
    this.session.state = 'completed';
    return {
      state: 'completed',
      exitOk: this.completeExitOk,
      exitError: this.completeExitOk
        ? null
        : { code: 'SESSION_EXIT_FAILED', message: 'exit not confirmed' },
      lastError: null,
    };
  }

  handleCancel() {
    if (!this.session || TERMINAL_SESSION_STATES.has(this.session.state)) {
      return { __status: 404, error: NOT_FOUND, message: 'no active measurement session' };
    }
    this.session.state = 'cancelled';
    this.session.running = null;
    this.session.currentOperation = null;
    if (this.sublevel) this.sublevel.active = false;
    return { state: 'cancelled', exitOk: true };
  }
}

export { MeasureMock };
