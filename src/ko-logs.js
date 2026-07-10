import ko from 'knockout';
import { saveAs } from 'file-saver';
import lm, { LEVELS } from './logs.js';

/**
 * Knockout display adapter over the agnostic log service (CLAUDE.md [MIXTE] #5).
 *
 * Mirrors the service into ko observables the index.html log panel binds to
 * (`lm.autoScroll`, `lm.logLevel`, `lm.filteredLogs`, `lm.exportLogs`) and owns
 * the DOM side effects (auto-scroll, the Clear-logs button). Retired with the
 * Knockout entry (D-08); the Vue UI never imports this.
 */
class KoLogsAdapter {
  constructor(service) {
    this.service = service;
    this.logs = ko.observableArray(service.getEntries().slice());
    this.logLevel = ko.observable(service.getLevel());
    this.autoScroll = ko.observable(service.getAutoScroll());
    this.filteredLogs = ko.computed(() => {
      const maxLevel = LEVELS.indexOf(this.logLevel());
      return this.logs().filter(
        log => LEVELS.indexOf(log.level.toUpperCase()) <= maxLevel,
      );
    });

    // service → ko observables
    service.subscribe(event => {
      if (event.type === 'log') {
        this.logs.push(event.entry);
        if (this.logs().length > service.maxLogs) this.logs.shift();
        this.scrollToBottom();
      } else if (event.type === 'clear') {
        this.logs.removeAll();
      } else if (event.type === 'level') {
        this.logLevel(event.level);
      } else if (event.type === 'autoScroll') {
        this.autoScroll(event.autoScroll);
      }
    });
    // ko observables (user input) → service
    this.logLevel.subscribe(value => service.setLevel(value));
    this.autoScroll.subscribe(value => service.setAutoScroll(value));

    this.initClearButton();

    this.exportLogs = async () => {
      const blob = new Blob([service.formatLogsText()], {
        type: 'text/plain;charset=utf-8',
      });
      return saveAs(blob, 'logs.txt');
    };
  }

  scrollToBottom() {
    ko.tasks.schedule(() => {
      if (!this.autoScroll()) return;
      const logsContent = document.getElementById('logs-content');
      if (logsContent) logsContent.scrollTop = logsContent.scrollHeight;
    });
  }

  initClearButton() {
    const clearButton = document.getElementById('clear-logs');
    if (clearButton) {
      clearButton.addEventListener('click', () => this.service.clearLogs());
    }
  }
}

export default new KoLogsAdapter(lm);
export { KoLogsAdapter };
