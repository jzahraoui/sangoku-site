/**
 * Mock logs.js for Node.js testing
 * Replaces the browser-dependent logs.js
 */

const lm = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.log('[WARN]', ...args),
  error: (...args) => console.log('[ERROR]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args),
  success: (...args) => console.log('[SUCCESS]', ...args),
  downloadLogs: () => {},
  clearLogs: () => {},
};

export default lm;
