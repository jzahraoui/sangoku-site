const processMethods = {
  async restoreImportBlockingIfNeeded() {
    if (this.importBlockingBypassCount === 0 && this.importBlockingRestorePending) {
      this.importBlockingRestorePending = false;
      await this.setBlocking(true);
    }
  },

  async fetchWithRetry(
    endpoint,
    method = 'GET',
    body = null,
    retries = 2,
    expectedProcess = null,
    skipImportBlockingBypass = false,
  ) {
    const ApiClass = this.constructor;
    const methodUpper = ApiClass.normalizeMethod(method);

    if (!skipImportBlockingBypass && this.shouldPollImportData(endpoint, methodUpper)) {
      const shouldToggleBlockingOff = this.importBlockingBypassCount === 0;
      this.importBlockingBypassCount += 1;

      try {
        if (shouldToggleBlockingOff) {
          this.importBlockingRestorePending = true;
          await this.setBlocking(false);
        }
        return await this.fetchWithRetry(
          endpoint,
          methodUpper,
          body,
          retries,
          expectedProcess,
          true,
        );
      } finally {
        this.importBlockingBypassCount -= 1;
        await this.restoreImportBlockingIfNeeded();
      }
    }

    try {
      const data = await this.request(endpoint, methodUpper, body);
      expectedProcess && this.validateExpectedProcess(expectedProcess, data);

      if (methodUpper === 'GET') {
        return data;
      }

      const processID = this.extractProcessID(data);

      if (!processID) {
        return data;
      }

      const processExpectedResponse = this.getProcessExpectedResponse(
        endpoint,
        processID,
      );
      const resultUrl = this.getResultUrl(endpoint, body);

      if (this.blocking) {
        return this.request(resultUrl);
      }

      return this.fetchWithRetry(
        resultUrl,
        'GET',
        null,
        ApiClass.MAX_POLLING_RETRY,
        processExpectedResponse,
      );
    } catch (error) {
      if (error.code === 'AbortError') {
        throw new Error(
          `Request ${endpoint} timeout after ${ApiClass.TIMEOUT_MS / 1000} s`,
          { cause: error },
        );
      }
      if (retries > 0) {
        await new Promise(resolve =>
          setTimeout(resolve, ApiClass.WAIT_BETWEEN_RETRIES_MS),
        );
        return this.fetchWithRetry(
          endpoint,
          methodUpper,
          body,
          retries - 1,
          expectedProcess,
          skipImportBlockingBypass,
        );
      }
      throw new Error(`Max retries reached for ${endpoint}: ${error.message}`, {
        cause: error,
      });
    }
  },

  shouldPollImportData(endpoint, method = 'GET') {
    const ApiClass = this.constructor;
    const methodUpper = ApiClass.normalizeMethod(method);
    if (methodUpper === 'GET') {
      return false;
    }

    const endpointPath = ApiClass.getEndpointPath(endpoint);
    return (
      ApiClass.IMPORT_DATA_ENDPOINTS.has(endpointPath) &&
      (this.blocking || this.importBlockingBypassCount > 0)
    );
  },

  extractProcessID(data) {
    if (!data) {
      throw new Error('API response is empty');
    }

    const idRegex = /ID \d+/;

    const extractMatch = str => {
      if (typeof str !== 'string' || !str) return null;

      const match = idRegex.exec(str);
      if (!match) return null;
      return str.substring(0, match.index + match[0].length);
    };

    if (typeof data === 'string') {
      return extractMatch(data) || null;
    }
    if (data.message && typeof data.message === 'string') {
      const result = extractMatch(data.message);
      if (result) return result;
    }

    if (data.processName && typeof data.processName === 'string') {
      const result = extractMatch(data.processName);
      if (result) return result;
    }

    return null;
  },

  validateExpectedProcess(expectedProcess, data) {
    if (!expectedProcess) return;
    if (!data) throw new Error('API response is empty');

    const isExpectedString = typeof expectedProcess === 'string';

    const generateErrorMessage = (expected, received) => {
      return `The API response does not concern the requested task. expected: "${expected}" received: "${received}"`;
    };

    const caseInsensitiveIncludes = (str, search) => {
      if (typeof str !== 'string' || typeof search !== 'string') {
        return false;
      }
      return str.toLowerCase().includes(search.toLowerCase());
    };

    const stringify = value => {
      if (typeof value === 'string') return value;
      if (value === undefined) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const getReceivedField = fieldName => {
      if (typeof data === 'string') return data;
      if (!data || typeof data !== 'object') return stringify(data);
      return stringify(data[fieldName]);
    };

    if (isExpectedString) {
      const received =
        typeof data === 'string'
          ? data
          : [data?.processName, data?.message, stringify(data)].filter(Boolean).join(' ');
      if (!caseInsensitiveIncludes(received, expectedProcess)) {
        throw new Error(generateErrorMessage(expectedProcess, received));
      }
      return;
    }

    // REW clears a process as soon as it finishes: a fast/synchronous operation
    // (e.g. "Generate target measurement") polled a beat too late answers
    // "There is no process" instead of "<name> Completed". When we are waiting
    // for completion, treat that as done — the caller validates the real outcome
    // (created measurement, arithmetic result, …). Without this the poll retries
    // to exhaustion and the operation spuriously fails.
    if (caseInsensitiveIncludes(stringify(expectedProcess.message), 'completed')) {
      const receivedAll =
        typeof data === 'string'
          ? data
          : [data?.processName, data?.message, stringify(data)]
              .filter(Boolean)
              .join(' ');
      if (caseInsensitiveIncludes(receivedAll, 'no process')) {
        return;
      }
    }

    for (const fieldName of ['message', 'processName']) {
      const expected = expectedProcess[fieldName];
      if (!expected) continue;

      const received = getReceivedField(fieldName);
      if (!caseInsensitiveIncludes(received, expected)) {
        throw new Error(generateErrorMessage(expected, received));
      }
    }
  },

  getProcessExpectedResponse(url, processID) {
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }
    if (!processID) {
      throw new Error('Process ID is required');
    }

    return url.startsWith('/import')
      ? processID
      : { processName: processID, message: 'Completed' };
  },

  getResultUrl(url, body = null) {
    const ApiClass = this.constructor;
    if (!url || typeof url !== 'string') {
      throw new Error('URL parameter is required and must be a string');
    }

    if (body?.resultUrl) {
      ApiClass.getEndpointPath(body.resultUrl);
      return body.resultUrl;
    }

    if (url.startsWith('/alignment-tool/')) {
      return '/alignment-tool/result';
    }
    if (url.startsWith('/import')) {
      return url;
    }
    return '/measurements/process-result';
  },
};

export { processMethods };
