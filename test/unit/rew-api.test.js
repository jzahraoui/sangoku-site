import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RewApi from '../../src/rew/rew-api.js';

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const originalFetch = globalThis.fetch;
const windowsHost = getWindowsHostIP();
const baseUrl = `http://${windowsHost}:4735`;

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

/**
 * Détecte automatiquement l'IP de l'hôte Windows depuis WSL
 * @returns {string} L'adresse IP de l'hôte Windows
 */
export function getWindowsHostIP() {
  if (process.env.WINDOWS_HOST) {
    return process.env.WINDOWS_HOST;
  }

  try {
    const isWSL = readFileSync('/proc/version', 'utf-8')
      .toLowerCase()
      .includes('microsoft');
    if (isWSL) {
      const result = execSync("ip route show | grep -i default | awk '{ print $3}'", {
        encoding: 'utf-8',
      }).trim();
      if (result) {
        console.log(`🔗 WSL détecté - IP Windows hôte: ${result}`);
        return result;
      }
    }
  } catch {
    // Pas dans WSL ou erreur de détection
  }

  console.log('🔗 Utilisation de localhost pour REW API');
  return '127.0.0.1';
}

describe('RewApi', () => {
  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    } else {
      delete globalThis.fetch;
    }
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Construction / base URL handling
  // ---------------------------------------------------------------------------
  describe('setBaseURL', () => {
    it('trims whitespace and trailing slashes from the base URL', () => {
      const api = new RewApi('  http://localhost:4735///  ');
      expect(api.baseURL).toBe('http://localhost:4735');
    });

    it('strips query string and hash from the base URL', () => {
      const api = new RewApi('http://localhost:4735/?foo=1#bar');
      expect(api.baseURL).toBe('http://localhost:4735');
    });

    it('rejects non-string, empty, malformed, non-HTTP and credentialed base URLs', () => {
      expect(() => new RewApi(null)).toThrow(TypeError);
      expect(() => new RewApi(42)).toThrow(TypeError);
      expect(() => new RewApi('   ')).toThrow(/Base URL is required/);
      expect(() => new RewApi('not a url')).toThrow(/Invalid base URL/);
      expect(() => new RewApi('ftp://localhost:4735')).toThrow(/HTTP or HTTPS/);
      expect(() => new RewApi('http://user:pass@localhost:4735')).toThrow(
        /must not include credentials/,
      );
    });

    it('preserves explicit https base URLs', () => {
      const api = new RewApi('https://rew.example.test:8443/');
      expect(api.baseURL).toBe('https://rew.example.test:8443');
    });
  });

  // ---------------------------------------------------------------------------
  // Endpoint validation
  // ---------------------------------------------------------------------------
  describe('endpoint validation', () => {
    it('rejects absolute, protocol-relative, missing or non-string endpoints', () => {
      const api = new RewApi(baseUrl);

      expect(() => api.getRequestUrl('http://example.test/version')).toThrow(
        /relative API path/,
      );
      expect(() => api.getRequestUrl('//example.test/version')).toThrow(
        /relative API path/,
      );
      expect(() => api.getRequestUrl('version')).toThrow(/relative API path/);
      expect(() => api.getRequestUrl('')).toThrow(/Missing endpoint/);
      expect(() => api.getRequestUrl(undefined)).toThrow(/Missing endpoint/);
      expect(() => RewApi.getEndpointPath(123)).toThrow(TypeError);
    });

    it('preserves query strings in the final URL while validating only the path part', () => {
      const api = new RewApi(baseUrl);
      expect(api.getRequestUrl('/measurements?id=1')).toBe(
        `${baseUrl}/measurements?id=1`,
      );
      expect(RewApi.getEndpointPath('/measurements?id=1')).toBe('/measurements');
    });
  });

  // ---------------------------------------------------------------------------
  // request() — HTTP wiring, body handling, error parsing
  // ---------------------------------------------------------------------------
  describe('request()', () => {
    let api;
    beforeEach(() => {
      api = new RewApi(baseUrl);
      vi.spyOn(api, 'getSpeedDelay').mockReturnValue(0);
    });

    it('normalizes method case and sends JSON body for write methods', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
      globalThis.fetch = fetchMock;

      await api.request('/application/logging', 'post', true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`${baseUrl}/application/logging`);
      expect(options.method).toBe('POST');
      expect(options.body).toBe('true');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(options.headers.Accept).toBe('application/json');
    });

    it('omits Content-Type and body for GET and does not require a body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'OK' }));
      globalThis.fetch = fetchMock;

      await api.request('/version');

      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
      expect(options.headers['Content-Type']).toBeUndefined();
    });

    it('rejects POST/PUT/PATCH calls without a body', async () => {
      await expect(api.request('/import/foo', 'POST')).rejects.toThrow(
        /Request body is required/,
      );
      await expect(api.request('/import/foo', 'PUT', null)).rejects.toThrow(
        /Request body is required/,
      );
      await expect(api.request('/import/foo', 'PATCH', undefined)).rejects.toThrow(
        /Request body is required/,
      );
    });

    it('rejects unknown HTTP methods', async () => {
      await expect(api.request('/version', 'connect')).rejects.toThrow(
        /Invalid HTTP method/,
      );
    });

    it('returns an empty object for HTTP 204 responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        statusText: 'No Content',
        json: vi.fn(),
      });

      await expect(api.request('/version')).resolves.toEqual({});
    });

    it('does not treat a successful message field as an API error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ message: 'OK' }));
      await expect(api.request('/version')).resolves.toEqual({ message: 'OK' });
    });

    it('does not treat successful primitive JSON responses as API errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse('None'));
      await expect(api.request('/eq/house-curve')).resolves.toBe('None');
    });

    it('merges JSON-encoded message strings into the response payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          message: '{"processName":"Import data ID 9","status":"queued"}',
        }),
      );

      const data = await api.request('/import/frequency-response-data');
      expect(data).toMatchObject({
        processName: 'Import data ID 9',
        status: 'queued',
      });
    });

    it('throws an error built from results[0].Error for failed responses', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          errorResponse(
            { results: [{ Error: 'No measurement selected' }] },
            { status: 400, statusText: 'Bad Request' },
          ),
        );

      await expect(api.request('/measurements/process-result')).rejects.toThrow(
        /\[400\] No measurement selected/,
      );
    });

    it('throws when the response payload itself reports a results[0].Error on 200', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({ results: [{ Error: 'Bad input data' }] }));

      await expect(api.request('/measurements')).rejects.toThrow(/Bad input data/);
    });

    it('falls back to statusText when the error body cannot be parsed as JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: vi.fn().mockRejectedValue(new Error('not json')),
      });

      await expect(api.request('/version')).rejects.toThrow(
        /\[503\] Service Unavailable/,
      );
    });

    it('reports an AbortError when the request times out', async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      globalThis.fetch = vi.fn().mockRejectedValue(error);

      const promise = api.request('/version');
      await expect(promise).rejects.toThrow(/timeout/);
      await expect(promise).rejects.toMatchObject({
        message: expect.stringMatching(/\/version/),
      });
    });

    it('applies a speed delay only for write methods', async () => {
      const delaySpy = vi.spyOn(api, 'getSpeedDelay').mockReturnValue(0);
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

      await api.request('/version');
      expect(delaySpy).not.toHaveBeenCalled();

      await api.request('/application/logging', 'POST', true);
      expect(delaySpy).toHaveBeenCalledTimes(1);

      await api.request('/measurements/1', 'DELETE');
      expect(delaySpy).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // checkVersion
  // ---------------------------------------------------------------------------
  describe('checkVersion()', () => {
    it('accepts current REW beta strings, with or without the "REW" prefix', async () => {
      const api = new RewApi();

      api.request = vi.fn().mockResolvedValue({ message: 'REW V5.40 beta 111' });
      await expect(api.checkVersion()).resolves.toBe('REW V5.40 beta 111');

      api.request = vi.fn().mockResolvedValue({ message: 'v5.40 beta 71' });
      await expect(api.checkVersion()).resolves.toBe('v5.40 beta 71');
    });

    it('rejects outdated versions and malformed payloads', async () => {
      const api = new RewApi();

      api.request = vi.fn().mockResolvedValue({ message: 'REW V5.40 beta 70' });
      await expect(api.checkVersion()).rejects.toThrow(/outdated and incompatible/);

      api.request = vi.fn().mockResolvedValue({ message: 'unknown banner' });
      await expect(api.checkVersion()).rejects.toThrow(/Invalid version format/);

      api.request = vi.fn().mockResolvedValue({});
      await expect(api.checkVersion()).rejects.toThrow(/Invalid version response format/);
    });
  });

  // ---------------------------------------------------------------------------
  // fetchWithRetry — retries, polling, alignment-tool, blocking flips
  // ---------------------------------------------------------------------------
  describe('fetchWithRetry()', () => {
    it('returns GET responses without polling', async () => {
      const api = new RewApi(baseUrl);
      const requestSpy = vi.spyOn(api, 'request').mockResolvedValue({ measurements: [] });

      await expect(api.fetchWithRetry('/measurements')).resolves.toEqual({
        measurements: [],
      });
      expect(requestSpy).toHaveBeenCalledTimes(1);
    });

    it('retries on transient failures and eventually returns the data', async () => {
      const api = new RewApi(baseUrl);
      const requestSpy = vi
        .spyOn(api, 'request')
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ message: 'OK' });

      await expect(api.fetchWithRetry('/version', 'GET', null, 1)).resolves.toEqual({
        message: 'OK',
      });
      expect(requestSpy).toHaveBeenCalledTimes(2);
    });

    it('throws "Max retries reached" once retries are exhausted', async () => {
      const api = new RewApi(baseUrl);
      vi.spyOn(api, 'request').mockRejectedValue(new Error('still down'));

      await expect(api.fetchWithRetry('/version', 'GET', null, 0)).rejects.toThrow(
        /Max retries reached/,
      );
    });

    it('polls /measurements/process-result for non-import POSTs that return a process ID', async () => {
      const api = new RewApi(baseUrl);
      const requestSpy = vi
        .spyOn(api, 'request')
        .mockResolvedValueOnce({ message: 'Cross corr align ID 17' })
        .mockResolvedValueOnce({
          processName: 'Cross corr align ID 17',
          message: 'Completed',
        });

      const result = await api.fetchWithRetry('/measurements/cross-corr-align', 'POST', {
        uuids: [],
      });
      expect(result).toEqual({
        processName: 'Cross corr align ID 17',
        message: 'Completed',
      });
      expect(requestSpy).toHaveBeenNthCalledWith(
        2,
        '/measurements/process-result',
        'GET',
        null,
      );
    });

    it('uses /alignment-tool/result for alignment-tool POSTs', async () => {
      const api = new RewApi(baseUrl);
      const requestSpy = vi
        .spyOn(api, 'request')
        .mockResolvedValueOnce({ message: 'Align ID 3' })
        .mockResolvedValueOnce({ processName: 'Align ID 3', message: 'Completed' });

      await api.fetchWithRetry('/alignment-tool/align', 'POST', {});
      expect(requestSpy).toHaveBeenNthCalledWith(
        2,
        '/alignment-tool/result',
        'GET',
        null,
      );
    });

    it('directly fetches the result URL once when blocking is enabled', async () => {
      const api = new RewApi(baseUrl, false, true);
      const requestSpy = vi
        .spyOn(api, 'request')
        .mockResolvedValueOnce({ message: 'Cross corr align ID 1' })
        .mockResolvedValueOnce({ message: 'Completed' });

      await api.fetchWithRetry('/measurements/cross-corr-align', 'POST', {});
      expect(requestSpy).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenLastCalledWith('/measurements/process-result');
    });

    it('temporarily disables blocking around import endpoints and restores it', async () => {
      const api = new RewApi(baseUrl, false, true);
      const setBlockingSpy = vi
        .spyOn(api, 'setBlocking')
        .mockImplementation(async enable => {
          api.blocking = enable;
          return { enabled: enable };
        });
      const requestSpy = vi
        .spyOn(api, 'request')
        .mockImplementation(async (_, method) => {
          if (method === 'POST') {
            return { message: 'Import frequency response data ID 42' };
          }
          return { message: 'Import frequency response data ID 42 Completed' };
        });

      const result = await api.fetchWithRetry(
        '/import/frequency-response-data',
        'POST',
        { magnitude: 'data' },
        0,
      );

      expect(result).toEqual({
        message: 'Import frequency response data ID 42 Completed',
      });
      expect(setBlockingSpy.mock.calls.map(c => c[0])).toEqual([false, true]);
      expect(requestSpy).toHaveBeenNthCalledWith(
        1,
        '/import/frequency-response-data',
        'POST',
        { magnitude: 'data' },
      );
      expect(requestSpy).toHaveBeenNthCalledWith(
        2,
        '/import/frequency-response-data',
        'GET',
        null,
      );
    });

    it('restores blocking mode when import polling fails', async () => {
      const api = new RewApi(baseUrl, false, true);
      const setBlockingSpy = vi
        .spyOn(api, 'setBlocking')
        .mockImplementation(async enable => {
          api.blocking = enable;
          return { enabled: enable };
        });
      vi.spyOn(api, 'request').mockImplementation(async (_, method) => {
        if (method === 'POST') {
          return { message: 'Import impulse response data ID 9' };
        }
        throw new Error('network down');
      });

      const originalMaxPollingRetry = RewApi.MAX_POLLING_RETRY;
      const originalRetryDelay = RewApi.WAIT_BETWEEN_RETRIES_MS;
      RewApi.MAX_POLLING_RETRY = 1;
      RewApi.WAIT_BETWEEN_RETRIES_MS = 0;

      try {
        await expect(
          api.fetchWithRetry('/import/impulse-response-data', 'POST', { data: 'x' }, 0),
        ).rejects.toThrow(/Max retries reached/);
      } finally {
        RewApi.MAX_POLLING_RETRY = originalMaxPollingRetry;
        RewApi.WAIT_BETWEEN_RETRIES_MS = originalRetryDelay;
      }

      expect(setBlockingSpy.mock.calls.map(c => c[0])).toEqual([false, true]);
    });

    it('shares one blocking bypass across concurrent import writes', async () => {
      const api = new RewApi(baseUrl, false, true);
      const setBlockingSpy = vi
        .spyOn(api, 'setBlocking')
        .mockImplementation(async enable => {
          api.blocking = enable;
          return { enabled: enable };
        });

      let releasePolling;
      const pollingGate = new Promise(resolve => {
        releasePolling = resolve;
      });
      let firstPollingStartedResolve;
      const firstPollingStarted = new Promise(resolve => {
        firstPollingStartedResolve = resolve;
      });
      let pollingCount = 0;

      vi.spyOn(api, 'request').mockImplementation(async (_, method) => {
        if (method === 'POST') {
          return { message: 'Import frequency response data ID 42' };
        }

        pollingCount += 1;
        if (pollingCount === 1) {
          firstPollingStartedResolve();
        }
        await pollingGate;
        return { message: 'Import frequency response data ID 42 Completed' };
      });

      const firstImport = api.fetchWithRetry(
        '/import/frequency-response-data',
        'POST',
        { magnitude: 'left' },
        0,
      );
      await firstPollingStarted;

      const secondImport = api.fetchWithRetry(
        '/import/frequency-response-data',
        'POST',
        { magnitude: 'right' },
        0,
      );

      await Promise.resolve();
      releasePolling();

      await expect(Promise.all([firstImport, secondImport])).resolves.toEqual([
        { message: 'Import frequency response data ID 42 Completed' },
        { message: 'Import frequency response data ID 42 Completed' },
      ]);
      expect(setBlockingSpy.mock.calls.map(c => c[0])).toEqual([false, true]);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldPollImportData
  // ---------------------------------------------------------------------------
  describe('shouldPollImportData()', () => {
    it('returns true only for blocking POSTs to import data endpoints', () => {
      const blocking = new RewApi(baseUrl, false, true);
      const nonBlocking = new RewApi(baseUrl, false, false);

      expect(
        blocking.shouldPollImportData('/import/frequency-response-data', 'POST'),
      ).toBe(true);
      expect(blocking.shouldPollImportData('/import/impulse-response-data', 'POST')).toBe(
        true,
      );
      expect(
        blocking.shouldPollImportData('/import/frequency-response-data', 'GET'),
      ).toBe(false);
      expect(blocking.shouldPollImportData('/measurements', 'POST')).toBe(false);
      expect(
        nonBlocking.shouldPollImportData('/import/frequency-response-data', 'POST'),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Static helpers
  // ---------------------------------------------------------------------------
  describe('extractProcessID', () => {
    const api = new RewApi(baseUrl);

    it('extracts process IDs from string, message, and processName fields', () => {
      expect(api.extractProcessID('Cross corr align ID 5 Completed')).toBe(
        'Cross corr align ID 5',
      );
      expect(api.extractProcessID({ message: 'Vector average ID 12' })).toBe(
        'Vector average ID 12',
      );
      expect(api.extractProcessID({ processName: 'Align phase ID 7' })).toBe(
        'Align phase ID 7',
      );
    });

    it('returns null when no process ID is present and throws on empty input', () => {
      expect(api.extractProcessID('done')).toBeNull();
      expect(api.extractProcessID({ message: 'no id here' })).toBeNull();
      expect(() => api.extractProcessID(null)).toThrow(/empty/);
    });
  });

  describe('validateExpectedProcess', () => {
    const api = new RewApi(baseUrl);

    it('accepts case-insensitive substring matches in strings and object fields', () => {
      expect(() =>
        api.validateExpectedProcess('Import data ID 12', {
          message: 'IMPORT DATA ID 12 Completed',
        }),
      ).not.toThrow();

      expect(() =>
        api.validateExpectedProcess(
          { processName: 'Align phase ID 7', message: 'Completed' },
          { processName: 'align phase id 7', message: 'completed' },
        ),
      ).not.toThrow();
    });

    it('throws when an object expectation field is missing from the response', () => {
      expect(() =>
        api.validateExpectedProcess(
          { processName: 'Align phase ID 7', message: 'Completed' },
          { processName: 'Align phase ID 7' },
        ),
      ).toThrow(/Completed/);
    });

    it('is a no-op when no expectation is provided and throws on empty payloads', () => {
      expect(() => api.validateExpectedProcess(null, {})).not.toThrow();
      expect(() => api.validateExpectedProcess('expected', null)).toThrow(/empty/);
    });
  });

  describe('getResultUrl / getProcessExpectedResponse', () => {
    const api = new RewApi(baseUrl);

    it('routes alignment-tool, import and measurement endpoints to the correct result URL', () => {
      expect(api.getResultUrl('/alignment-tool/align')).toBe('/alignment-tool/result');
      expect(api.getResultUrl('/import/frequency-response-data')).toBe(
        '/import/frequency-response-data',
      );
      expect(api.getResultUrl('/measurements/cross-corr-align')).toBe(
        '/measurements/process-result',
      );
      expect(
        api.getResultUrl('/measurements/cross-corr-align', {
          resultUrl: '/measurements/custom-result',
        }),
      ).toBe('/measurements/custom-result');
    });

    it('returns the bare process ID for /import endpoints and a full match object otherwise', () => {
      expect(
        api.getProcessExpectedResponse(
          '/import/frequency-response-data',
          'Import data ID 9',
        ),
      ).toBe('Import data ID 9');
      expect(
        api.getProcessExpectedResponse(
          '/measurements/cross-corr-align',
          'Cross corr align ID 9',
        ),
      ).toEqual({ processName: 'Cross corr align ID 9', message: 'Completed' });
    });

    it('rejects invalid arguments', () => {
      expect(() => api.getResultUrl('')).toThrow();
      expect(() =>
        api.getResultUrl('/measurements', { resultUrl: 'http://example.test/result' }),
      ).toThrow(/relative API path/);
      expect(() => api.getProcessExpectedResponse('/measurements', '')).toThrow(
        /Process ID is required/,
      );
    });
  });

  describe('Swagger wrapper methods', () => {
    let api;
    let fetchSpy;

    beforeEach(() => {
      api = new RewApi(baseUrl);
      fetchSpy = vi.spyOn(api, 'fetchWithRetry').mockResolvedValue({ message: 'OK' });
    });

    it('sends application commands and subscriber payloads using Swagger shapes', async () => {
      const requestSpy = vi.spyOn(api, 'request').mockResolvedValue({ message: 'OK' });

      await api.getCommands();
      await api.executeCommand('Clear command in progress');
      await api.getLogging();
      await api.subscribeWarnings('http://callback.test/warnings', { scope: 'all' });

      expect(requestSpy).toHaveBeenNthCalledWith(1, '/application/commands');
      expect(requestSpy).toHaveBeenNthCalledWith(2, '/application/command', 'POST', {
        command: 'Clear command in progress',
        parameters: [],
      });
      expect(requestSpy).toHaveBeenNthCalledWith(3, '/application/logging');
      expect(requestSpy).toHaveBeenNthCalledWith(
        4,
        '/application/warnings/subscribe',
        'POST',
        {
          url: 'http://callback.test/warnings',
          parameters: { scope: 'all' },
        },
      );
    });

    it('normalizes alignment command frequency parameters and retry arguments', async () => {
      await api.rewAlignmentTool.alignIRs(80, 4);
      expect(fetchSpy).toHaveBeenLastCalledWith(
        '/alignment-tool/command',
        'POST',
        { command: 'Align IRs', frequency: 80 },
        4,
      );

      await api.rewAlignmentTool.alignPhaseBatch(1, 2, 'Impulse', 90);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        '/alignment-tool/index-a',
        'POST',
        1,
        2,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        '/alignment-tool/index-b',
        'POST',
        2,
        2,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        4,
        '/alignment-tool/mode',
        'POST',
        'Impulse',
        2,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        5,
        '/alignment-tool/command',
        'POST',
        { command: 'Align phase', frequency: 90 },
        0,
      );
      expect('getDelayA' in api.rewAlignmentTool).toBe(false);
    });

    it('exposes missing EQ choice endpoints and partial default updates', async () => {
      await api.rewEq.getTargetShapes();
      await api.rewEq.getCrossoverTypes();
      await api.rewEq.getSlopes();
      await api.rewEq.putDefaultTargetSettings({ shape: 'None' });
      await api.rewEq.putDefaultRoomCurveSettings({ addRoomCurve: false });

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        '/eq/target-shapes',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        '/eq/crossover-types',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(3, '/eq/slopes', undefined, undefined);
      expect(fetchSpy).toHaveBeenNthCalledWith(4, '/eq/default-target-settings', 'PUT', {
        shape: 'None',
      });
      expect(fetchSpy).toHaveBeenNthCalledWith(
        5,
        '/eq/default-room-curve-settings',
        'PUT',
        { addRoomCurve: false },
      );
    });

    it('supports import save options, file import options, and immutable data encoding', async () => {
      await api.rewImport.getRTAFileSaveOptions();
      await api.rewImport.importImpulseResponse('/measurements/ir.wav', {
        channels: 'Left',
        applyCal: true,
      });

      const magnitude = new Float32Array([1, 2]);
      const phase = new Float32Array([0, 1]);
      const payload = {
        identifier: 'FR',
        startFreq: 20,
        ppo: 96,
        magnitude,
        phase,
      };
      await api.rewImport.importFrequencyResponseData(payload);

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        '/import/rta-file/save-options',
        undefined,
        undefined,
        0,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        '/import/impulse-response',
        'POST',
        { path: '/measurements/ir.wav', channels: 'Left', applyCal: true },
        0,
      );
      expect(fetchSpy.mock.calls[2][0]).toBe('/import/frequency-response-data');
      expect(fetchSpy.mock.calls[2][1]).toBe('POST');
      expect(fetchSpy.mock.calls[2][2]).toMatchObject({
        identifier: 'FR',
        startFreq: 20,
        ppo: 96,
      });
      expect(typeof fetchSpy.mock.calls[2][2].magnitude).toBe('string');
      expect(typeof fetchSpy.mock.calls[2][2].phase).toBe('string');
      expect(payload.magnitude).toBe(magnitude);
      expect(payload.phase).toBe(phase);
    });

    it('exposes missing measurements endpoints and process helpers', async () => {
      await api.rewMeasurements.getSelectedIndex();
      await api.rewMeasurements.selectByIndex(3);
      await api.rewMeasurements.getProcessResult();
      await api.rewMeasurements.getSpectrogramWindowChoices();
      await api.rewMeasurements.getSpectrogramAmplitudeChoices();
      await api.rewMeasurements.getRT60Settings('abc');
      await api.rewMeasurements.postIRWindows('abc', { leftWindowType: 'Hann' });
      await api.rewMeasurements.setRoomCurveSettings('abc', { lowFreqRiseStartHz: 200 });
      await api.rewMeasurements.magnPlusPhaseAverage(['a', 'b']);

      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        '/measurements/selected',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(2, '/measurements/selected', 'POST', 3);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        '/measurements/process-result',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        4,
        '/measurements/spectrogram-window-choices',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        5,
        '/measurements/spectrogram-amplitude-choices',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        6,
        '/measurements/abc/rt60-settings',
        undefined,
        undefined,
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        7,
        '/measurements/abc/ir-windows',
        'POST',
        { leftWindowType: 'Hann' },
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        8,
        '/measurements/abc/room-curve-settings',
        'PUT',
        { lowFreqRiseStartHz: 200 },
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        9,
        '/measurements/process-measurements',
        'POST',
        {
          processName: 'Magn plus phase average',
          measurementUUIDs: ['a', 'b'],
          parameters: {},
        },
      );
    });
  });

  describe('getSpeedDelay', () => {
    it('returns the inhibit-graph delay when graph updates are inhibited', () => {
      const fast = new RewApi(baseUrl, true, false);
      const slow = new RewApi(baseUrl, false, false);
      expect(fast.getSpeedDelay()).toBe(RewApi.SPEED_DELAY_INHIBIT_MS);
      expect(slow.getSpeedDelay()).toBe(RewApi.SPEED_DELAY_NORMAL_MS);
      expect(RewApi.SPEED_DELAY_INHIBIT_MS).toBeLessThan(RewApi.SPEED_DELAY_NORMAL_MS);
    });
  });

  describe('safeParseJSON', () => {
    it('parses well-formed object/array strings and returns null otherwise', () => {
      expect(RewApi.safeParseJSON('{"a":1}')).toEqual({ a: 1 });
      expect(RewApi.safeParseJSON('[1, 2]')).toEqual([1, 2]);
      // does not attempt to parse strings that don't end with } or ]
      expect(RewApi.safeParseJSON('completed')).toBeNull();
      expect(RewApi.safeParseJSON('{ malformed ]')).toBeNull();
      expect(RewApi.safeParseJSON('')).toBeNull();
      expect(RewApi.safeParseJSON(null)).toBeNull();
    });
  });

  describe('Float32 base64 codec', () => {
    it('round-trips Float32 arrays in little-endian order', () => {
      const values = new Float32Array([1, -2.5, Math.PI, -Math.E, 0]);
      const encoded = RewApi.encodeFloat32ToBase64(values, true);
      const decoded = RewApi.decodeBase64ToFloat32(encoded, true);
      expect(Array.from(decoded)).toEqual(Array.from(values));
    });

    it('round-trips Float32 arrays in big-endian (REW default) order', () => {
      const values = new Float32Array([0.125, -10.5, 1.5e-3]);
      const encoded = RewApi.encodeFloat32ToBase64(values, false);
      const decoded = RewApi.decodeBase64ToFloat32(encoded, false);
      expect(Array.from(decoded)).toEqual(Array.from(values));
    });

    it('rejects truncated base64 payloads not aligned on 4 bytes', () => {
      expect(() =>
        RewApi.decodeBase64ToFloat32(Buffer.from([1, 2, 3]).toString('base64')),
      ).toThrow(/multiple of 4/);
    });

    it('rejects invalid input types for encode and decode', () => {
      expect(() => RewApi.encodeFloat32ToBase64([1, 2, 3])).toThrow(TypeError);
      expect(() => RewApi.encodeFloat32ToBase64(null)).toThrow(TypeError);
      expect(() => RewApi.decodeBase64ToFloat32(42)).toThrow(TypeError);
    });
  });
});
