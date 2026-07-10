/**
 * Framework-agnostic log service (CLAUDE.md [MIXTE] #5 decontamination).
 *
 * State + levels + ring buffer + a plain listener API — no Knockout, no DOM. The
 * whole engine, the business services and the UI import this singleton as `lm`
 * and call `lm.info(...)` etc. The display half lives elsewhere:
 *  - Knockout: `src/ko-logs.js` wraps this service in ko observables for the
 *    index.html bindings.
 *  - A future UI layer can subscribe to this service directly.
 */

const LEVELS = ['ERROR', 'WARN', 'SUCCESS', 'INFO', 'DEBUG'];

class LogService {
  constructor() {
    this.entries = [];
    this.maxLogs = 5000;
    this.level = 'INFO';
    this.autoScroll = true;
    this.listeners = new Set();
  }

  /** Register a change listener; returns an unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  addLog(level, message) {
    const entry = {
      timestamp: new Date().toLocaleTimeString(),
      level: String(level).toLowerCase(),
      message,
    };
    this.entries.push(entry);
    // Ring buffer: drop the oldest entry past the cap.
    if (this.entries.length > this.maxLogs) this.entries.shift();
    this.emit({ type: 'log', entry, entries: this.entries });
  }

  info(message) {
    this.addLog('info', message);
  }
  warn(message) {
    this.addLog('warn', message);
  }
  error(message) {
    this.addLog('error', message);
  }
  debug(message) {
    this.addLog('debug', message);
  }
  success(message) {
    this.addLog('success', message);
  }
  // Alias kept for the odd `lm.log(...)` call site (avr-caracteristics.js).
  log(message) {
    this.addLog('info', message);
  }

  clearLogs() {
    this.entries = [];
    this.emit({ type: 'clear', entries: this.entries });
  }

  getEntries() {
    return this.entries;
  }

  /** Entries at or above the given level (defaults to the current level). */
  getFilteredEntries(level = this.level) {
    const maxLevel = LEVELS.indexOf(level);
    return this.entries.filter(
      entry => LEVELS.indexOf(entry.level.toUpperCase()) <= maxLevel,
    );
  }

  getLevel() {
    return this.level;
  }
  setLevel(value) {
    if (value === this.level) return;
    this.level = value;
    this.emit({ type: 'level', level: value });
  }

  getAutoScroll() {
    return this.autoScroll;
  }
  setAutoScroll(value) {
    if (value === this.autoScroll) return;
    this.autoScroll = value;
    this.emit({ type: 'autoScroll', autoScroll: value });
  }

  /** Plain-text dump for the "Export logs" action (saveAs lives in the UI). */
  formatLogsText() {
    return this.entries
      .map(entry => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`)
      .join('\n');
  }
}

export default new LogService();
export { LogService, LEVELS };
