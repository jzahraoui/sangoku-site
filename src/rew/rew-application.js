const applicationMethods = {
  async getBlocking() {
    return this.request('/application/blocking');
  },

  async setBlocking(enable = true) {
    const response = await this.request('/application/blocking', 'POST', enable);
    this.blocking = enable;
    return response;
  },

  async getInhibitGraphUpdates() {
    return this.request('/application/inhibit-graph-updates');
  },

  async setInhibitGraphUpdates(enable = true) {
    const response = await this.request(
      '/application/inhibit-graph-updates',
      'POST',
      enable,
    );
    this.inhibitGraphUpdates = enable;
    return response;
  },

  async getCommands() {
    return this.request('/application/commands');
  },

  async executeCommand(command, parameters = []) {
    if (typeof command !== 'string') {
      throw new TypeError('command must be a string');
    }
    if (!Array.isArray(parameters)) {
      throw new TypeError('parameters must be an array');
    }
    return this.request('/application/command', 'POST', { command, parameters });
  },

  async getLastError() {
    return this.request('/application/last-error');
  },

  async getErrors() {
    return this.request('/application/errors');
  },

  async subscribeErrors(url, parameters = null) {
    return this.request(
      '/application/errors/subscribe',
      'POST',
      this.constructor.createSubscriber(url, parameters),
    );
  },

  async unsubscribeErrors(url, parameters = null) {
    return this.request(
      '/application/errors/unsubscribe',
      'POST',
      this.constructor.createSubscriber(url, parameters),
    );
  },

  async getErrorSubscribers() {
    return this.request('/application/errors/subscribers');
  },

  async getLastWarning() {
    return this.request('/application/last-warning');
  },

  async getWarnings() {
    return this.request('/application/warnings');
  },

  async subscribeWarnings(url, parameters = null) {
    return this.request(
      '/application/warnings/subscribe',
      'POST',
      this.constructor.createSubscriber(url, parameters),
    );
  },

  async unsubscribeWarnings(url, parameters = null) {
    return this.request(
      '/application/warnings/unsubscribe',
      'POST',
      this.constructor.createSubscriber(url, parameters),
    );
  },

  async getWarningSubscribers() {
    return this.request('/application/warnings/subscribers');
  },

  async clearCommands() {
    return this.executeCommand('Clear command in progress');
  },

  async getLogging() {
    return this.request('/application/logging');
  },

  async setLogging(enable = true) {
    return this.request('/application/logging', 'POST', enable);
  },

  /**
   * Reconcile REW server state with the configured client state.
   * REW should be fully started before calling this; the API does not expose a
   * readiness probe.
   */
  async initializeAPI() {
    const inhibitGraph = await this.getInhibitGraphUpdates();
    if (inhibitGraph !== this.inhibitGraphUpdates) {
      await this.setInhibitGraphUpdates(this.inhibitGraphUpdates);
    }

    const blocking = await this.getBlocking();
    if (blocking !== this.blocking) {
      await this.setBlocking(this.blocking);
    }

    await this.rewEq.setDefaultEqualiser();
    await this.clearCommands();
  },

  async checkVersion() {
    const ApiClass = this.constructor;
    const response = await this.request('/version');
    if (typeof response?.message !== 'string') {
      throw new TypeError('Invalid version response format');
    }
    const versionString = response.message;
    const versionMatch = ApiClass.VERSION_REGEX.exec(versionString);
    if (!versionMatch) throw new Error(`Invalid version format: ${versionString}`);

    const major = Number.parseInt(versionMatch[1], 10);
    const minor = Number.parseInt(versionMatch[2], 10);
    const beta = Number.parseInt(versionMatch[3], 10);
    const versionNum = major * 10000 + minor * 100 + beta;

    if (versionNum < ApiClass.MIN_REQUIRED_VERSION) {
      throw new Error(
        `Installed REW version (${versionString}) is outdated and incompatible. ` +
          `Please install the latest REW Beta from https://www.avnirvana.com/threads/rew-api-beta-releases.12981/.`,
      );
    }
    return versionString;
  },
};

export { applicationMethods };
