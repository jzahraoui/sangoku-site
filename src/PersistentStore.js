import lm from './logs.js';

class PersistentStore {
  constructor(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new Error('Storage key must be a non-empty string');
    }
    this.storageKey = storageKey;
    // Last failure of save(), null after a success — lets callers implement
    // fallbacks (e.g. retry without the heavy filter banks on quota errors).
    this.lastSaveError = null;
  }

  // Save data. `quiet` demotes the failure logs to debug for callers that
  // handle the failure themselves (their retry logs the final outcome).
  save(data, { quiet = false } = {}) {
    try {
      // Remove circular references before stringifying
      const sanitizedData = this.removeCircularReferences(data);

      // Store the sanitized data
      localStorage.setItem(this.storageKey, sanitizedData);
      this.lastSaveError = null;
      lm.debug('Saved data');
      return true;
    } catch (error) {
      this.lastSaveError = error;
      const report = message => (quiet ? lm.debug(message) : lm.error(message));
      if (error.name === 'QuotaExceededError') {
        report('Storage quota exceeded - unable to save data');
      } else {
        report(`Error saving data: ${error.message}`);
      }
      return false;
    }
  }

  // Helper method to remove circular references
  removeCircularReferences(obj) {
    // Cycle = the value is one of its own ANCESTORS. A global "seen" set
    // would also drop legitimate shared references (e.g. the duplicated
    // subwoofer bank channels sharing one filter array) and corrupt the
    // saved payload — only the ancestor stack detects true cycles.
    const stack = [];

    return JSON.stringify(obj, function (key, value) {
      // Skip DOM nodes and functions
      if (value instanceof Node) return undefined;
      if (typeof value === 'function') return undefined;

      if (typeof value === 'object' && value !== null) {
        // `this` is the holder: unwind the stack to the current depth.
        while (stack.length > 0 && stack.at(-1) !== this) {
          stack.pop();
        }
        if (stack.includes(value)) {
          return undefined;
        }
        stack.push(value);
      }
      return value;
    });
  }

  load() {
    try {
      const data = localStorage.getItem(this.storageKey);
      lm.debug('Loaded data');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      lm.error(`Error loading data: ${error.message}`);
      return null;
    }
  }

  // Clear data
  clear() {
    try {
      localStorage.removeItem(this.storageKey);
      return true;
    } catch (error) {
      lm.error(`Error clearing data: ${error.message}`);
      return false;
    }
  }

  // Helper method to check if storage is available
  static isStorageAvailable() {
    try {
      const test = '__storage_test__';
      localStorage.setItem(test, test);
      localStorage.removeItem(test);
      return true;
    } catch {
      return false;
    }
  }
}

export default PersistentStore;
