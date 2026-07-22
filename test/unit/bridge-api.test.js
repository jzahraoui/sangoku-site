import { afterEach, describe, expect, it, vi } from 'vitest';
import BridgeApi, { BridgeApiError } from '../../src/bridge/bridge-api.js';

const originalFetch = globalThis.fetch;

function jsonResponse(data, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: vi.fn().mockResolvedValue(data),
  };
}

function errorResponse(payload, { status = 500, statusText = 'Server Error' } = {}) {
  return {
    ok: false,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(payload),
  };
}

function stubFetch(response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  globalThis.fetch = fetchMock;
  return fetchMock;
}

describe('BridgeApi', () => {
  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete globalThis.fetch;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Construction / base URL
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('defaults to the bridge loopback base URL', () => {
      expect(new BridgeApi().baseURL).toBe('http://127.0.0.1:7735');
    });

    it('normalizes a custom base URL', () => {
      const api = new BridgeApi('  http://127.0.0.1:8080///  ');
      expect(api.baseURL).toBe('http://127.0.0.1:8080');
    });
  });

  // ---------------------------------------------------------------------------
  // request
  // ---------------------------------------------------------------------------
  describe('request', () => {
    it('sends GET with Accept header and the loopback target address space', async () => {
      const fetchMock = stubFetch(jsonResponse({ status: 'ready' }));
      const api = new BridgeApi();

      await api.request('/health');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:7735/health',
        expect.objectContaining({
          method: 'GET',
          targetAddressSpace: 'loopback',
          headers: expect.objectContaining({ Accept: 'application/json' }),
        }),
      );
    });

    it('serializes the body and sets Content-Type on POST', async () => {
      const fetchMock = stubFetch(jsonResponse({ registered: true }));
      const api = new BridgeApi();

      await api.request('/avr/register', 'POST', { ip: '192.168.1.10' });

      const [, options] = fetchMock.mock.calls[0];
      expect(options.body).toBe('{"ip":"192.168.1.10"}');
      expect(options.headers['Content-Type']).toBe('application/json');
    });

    it('returns the parsed payload on success', async () => {
      stubFetch(jsonResponse({ status: 'ready', version: '1.0.0' }));

      await expect(new BridgeApi().request('/health')).resolves.toEqual({
        status: 'ready',
        version: '1.0.0',
      });
    });

    it('resolves an empty object on 204 responses', async () => {
      stubFetch({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: vi.fn().mockRejectedValue(new Error('no body')),
      });

      await expect(new BridgeApi().request('/health')).resolves.toEqual({});
    });

    it('maps the bridge error envelope to a typed BridgeApiError', async () => {
      stubFetch(
        errorResponse(
          { error: 'BUSY', message: 'AVR busy', reason: 'measurement' },
          { status: 409, statusText: 'Conflict' },
        ),
      );

      const failure = await new BridgeApi()
        .request('/avr/status')
        .catch(error => error);

      expect(failure).toBeInstanceOf(BridgeApiError);
      expect(failure.status).toBe(409);
      expect(failure.code).toBe('BUSY');
      expect(failure.reason).toBe('measurement');
      expect(failure.message).toBe('[409] AVR busy');
      expect(failure.isBusy).toBe(true);
      expect(BridgeApi.isBusy(failure)).toBe(true);
    });

    it('keeps the envelope details on validation errors', async () => {
      stubFetch(
        errorResponse(
          { error: 'INVALID_FILTER_LENGTH', details: { channel: 'FL' } },
          { status: 400, statusText: 'Bad Request' },
        ),
      );

      const failure = await new BridgeApi()
        .request('/transfer', 'POST', {})
        .catch(error => error);

      expect(failure.code).toBe('INVALID_FILTER_LENGTH');
      expect(failure.details).toEqual({ channel: 'FL' });
      expect(failure.isBusy).toBe(false);
    });

    it('falls back to the HTTP status text when the error body is not JSON', async () => {
      stubFetch({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: vi.fn().mockRejectedValue(new Error('not json')),
      });

      const failure = await new BridgeApi().request('/health').catch(error => error);

      expect(failure).toBeInstanceOf(BridgeApiError);
      expect(failure.status).toBe(502);
      expect(failure.code).toBeNull();
      expect(failure.message).toBe('[502] Bad Gateway');
    });

    it('rejects a 200 response without a JSON body', async () => {
      stubFetch({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockRejectedValue(new Error('not json')),
      });

      const failure = await new BridgeApi().request('/health').catch(error => error);

      expect(failure).toBeInstanceOf(BridgeApiError);
      expect(failure.message).toContain('Invalid JSON response');
    });

    it('maps aborts to a client timeout error', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      const failure = await new BridgeApi().request('/health').catch(error => error);

      expect(failure).toBeInstanceOf(BridgeApiError);
      expect(failure.code).toBe('TIMEOUT_CLIENT');
      expect(failure.message).toContain('/health');
    });

    it('describes plain network failures with the base URL', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const failure = await new BridgeApi().request('/health').catch(error => error);

      expect(failure).toBeInstanceOf(BridgeApiError);
      expect(failure.code).toBe('NETWORK');
      expect(failure.message).toContain('http://127.0.0.1:7735');
      expect(failure.cause).toBeInstanceOf(TypeError);
    });

    it('explains the WebKit https limitation on Safari', async () => {
      vi.stubGlobal('navigator', { vendor: 'Apple Computer, Inc.' });
      vi.stubGlobal('location', { protocol: 'https:' });
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const failure = await new BridgeApi().request('/health').catch(error => error);

      expect(failure.message).toContain('Safari');
      expect(failure.message).toContain('Chrome, Edge or Firefox');
    });

    it('hints at the local network permission on Chromium', async () => {
      vi.stubGlobal('navigator', {
        vendor: 'Google Inc.',
        userAgentData: { brands: [] },
      });
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

      const failure = await new BridgeApi().request('/health').catch(error => error);

      expect(failure.message).toContain('local network');
    });
  });

  // ---------------------------------------------------------------------------
  // Version gate
  // ---------------------------------------------------------------------------
  describe('checkVersion', () => {
    it('resolves with the bridge version when supported', async () => {
      stubFetch(jsonResponse({ status: 'ready', version: '9.9.9' }));

      await expect(new BridgeApi().checkVersion()).resolves.toBe('9.9.9');
    });

    it('accepts the exact minimum version', async () => {
      stubFetch(
        jsonResponse({ status: 'ready', version: BridgeApi.MIN_BRIDGE_VERSION }),
      );

      await expect(new BridgeApi().checkVersion()).resolves.toBe(
        BridgeApi.MIN_BRIDGE_VERSION,
      );
    });

    it('rejects an outdated bridge with an actionable message', async () => {
      stubFetch(jsonResponse({ status: 'ready', version: '0.0.1' }));

      const failure = await new BridgeApi().checkVersion().catch(error => error);

      expect(failure).toBeInstanceOf(BridgeApiError);
      expect(failure.code).toBe('VERSION_TOO_OLD');
      expect(failure.message).toContain(BridgeApi.MIN_BRIDGE_VERSION);
    });

    it('rejects when the health payload has no parsable version', async () => {
      stubFetch(jsonResponse({ status: 'ready' }));

      const failure = await new BridgeApi().checkVersion().catch(error => error);

      expect(failure.code).toBe('VERSION_TOO_OLD');
      expect(failure.message).toContain('unknown');
    });
  });

  describe('compareVersions', () => {
    it.each([
      ['1.0.0', '1.0.0', 0],
      ['1.2.3', '1.2.2', 1],
      ['1.2.3', '1.3.0', -1],
      ['2.0.0', '1.9.9', 1],
    ])('compares %s to %s', (left, right, expected) => {
      const result = BridgeApi.compareVersions(left, right);
      expect(Math.sign(result)).toBe(Math.sign(expected));
    });

    it('returns null on unparsable input', () => {
      expect(BridgeApi.compareVersions('abc', '1.0.0')).toBeNull();
      expect(BridgeApi.parseSemver('v1')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Endpoint wrappers
  // ---------------------------------------------------------------------------
  describe('endpoint wrappers', () => {
    it('rejects an invalid AVR IP before any request', async () => {
      const fetchMock = stubFetch(jsonResponse({}));

      await expect(new BridgeApi().registerAvr('999.1.2.3')).rejects.toThrow(
        TypeError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('registers an AVR with an optional model', async () => {
      const fetchMock = stubFetch(jsonResponse({ registered: true }));
      const api = new BridgeApi();

      await api.registerAvr('192.168.1.10');
      await api.registerAvr('192.168.1.10', 'Denon AVR-X3800H');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        ip: '192.168.1.10',
      });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        ip: '192.168.1.10',
        model: 'Denon AVR-X3800H',
      });
    });

    it('builds the measurement response query with encoding and raw flag', async () => {
      const fetchMock = stubFetch(jsonResponse({ samples: '' }));
      const api = new BridgeApi();

      await api.getMeasureResponse(2, 'FL');
      await api.getMeasureResponse(1, 'SWMIX 1', true);

      expect(fetchMock.mock.calls[0][0]).toBe(
        'http://127.0.0.1:7735/measure/response?position=2&channel=FL',
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        'http://127.0.0.1:7735/measure/response?position=1&channel=SWMIX+1&raw=true',
      );
    });

    it('keeps a zero sub index in the sublevel body', async () => {
      const fetchMock = stubFetch(jsonResponse({ state: 'subleveling' }));
      const api = new BridgeApi();

      await api.startSublevel(0);
      await api.startSublevel();

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ sub: 0 });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({});
    });

    it.each([
      ['unregisterAvr', [], 'DELETE', '/avr/register'],
      ['discoverAvrs', [], 'POST', '/avr/discover'],
      ['setZoneMain', ['on'], 'POST', '/avr/zonemain'],
      ['setPreset', [2], 'POST', '/avr/preset'],
      ['getTransfer', [], 'GET', '/transfer'],
      ['cancelTransfer', [], 'DELETE', '/transfer'],
      ['startMeasureSession', [], 'POST', '/measure/session'],
      ['completeMeasureSession', [], 'POST', '/measure/session/complete'],
      ['cancelMeasureSession', [], 'DELETE', '/measure/session'],
      ['stopSublevel', [], 'DELETE', '/measure/sublevel'],
      ['shutdown', [], 'POST', '/shutdown'],
      ['resetBridge', [], 'POST', '/reset'],
    ])('%s targets %s %s', async (methodName, args, httpMethod, path) => {
      const fetchMock = stubFetch(jsonResponse({}));
      const api = new BridgeApi();

      await api[methodName](...args);

      expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:7735${path}`);
      expect(fetchMock.mock.calls[0][1].method).toBe(httpMethod);
    });
  });
});
