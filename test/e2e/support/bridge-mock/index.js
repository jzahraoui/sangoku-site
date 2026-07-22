const BRIDGE_PORT = '7735';

// Aligned with the e2e fixture `sample.ady` (Denon AVC-A1H, XT32,
// enAmpAssignType 6 = '2chBiAmp', 2 directional subs, channels
// FL/C/FR/SW1/SW2) so the live-synthesized jsonAvrData matches the
// measurements the journeys import.
const DEFAULT_AVR = Object.freeze({
  ip: '192.168.1.99',
  model: 'Denon AVC-A1H',
});

// GET_AVRINF payload of an XT32/Float model (shape from the bridge
// api-reference: Ifver, DType, EQType, CoefWaitTime).
const DEFAULT_INFO = Object.freeze({
  Ifver: '00.08',
  DType: 'Float',
  EQType: 'MultEQXT32',
  CoefWaitTime: { Init: 0, Final: 0 },
});

// GET_AVRSTS payload (raw AVR status): speaker setup, amp assignment
// (shape from the bridge data-model.md § AVRStatus).
const DEFAULT_STATUS = Object.freeze({
  HPPlug: false,
  Mic: false,
  AmpAssign: '2chBiAmp',
  AssignBin:
    '040401020001000002000000080000000000000000000000000000000208000808100001020304070900000100' +
    '01070000',
  ChSetup: [
    { FL: 'S' },
    { C: 'S' },
    { FR: 'S' },
    { SWMIX1: 'E' },
    { SWMIX2: 'E' },
  ],
  BTTXStatus: false,
  SpPreset: '1',
  SWSetup: { SWNum: 2, SWMode: 'Directional', SWLayout: 'FL/FR/RL/RR' },
});

/**
 * Stateful RCH Bridge test double attached to a Playwright page via
 * `page.route()`. Every request whose URL targets port 7735 is served
 * in-process; unknown routes answer 404 and are recorded so the journeys
 * can fail fast on unexpected traffic. Same architecture as the REW mock
 * (docs/reverse/02-rew-mock.md).
 *
 * Options:
 * - `registered` (default true): whether an AVR is pre-registered, like a
 *   bridge restarted with a persisted `state.json`.
 * - `busyReason` (null | 'measurement' | 'transfer'): makes the AVR-bound
 *   endpoints answer `409 BUSY` to exercise the busy semantics.
 */
class BridgeMock {
  constructor({
    registered = true,
    ip = DEFAULT_AVR.ip,
    model = DEFAULT_AVR.model,
    version = '1.0.0',
    busyReason = null,
    info = DEFAULT_INFO,
    status = DEFAULT_STATUS,
    // Nombre de polls "in-progress" avant completed (fenetre d'annulation).
    transferSteps = 2,
  } = {}) {
    this.state = {
      registered,
      ip: registered ? ip : null,
      model,
      version,
      busyReason,
      zoneMain: 'on',
      preset: 1,
    };
    this.info = info;
    this.status = status;
    // Transfert scripte : chaque GET /transfer avance d'un cran.
    this.transferSteps = transferSteps;
    this.transfer = { state: 'idle', script: null, step: 0, archive: null };
    this.lastArchive = null;
    this.discoverResults = [{ ip: DEFAULT_AVR.ip, name: DEFAULT_AVR.model, model: DEFAULT_AVR.model }];
    this.unknownRequests = [];
    this.errors = [];
    this.trace = [];
    this.traceLimit = 200;
  }

  record(entry) {
    this.trace.push(entry);
    if (this.trace.length > this.traceLimit) this.trace.shift();
  }

