/**
 * Audyssey measurement assistant (RCH 2.0).
 *
 * [ORCHESTRATION] service owning the bridge-driven measurement wizard: the
 * bridge drives the amplifier (official Audyssey sweep sequence), this service
 * polls the measurement session, imports every new impulse response into REW
 * on the fly and exposes a UI-readable state machine. No Knockout, no DOM.
 *
 * Injected dependencies:
 * - `bridgeSession`: connected bridge session service (api + assertConnected).
 * - `session`: REW session service (processing lock, import plumbing,
 *   state.isPolling).
 * - `importer`: import-session service ({ importImpulseResponse }) — reused as
 *   is, so `applyCal` stays false (the bridge corrects Cirrus microphones
 *   itself; RCH never applies a mic calibration on bridge measurements).
 * - `state`: accessor over the app state — measureState, measurePosition,
 *   measureProgress, measurePhase, measureChannelPlan, measureMaxPositions,
 *   measurePositionsDone, measureNextPosition, measureWarnings,
 *   measureSwLvlMatch, sublevelSub, sublevelSpl (all written by this service).
 * - `onAvrSnapshot(avr)`: called once the session is ready, with the AVR
 *   snapshot captured by the bridge (rawInfo/rawStatus feed the live
 *   jsonAvrData synthesis).
 *
 * SPL convention: measured IRs are imported at the ABSOLUTE reference level
 * `avr.levelReference.dbSplAtFullScale` (FR-198) — never the historical 80/105
 * `avr.splOffset` used by file imports.
 */
import { CHANNEL_TYPES } from '../audyssey.js';
import { decodeBase64ToFloat32 } from '../rew/rew-codec.js';
import { normalizeChannelCode } from './avr-data-synthesis.js';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const STATE_IDLE = 'idle';
const STATE_STARTING = 'starting';
const STATE_READY = 'ready';
const STATE_MEASURING = 'measuring';
const STATE_SUBLEVEL = 'sublevel';
const STATE_COMPLETING = 'completing';

// Bridge-side session states meaning the session no longer holds the AVR.
const SESSION_OVER_STATES = new Set(['completed', 'failed', 'cancelled']);
const POSITION_TERMINAL_STATES = new Set(['done', 'failed', 'cancelled']);

// Fallback import level when the AVR snapshot carries no usable absolute SPL
// reference (unknown model / no ADC lineup) — logged once per session.
const DEFAULT_SPL_OFFSET_DB = 80;

const MEASUREMENT_SAMPLE_RATE = 48000;

// Actionable messages for the bridge precondition/support error codes
// (POST /measure/session 422s, sublevel 422s). The original error is kept as
// `cause` and its `code` survives on the wrapper for the UI i18n mapping.
const PRECONDITION_MESSAGES = Object.freeze({
  MIC_NOT_PLUGGED:
    'The Audyssey microphone is not plugged in: connect it to the SETUP MIC jack of the AVR, then retry',
  HEADPHONE_PLUGGED: 'Headphones are plugged into the AVR: unplug them, then retry',
  BTTX_CONNECTED:
    'A Bluetooth transmitter is active on the AVR: disconnect it, then retry',
  AVR_POWER_OFF: 'The AVR main zone is off: power it on, then retry',
  IFVER_MISMATCH:
    'This AVR calibration interface version is not supported by the bridge',
  MIC_CURVE_INVALID:
    'The bridge microphone correction data is unusable: reinstall or update the RCH Bridge',
  SUBLEVEL_NOT_SUPPORTED: 'This AVR does not support per-subwoofer level matching',
});

