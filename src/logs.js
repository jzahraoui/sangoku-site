import ko from 'knockout';
import { saveAs } from 'file-saver';

// Real-time logs management
class LogsManager {
  constructor() {
    this.logs = ko.observableArray([]);
    this.maxLogs = 5000;
    this.autoScroll = ko.observable(true);
    this.logLevel = ko.observable('INFO');
    this.filteredLogs = ko.computed(() => {
      const levels = ['ERROR', 'WARN', 'SUCCESS', 'INFO', 'DEBUG'];
      const maxLevel = levels.indexOf(this.logLevel());
      return this.logs().filter(
        log => levels.indexOf(log.level.toUpperCase()) <= maxLevel
      );
    });
    this.init();

    this.exportLogs = async () => {
      const logsData = this.logs()
        .map(log => {
          return `[${log.timestamp}] [${log.level.toUpperCase()}] ${log.message}`;
        })
        .join('\n');
      // use saveas
      const blob = new Blob([logsData], { type: 'text/plain;charset=utf-8' });
      return saveAs(blob, 'logs.txt');
    };
  }

  init() {
    // Clear logs button
    document.getElementById('clear-logs').addEventListener('click', () => {
      this.clearLogs();
    });
  }

  addLog(level, message) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = {
      timestamp: timestamp,
      level: level.toLowerCase(),
      message: message,
    };

    this.logs.push(logEntry);
    // Limit logs count
    if (this.logs().length > this.maxLogs) {
      this.logs.shift();
    }

    // Puis utiliser ko.tasks.schedule pour attendre la mise à jour du DOM
    ko.tasks.schedule(() => {
      if (this.autoScroll()) {
        const logsContent = document.getElementById('logs-content');
        if (logsContent) {
          logsContent.scrollTop = logsContent.scrollHeight;
        }
      }
    });
  }

  clearLogs() {
    this.logs.removeAll();
  }

  // Convenience methods
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
}

export default new LogsManager();

// Example usage - replace your existing status updates with:
// logsManager.info('Application started');
// logsManager.success('OCA file created successfully');
// logsManager.error('Failed to process measurements');