  async attach(page) {
    await page.route(
      url => url.port === BRIDGE_PORT,
      async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const body = parseBody(request.postData());

        let response;
        try {
          response = this.dispatch(method, url.pathname, url.searchParams, body);
        } catch (error) {
          this.errors.push({ method, path: url.pathname, error: error.message });
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'MOCK_FAILURE', message: error.message }),
          });
          return;
        }

        if (response === undefined) {
          this.unknownRequests.push(`${method} ${url.pathname}`);
          await route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'NOT_FOUND',
              message: `Not implemented in bridge mock: ${method} ${url.pathname}`,
            }),
          });
          return;
        }

        const status = response?.__status ?? 200;
        if (response?.__status) delete response.__status;
        if (!(method === 'GET' && url.pathname === '/health')) {
          this.record({
            method,
            path: url.pathname,
            body,
            response,
          });
        }
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      },
    );
  }

  busyEnvelope() {
    return {
      __status: 409,
      error: 'BUSY',
      message: `AVR held by an active ${this.state.busyReason}`,
      reason: this.state.busyReason,
    };
  }

  requireRegistered() {
    if (this.state.registered) return null;
    return {
      __status: 400,
      error: 'NO_AVR_REGISTERED',
      message: 'No AVR registered - call POST /avr/register first',
    };
  }

  handleRegister(body) {
    if (this.state.busyReason === 'measurement') return this.busyEnvelope();
    this.state.registered = true;
    this.state.ip = body?.ip ?? this.state.ip;
    if (body?.model) this.state.model = body.model;
    return { registered: true, ip: this.state.ip };
  }

  handleUnregister() {
    if (this.state.busyReason === 'measurement') return this.busyEnvelope();
    this.state.registered = false;
    this.state.ip = null;
    return { unregistered: true };
  }

  handleAvrRead(payloadKey, payload) {
    if (!this.state.registered) return this.requireRegistered();
    if (this.state.busyReason) return this.busyEnvelope();
    return { ip: this.state.ip, [payloadKey]: payload };
  }

  handleZoneMain(body) {
    if (this.state.busyReason) return this.busyEnvelope();
    this.state.zoneMain = body?.state === 'off' ? 'off' : 'on';
    return { success: true, state: this.state.zoneMain };
  }

  handlePreset(body) {
    if (this.state.busyReason) return this.busyEnvelope();
    this.state.preset = body?.preset ?? this.state.preset;
    return { supported: true, preset: this.state.preset, success: true };
  }

  handleValidate(body) {
    if (!this.state.registered) return this.requireRegistered();
    this.lastArchive = body;
    return { ip: this.state.ip, valid: true, report: { checked: true } };
  }

  handleTransferStart(body) {
    if (!this.state.registered) return this.requireRegistered();
    if (this.transfer.state === 'in-progress') {
      return { __status: 409, error: 'BUSY', message: 'transfer already running' };
    }
    this.lastArchive = body;
    const channelCount = body?.channels?.length ?? 0;
    const inProgress = Array.from({ length: this.transferSteps }, (_, index) => ({
      state: 'in-progress',
      phase: index === 0 ? 'SET_SETDAT' : 'SET_COEFDT',
      progress: Math.round(((index + 1) / (this.transferSteps + 1)) * 100),
      currentChannel: body?.channels?.[index % Math.max(1, channelCount)]?.commandId ?? null,
    }));
    this.transfer = {
      state: 'in-progress',
      step: 0,
      archive: body,
      script: [
        ...inProgress,
        {
          state: 'completed',
          phase: 'DONE',
          progress: 100,
          succeededChannels: (body?.channels ?? []).map(channel => channel.commandId),
          failedChannels: [],
        },
      ],
    };
    return {
      __status: 202,
      transferId: 'mock-transfer-1',
      state: 'in-progress',
      totalChannels: channelCount,
    };
  }

  handleTransferStatus() {
    const { script } = this.transfer;
    if (!script) {
      return { state: this.transfer.state, transferId: 'mock-transfer-1' };
    }
    const status = script[Math.min(this.transfer.step, script.length - 1)];
    this.transfer.step += 1;
    if (status.state !== 'in-progress') {
      this.transfer.state = status.state;
    }
    return { transferId: 'mock-transfer-1', ...status };
  }

  handleTransferCancel() {
    if (this.transfer.state !== 'in-progress') {
      return { cancelled: false, reason: 'no_transfer_active' };
    }
    // L'annulation reste differee d'un poll (FINZ) puis termine en cancelled.
    this.transfer.script = [
      { state: 'in-progress', phase: 'FINZ_COEFS', progress: 95 },
      { state: 'cancelled', phase: 'EXIT_AUDMD', progress: 95, cancelled: true },
    ];
    this.transfer.step = 0;
    return { transferId: 'mock-transfer-1', cancelled: true, reason: 'user_request' };
  }

  dispatch(method, pathname, searchParams, body) {
    const key = `${method} ${pathname}`;
    switch (key) {
      case 'GET /health':
        return { status: 'ready', version: this.state.version };
      case 'GET /avr/current':
        return { ip: this.state.ip, registered: this.state.registered };
      case 'POST /avr/register':
        return this.handleRegister(body);
      case 'DELETE /avr/register':
        return this.handleUnregister();
      case 'GET /avr/info':
        return this.handleAvrRead('info', this.info);
      case 'GET /avr/status':
        return this.handleAvrRead('status', this.status);
      case 'POST /avr/discover':
        return { avrs: this.discoverResults };
      case 'GET /avr/zonemain':
        return { state: this.state.zoneMain };
      case 'POST /avr/zonemain':
        return this.handleZoneMain(body);
      case 'GET /avr/preset':
        return { preset: this.state.preset, supported: true };
      case 'POST /avr/preset':
        return this.handlePreset(body);
      case 'POST /avr/validate':
        return this.handleValidate(body);
      case 'POST /transfer':
        return this.handleTransferStart(body);
      case 'GET /transfer':
        return this.handleTransferStatus();
      case 'DELETE /transfer':
        return this.handleTransferCancel();
      case 'POST /reset':
        return { reset: true };
      case 'POST /shutdown':
        return { status: 'stopping' };
      default:
        return undefined;
    }
  }
}

function parseBody(postData) {
  if (!postData) return null;
  try {
    return JSON.parse(postData);
  } catch {
    return postData;
  }
}

export { BridgeMock };
