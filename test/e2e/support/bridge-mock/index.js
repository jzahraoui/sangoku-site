const BRIDGE_PORT = '7735';

const DEFAULT_AVR = Object.freeze({
  ip: '192.168.1.99',
  model: 'Denon AVR-X3800H',
});

// GET_AVRINF payload of an XT32/Float model (shape from the bridge
// api-reference: Ifver, DType, EQType, CoefWaitTime).
const DEFAULT_INFO = Object.freeze({
  Ifver: '00.08',
  DType: 'Float',
  EQType: 'MultEQXT32',
  CoefWaitTime: { Init: 0, Final: 0 },
});

// GET_AVRSTS payload (raw AVR status): speaker setup, amp assignment.
const DEFAULT_STATUS = Object.freeze({
  Ifver: '00.08',
  AmpAssign: 'Normal',
  AssignBin: 'QVNTSUdOQklOLU1PQ0s=',
  ChSetup: [
    { FL: 'S' },
    { FR: 'S' },
    { C: 'S' },
    { SW1: 'E' },
    { SLA: 'S' },
    { SRA: 'S' },
  ],
  SWSetup: { SWNum: 1, SWMode: 'Standard' },
  SpPreset: '1',
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