function waitMs(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** Wraps known bridge error codes with an actionable message (code kept). */
function describeMeasureFailure(error) {
  const friendly = PRECONDITION_MESSAGES[error?.code];
  if (!friendly) return error;
  const wrapped = new Error(friendly, { cause: error });
  wrapped.code = error.code;
  return wrapped;
}

/**
 * App channel id (CHANNEL_TYPES code: FL, C, SW1...) for a channel-plan entry.
 * `entry.channel` is the canonical EnChannelType name (FrontLeft, SWMix1,
 * SWFront2sp...); `entry.code` is the WIRE sweep code kept verbatim for
 * `GET /measure/response` (e.g. SWMIX1 — never sent as SW1).
 */
function commandIdForPlanEntry(entry) {
  const byName = CHANNEL_TYPES[`EnChannelType_${entry.channel}`];
  return byName?.code ?? normalizeChannelCode(entry.code);
}

/** Grouping title convention shared with renameMeasurements: `FL_P01`. */
function measurementTitle(commandId, position) {
  return `${commandId}_P${String(position).padStart(2, '0')}`;
}

/** Position number of the non-terminal position entry of a session view. */
function runningPosition(view) {
  for (const [number, position] of Object.entries(view.positions ?? {})) {
    if (position && !POSITION_TERMINAL_STATES.has(position.state)) {
      return Number(number);
    }
  }
  return null;
}

/** Smallest position number not measured yet (1-based). */
function nextPosition(donePositions, maxPositions) {
  const taken = new Set(donePositions);
  let candidate = 1;
  while (taken.has(candidate)) candidate += 1;
  if (maxPositions > 0 && candidate > maxPositions) return maxPositions;
  return candidate;
}

/** Human-readable, NON-blocking session warnings. */
function describeSessionWarnings(view) {
  const warnings = [];
  // Official protocol: outside Directional mode, multiple subs collapse to a
  // single mutualised sweep — surface why only one subwoofer shows up.
  const sw = view.avr?.subwooferSetup;
  if (sw && Number(sw.num) > 1 && sw.mode !== 'Directional') {
    warnings.push(
      `Subwoofer mode "${sw.mode}": the ${sw.num} subwoofers are measured together as a single sweep. ` +
        'Set the AVR subwoofer mode to Directional to measure each subwoofer individually.',
    );
  }
  for (const warning of view.warnings ?? []) {
    if (warning.code === 'SPEAKER_PHASE_WARNING') {
      warnings.push(
        `Reverse polarity reported on: ${(warning.channels ?? []).join(', ')}`,
      );
    } else if (warning.code === 'SPEAKER_ASYMMETRY_WARNING') {
      warnings.push(
        `Speaker layout asymmetry reported (${(warning.pairs ?? []).length} pair(s))`,
      );
    } else if (warning.code) {
      warnings.push(String(warning.code));
    }
  }
  return warnings;
}

class BridgeMeasurement {
  // Tolerated consecutive poll failures before giving up on the current loop.
  static POLL_FAILURE_LIMIT = 3;
  // Upper bound on the ready-wait polls (the bridge start sequence is bounded).
  static START_POLL_LIMIT = 120;
  // Fetch/import attempts per impulse response before it is skipped (warning).
  static RESPONSE_RETRY_LIMIT = 3;

  constructor({
    bridgeSession,
    session,
    importer,
    state,
    onAvrSnapshot = async () => {},
    pollIntervalMs = 1000,
    log = noopLog,
  }) {
    this.bridgeSession = bridgeSession;
    this.session = session;
    this.importer = importer;
    this.state = state;
    this.onAvrSnapshot = onAvrSnapshot;
    this.pollIntervalMs = pollIntervalMs;
    this.log = log;

    this.avrSnapshot = null;
    this.importedKeys = new Set();
    this.responseRetries = new Map();
    this.importWarnings = [];
    this.warnedNoLevelReference = false;
    this.sublevelActive = false;
    this.sublevelTask = null;
    this.resumeTask = null;
  }

  get api() {
    return this.bridgeSession.api;
  }

  assertState(expected, action) {
    const current = this.state.measureState;
    if (current !== expected) {
      throw new Error(`Cannot ${action} while the measurement state is "${current}"`);
    }
  }

  resetSessionState() {
    this.avrSnapshot = null;
    this.importedKeys.clear();
    this.responseRetries.clear();
    this.importWarnings = [];
    this.warnedNoLevelReference = false;
    this.sublevelActive = false;
    this.state.measureState = STATE_IDLE;
    this.state.measurePosition = null;
    this.state.measureProgress = 0;
    this.state.measurePhase = '';
    this.state.measureChannelPlan = [];
    this.state.measureMaxPositions = 0;
    this.state.measurePositionsDone = [];
    this.state.measureNextPosition = 1;
    this.state.measureWarnings = [];
    this.state.measureSwLvlMatch = false;
    this.state.sublevelSub = null;
    this.state.sublevelSpl = null;
  }

  // --- Session lifecycle ---------------------------------------------------

  /**
   * Opens the measurement session (ENTER_AUDY) and waits for `ready`.
   * The captured AVR snapshot is exposed through `onAvrSnapshot`.
   */
  async startSession() {
    this.assertState(STATE_IDLE, 'start a measurement session');
    this.bridgeSession.assertConnected();
    if (!this.session.state.isPolling) {
      throw new Error(
        'Please connect to REW first: measured responses are imported into REW',
      );
    }
    this.state.measureState = STATE_STARTING;
    try {
      const model = this.bridgeSession.state.avrModelName || null;
      await this.api.startMeasureSession(model);
      const view = await this.waitForSessionReady();
      this.installSessionSnapshot(view);
      this.state.measureState = STATE_READY;
      this.log.info(
        `Measurement session ready: ${this.state.measureChannelPlan.length} channel(s), ` +
          `up to ${this.state.measureMaxPositions} positions`,
      );
      await this.onAvrSnapshot(view.avr ?? null);
      return view;
    } catch (error) {
      this.resetSessionState();
      throw describeMeasureFailure(error);
    }
  }

  /**
   * Re-attaches to a measurement session still open on the bridge — page
   * reload while the AVR is held (`avrBusyReason` "measurement"). Restores
   * the snapshot, the plan and the measured positions, then resumes the
   * running activity (position sweep or sub level matching). The responses
   * the bridge already lists were imported into REW on the fly before the
   * reload (REW is not reset by a page reload) and are NOT re-imported.
   *
   * @returns {Promise<string|null>} the restored measurement state, or null
   *   when the bridge holds no session to re-attach.
   */
  async resumeSession() {
    if (this.state.measureState !== STATE_IDLE) return null;
    this.bridgeSession.assertConnected();
    let view;
    try {
      view = await this.api.getMeasureSession();
    } catch (error) {
      if (error?.code === 'NOT_FOUND') return null;
      throw describeMeasureFailure(error);
    }
    if (!view || SESSION_OVER_STATES.has(view.state) || view.state === 'completing') {
      return null;
    }
    if (view.state === 'starting') {
      view = await this.waitForSessionReady();
    }
    this.installSessionSnapshot(view);
    const alreadyImported = view.availableResponses ?? [];
    for (const available of alreadyImported) {
      this.importedKeys.add(`${available.position}:${available.channel}`);
    }
    if (alreadyImported.length > 0) {
      this.log.info(
        `${alreadyImported.length} measured response(s) kept as already imported into REW`,
      );
    }
    await this.onAvrSnapshot(view.avr ?? null);
    return this.resumeActivity(view);
  }

  /** Restores the UI state matching the bridge activity at re-attach time. */
  resumeActivity(view) {
    if (view.state === 'subleveling') {
      this.state.measureState = STATE_SUBLEVEL;
      this.sublevelActive = true;
      this.sublevelTask = this.runSublevelLoop().catch(error => {
        this.log.error(`Subwoofer level polling failed: ${error.message}`);
        this.clearSublevelState();
      });
      this.log.info('Re-attached to the running subwoofer level matching');
      return STATE_SUBLEVEL;
    }
    if (view.state === 'measuring' || view.state === 'cancelling') {
      const position = view.currentOperation?.position ?? runningPosition(view);
      if (position == null) {
        this.log.warn(
          'Running position unknown at re-attach: showing the session as ready',
        );
        this.state.measureState = STATE_READY;
        return STATE_READY;
      }
      this.state.measureState = STATE_MEASURING;
      this.state.measurePosition = position;
      this.resumeTask = this.resumePositionRun(position);
      this.log.info(`Re-attached to the running measurement of position ${position}`);
      return STATE_MEASURING;
    }
    this.state.measureState = STATE_READY;
    this.log.info('Re-attached to the open measurement session');
    return STATE_READY;
  }

  /** Self-driven continuation of a position sweep started before the reload. */
  async resumePositionRun(position) {
    try {
      await this.session.setProcessing(true);
      try {
        await this.runPositionLoop(position);
      } finally {
        await this.session.setProcessing(false);
      }
    } catch (error) {
      if (this.state.measureState === STATE_MEASURING) {
        this.state.measureState = STATE_READY;
      }
      this.log.error(`Resumed position ${position} failed: ${error.message}`);
    }
  }

  async waitForSessionReady() {
    let failures = 0;
    for (let attempt = 0; attempt < BridgeMeasurement.START_POLL_LIMIT; attempt++) {
      let view = null;
      try {
        view = await this.api.getMeasureSession();
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= BridgeMeasurement.POLL_FAILURE_LIMIT) throw error;
      }
      if (view) {
        if (view.state === 'ready') return view;
        if (SESSION_OVER_STATES.has(view.state)) {
          throw new Error(
            `Measurement session ${view.state}: ${view.lastError?.message ?? 'see the bridge logs'}`,
          );
        }
      }
      await waitMs(this.pollIntervalMs);
    }
    throw new Error('Timed out waiting for the measurement session to become ready');
  }

  installSessionSnapshot(view) {
    this.avrSnapshot = view.avr ?? null;
    this.importedKeys.clear();
    this.responseRetries.clear();
    this.importWarnings = [];
    this.warnedNoLevelReference = false;
    this.state.measureChannelPlan = (view.channelPlan ?? []).map(entry => ({
      channel: entry.channel,
      code: entry.code,
      commandId: commandIdForPlanEntry(entry),
      isSub: Boolean(entry.isSub),
    }));
    this.state.measureMaxPositions = view.avr?.maxPositions ?? 0;
    this.state.measureSwLvlMatch = view.avr?.swLvlMatch === true;
    this.refreshFromView(view);
  }

  refreshFromView(view) {
    const operation = view.currentOperation ?? null;
    const progress = Math.min(1, Math.max(0, operation?.progress ?? 0));
    this.state.measureProgress = Math.round(progress * 100);
    this.state.measurePhase = operation?.phase ?? '';
    const done = Object.entries(view.positions ?? {})
      .filter(([, position]) => position?.state === 'done')
      .map(([number]) => Number(number))
      .sort((a, b) => a - b);
    this.state.measurePositionsDone = done;
    this.state.measureNextPosition = nextPosition(done, this.state.measureMaxPositions);
    this.state.measureWarnings = [
      ...describeSessionWarnings(view),
      ...this.importWarnings,
    ];
  }

  // --- Position measurement ------------------------------------------------

  /**
   * Measures one position (position 1 = detection, full plan enforced;
   * positions >= 2 accept a subset of WIRE channel codes). Every impulse
   * response is imported into REW as soon as the bridge lists it. Runs under
   * the app processing lock so the REW/bridge pollers stay out of the way.
   *
   * @returns {Promise<{state: 'done'|'cancelled', position?: number}>}
   */
  async measurePosition(position, channels = null) {
    this.assertState(STATE_READY, 'measure a position');
    if (!Number.isInteger(position) || position < 1) {
      throw new Error(`Invalid measurement position: ${position}`);
    }
    if (position === 1 && channels != null) {
      throw new Error(
        'Position 1 is the detection pass: the full channel plan is measured',
      );
    }
    if (position >= 2 && channels != null && channels.length === 0) {
      throw new Error('Select at least one channel to measure');
    }

    this.state.measureState = STATE_MEASURING;
    this.state.measurePosition = position;
    this.state.measureProgress = 0;
    this.state.measurePhase = '';
    try {
      await this.session.setProcessing(true);
      try {
        await this.api.startMeasurePosition(position, channels ?? null);
        return await this.runPositionLoop(position);
      } finally {
        await this.session.setProcessing(false);
      }
    } catch (error) {
      if (this.state.measureState === STATE_MEASURING) {
        // The bridge session itself is still open: stay usable.
        this.state.measureState = STATE_READY;
      }
      throw describeMeasureFailure(error);
    }
  }

  async runPositionLoop(position) {
    let failures = 0;
    for (;;) {
      await waitMs(this.pollIntervalMs);
      let view;
      try {
        view = await this.api.getMeasureSession();
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= BridgeMeasurement.POLL_FAILURE_LIMIT) throw error;
        continue;
      }
      this.refreshFromView(view);
      await this.importNewResponses(view);

      if (SESSION_OVER_STATES.has(view.state)) {
        return this.finishEndedSession(view);
      }
      const positionView = view.positions?.[position];
      if (positionView && POSITION_TERMINAL_STATES.has(positionView.state)) {
        return this.finishPosition(position, positionView);
      }
    }
  }

  finishEndedSession(view) {
    this.resetSessionState();
    if (view.state === 'cancelled') {
      this.log.info('Measurement session cancelled');
      return { state: 'cancelled' };
    }
    throw new Error(
      `Measurement session ${view.state}: ${view.lastError?.message ?? 'see the bridge logs'}`,
    );
  }

  finishPosition(position, positionView) {
    this.state.measureState = STATE_READY;
    this.state.measurePhase = '';
    if (positionView.state === 'failed') {
      throw new Error(
        `Position ${position} failed: ${positionView.error?.message ?? positionView.error ?? 'unknown error'}`,
      );
    }
    if (positionView.state === 'cancelled') {
      this.log.info(`Position ${position} cancelled`);
      return { state: 'cancelled', position };
    }
    this.state.measureProgress = 100;
    this.log.info(`Position ${position} measured`);
    return { state: 'done', position };
  }

  // --- Impulse-response import (differential, on the fly) ------------------

  async importNewResponses(view) {
    for (const available of view.availableResponses ?? []) {
      const key = `${available.position}:${available.channel}`;
      if (this.importedKeys.has(key)) continue;
      await this.importOneResponse(available, key);
    }
  }

  async importOneResponse({ position, channel }, key) {
    const entry = this.state.measureChannelPlan.find(
      candidate => candidate.code === channel,
    );
    const commandId = entry?.commandId ?? normalizeChannelCode(channel);
    const title = measurementTitle(commandId, position);
    try {
      // `channel` is the WIRE code from availableResponses (e.g. SWMIX1) —
      // required verbatim by GET /measure/response.
      const response = await this.api.getMeasureResponse(position, channel);
      const samples = decodeBase64ToFloat32(response.samples, true);
      await this.importer.importImpulseResponse(
        this.session,
        { name: title, data: samples },
        {
          sampleRate: response.sampleRateHz ?? MEASUREMENT_SAMPLE_RATE,
          splOffset: this.resolveSplOffset(response),
        },
      );
      this.importedKeys.add(key);
      if (response.plausibilityWarning) {
        this.addImportWarning(`${title}: the AVR flagged this response as implausible`);
      }
      this.log.info(`Imported ${title} into REW`);
    } catch (error) {
      this.trackImportFailure(key, title, error);
    }
  }

  trackImportFailure(key, title, error) {
    const retries = (this.responseRetries.get(key) ?? 0) + 1;
    this.responseRetries.set(key, retries);
    if (retries >= BridgeMeasurement.RESPONSE_RETRY_LIMIT) {
      // Stop retrying: the sweep itself succeeded, surface the gap loudly.
      this.importedKeys.add(key);
      this.addImportWarning(`${title}: import failed (${error.message})`);
      this.log.error(
        `Import of ${title} failed after ${retries} attempts: ${error.message}`,
      );
    } else {
      this.log.warn(`Import of ${title} failed (attempt ${retries}): ${error.message}`);
    }
  }

  resolveSplOffset(response) {
    const absolute =
      response.levelReference?.dbSplAtFullScale ??
      this.avrSnapshot?.levelReference?.dbSplAtFullScale;
    if (typeof absolute === 'number' && Number.isFinite(absolute)) {
      return absolute;
    }
    if (!this.warnedNoLevelReference) {
      this.warnedNoLevelReference = true;
      this.log.warn(
        `No absolute SPL reference from the AVR: importing at ${DEFAULT_SPL_OFFSET_DB} dB full-scale`,
      );
    }
    return DEFAULT_SPL_OFFSET_DB;
  }

  addImportWarning(message) {
    this.importWarnings.push(message);
    this.state.measureWarnings = [...this.state.measureWarnings, message];
  }

  // --- Subwoofer level matching (one sub at a time) ------------------------

  async startSublevel(subCommandId) {
    this.assertState(STATE_READY, 'start subwoofer level matching');
    this.state.measureState = STATE_SUBLEVEL;
    this.state.sublevelSub = subCommandId ?? null;
    this.state.sublevelSpl = null;
    try {
      await this.api.startSublevel(subCommandId ?? null);
    } catch (error) {
      this.state.measureState = STATE_READY;
      this.state.sublevelSub = null;
      throw describeMeasureFailure(error);
    }
    this.sublevelActive = true;
    this.sublevelTask = this.runSublevelLoop().catch(error => {
      this.log.error(`Subwoofer level polling failed: ${error.message}`);
      this.clearSublevelState();
    });
  }

  async runSublevelLoop() {
    let failures = 0;
    while (this.sublevelActive) {
      await waitMs(this.pollIntervalMs);
      if (!this.sublevelActive) return;
      const outcome = await this.pollSublevelOnce(failures);
      failures = outcome.failures;
      if (outcome.action === 'abort') {
        return this.abortSublevel({ quiet: outcome.quiet });
      }
    }
  }

  /** One sublevel poll tick: updates the live SPL and decides the loop fate. */
  async pollSublevelOnce(failures) {
    let status;
    try {
      status = await this.api.getSublevel();
    } catch (error) {
      const next = failures + 1;
      if (next < BridgeMeasurement.POLL_FAILURE_LIMIT) {
        return { failures: next, action: 'poll' };
      }
      this.log.warn(`Subwoofer level polling failed: ${error.message}`);
      return { failures: next, action: 'abort', quiet: false };
    }
    if (this.sublevelActive && typeof status.spl === 'number') {
      this.state.sublevelSpl = status.spl;
    }
    // Re-attached routine: the measured sub is only known from the poll.
    if (this.sublevelActive && status.sub && !this.state.sublevelSub) {
      this.state.sublevelSub = status.sub;
    }
    if (status.state === 'error') {
      this.log.warn(`Subwoofer level matching error: ${status.error ?? 'unknown'}`);
      return { failures: 0, action: 'abort', quiet: false };
    }
    if (status.state === 'stopped') {
      return { failures: 0, action: 'abort', quiet: true };
    }
    return { failures: 0, action: 'poll' };
  }

  /** Loop-side exit: releases the routine and puts the session back to ready. */
  async abortSublevel({ quiet = false } = {}) {
    this.sublevelActive = false;
    try {
      await this.api.stopSublevel();
    } catch (error) {
      if (!quiet) {
        this.log.warn(`Could not stop the sub level routine: ${error.message}`);
      }
    }
    this.clearSublevelState();
  }

  clearSublevelState() {
    if (this.state.measureState === STATE_SUBLEVEL) {
      this.state.measureState = STATE_READY;
    }
    this.state.sublevelSub = null;
    this.state.sublevelSpl = null;
  }

  async stopSublevel() {
    this.assertState(STATE_SUBLEVEL, 'stop subwoofer level matching');
    this.sublevelActive = false;
    if (this.sublevelTask) {
      await this.sublevelTask;
      this.sublevelTask = null;
    }
    try {
      await this.api.stopSublevel();
    } catch (error) {
      this.log.warn(`Sub level stop reported: ${error.message}`);
    }
    this.clearSublevelState();
  }

  // --- Completion / cancellation -------------------------------------------

  /**
   * Normal completion (EXIT_AUDMD). Always ends the session; `exitOk: false`
   * means the AVR should be power-cycled (surfaced by the caller).
   */
  async complete() {
    this.assertState(STATE_READY, 'complete the measurement session');
    this.state.measureState = STATE_COMPLETING;
    let result;
    try {
      result = await this.api.completeMeasureSession();
    } catch (error) {
      this.state.measureState = STATE_READY;
      throw describeMeasureFailure(error);
    }
    this.resetSessionState();
    if (result.exitOk === false) {
      this.log.warn(
        'The AVR did not exit calibration mode cleanly: power-cycle the AVR before the next operation',
      );
    } else {
      this.log.info('Measurement session completed');
    }
    return result;
  }

  /**
   * Cancels the session — accepted at any moment, including mid-sweep. A
   * running position loop observes the cancelled session itself and resets
   * the state; otherwise the reset happens here.
   */
  async cancel() {
    if (this.state.measureState === STATE_IDLE) {
      throw new Error('No measurement session to cancel');
    }
    this.sublevelActive = false;
    if (this.sublevelTask) {
      await this.sublevelTask;
      this.sublevelTask = null;
    }
    try {
      await this.api.cancelMeasureSession();
    } catch (error) {
      if (error?.code !== 'NOT_FOUND') {
        throw describeMeasureFailure(error);
      }
    }
    if (this.state.measureState !== STATE_MEASURING) {
      this.resetSessionState();
    }
    this.log.info('Measurement session cancel requested');
  }
}

function createBridgeMeasurement(deps) {
  return new BridgeMeasurement(deps);
}

export { BridgeMeasurement, createBridgeMeasurement };
