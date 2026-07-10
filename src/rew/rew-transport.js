const transportStatics = {
  trimTrailingSlashes(value) {
    let endIndex = value.length;
    while (endIndex > 0 && value[endIndex - 1] === '/') {
      endIndex -= 1;
    }
    return value.slice(0, endIndex);
  },

  normalizeMethod(method) {
    if (typeof method !== 'string') {
      throw new TypeError('Method must be a string');
    }

    const methodUpper = method.toUpperCase();
    if (!this.ALLOWED_METHODS.has(methodUpper)) {
      throw new Error(`Invalid HTTP method: ${method}`);
    }
    return methodUpper;
  },

  hasRequestBody(body) {
    return body !== null && body !== undefined;
  },

  getEndpointPath(endpoint) {
    if (!endpoint) {
      throw new Error('Missing endpoint');
    }
    if (typeof endpoint !== 'string') {
      throw new TypeError('Endpoint must be a string');
    }
    if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
      throw new Error('Endpoint must be a relative API path starting with /');
    }

    return endpoint.split('?', 1)[0];
  },

  // Restored from the pre-src/rew RewApi (dropped by mistake in the split
  // while buttonDownloadAvr still calls it).
  isValidIpAddress(ip) {
    if (typeof ip !== 'string') return false;
    const parts = ip.split('.');
    if (parts.length !== 4) return false;

    for (const part of parts) {
      const num = Number(part);
      if (part !== String(num) || num < 0 || num > 255) {
        return false;
      }
    }
    return true;
  },
};

const transportMethods = {
  setBaseURL(baseURL) {
    const ApiClass = this.constructor;
    if (typeof baseURL !== 'string') {
      throw new TypeError('Base URL must be a string');
    }

    const trimmedBaseURL = baseURL.trim();
    if (!trimmedBaseURL) {
      throw new Error('Base URL is required');
    }

    let parsedBase;
    try {
      parsedBase = new URL(trimmedBaseURL);
    } catch (error) {
      throw new Error(`Invalid base URL: ${baseURL}`, { cause: error });
    }

    if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
      throw new Error('Base URL must use HTTP or HTTPS protocol');
    }
    if (parsedBase.username || parsedBase.password) {
      throw new Error('Base URL must not include credentials');
    }

    parsedBase.hash = '';
    parsedBase.search = '';

    this.baseURL = ApiClass.trimTrailingSlashes(parsedBase.href);
  },

  getRequestUrl(endpoint) {
    this.constructor.getEndpointPath(endpoint);
    return `${this.baseURL}${endpoint}`;
  },

  getSpeedDelay() {
    const ApiClass = this.constructor;
    return this.inhibitGraphUpdates
      ? ApiClass.SPEED_DELAY_INHIBIT_MS
      : ApiClass.SPEED_DELAY_NORMAL_MS;
  },

  async request(endpoint, method = 'GET', body = null) {
    const ApiClass = this.constructor;
    const methodUpper = ApiClass.normalizeMethod(method);
    const hasBody = ApiClass.hasRequestBody(body);

    if (ApiClass.BODY_REQUIRED_METHODS.has(methodUpper) && !hasBody) {
      throw new Error(`Request body is required for ${methodUpper} requests`);
    }

    const completeUrl = this.getRequestUrl(endpoint);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ApiClass.TIMEOUT_MS);

    const options = {
      method: methodUpper,
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    };
    if (hasBody) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    try {
      const response = await fetch(completeUrl, options);

      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ message: response.statusText }));

        ApiClass.mergeParsedMessage(error);
        const errorMessage =
          ApiClass.extractErrorMessage(error) ||
          (typeof error === 'string' ? error : error.message) ||
          `HTTP error! for URL: ${completeUrl}`;
        throw new Error(`[${response.status}] ${errorMessage}`);
      }

      const data = response.status === 204 ? {} : await response.json();

      if (data == null) throw new Error('Invalid response data');

      if (ApiClass.WRITE_METHODS.has(methodUpper)) {
        await new Promise(resolve => setTimeout(resolve, this.getSpeedDelay()));
      }

      ApiClass.mergeParsedMessage(data);

      const errorMessage = ApiClass.extractErrorMessage(data);
      if (errorMessage) throw new Error(errorMessage);

      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        const abortError = new Error(
          `Request ${endpoint} timeout after ${ApiClass.TIMEOUT_MS / 1000} s`,
        );
        abortError.code = 'AbortError';
        throw abortError;
      }

      throw new Error(`Request failed for ${endpoint}: ${error.message}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  },
};

export { transportMethods, transportStatics };
