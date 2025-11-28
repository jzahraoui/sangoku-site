import lm from './logs.js';

class PersistentStore {
  constructor(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new Error('Storage key must be a non-empty string');
    }
    this.storageKey = storageKey;
  }

  // Save data
  save(data) {
    try {
      // Remove circular references before stringifying
      const sanitizedData = this.removeCircularReferences(data);

      // Store the sanitized data
      localStorage.setItem(this.storageKey, sanitizedData);
      lm.debug('Saved data');
      return true;
    } catch (error) {
      if (error.name === 'QuotaExceededError') {
        lm.error('Storage quota exceeded - unable to save data');
      } else {
        lm.error(`Error saving data: ${error.message}`);
      }
      return false;
    }
  }

  // Helper method to remove circular references
  removeCircularReferences(obj) {
    const seen = new WeakSet();

    return JSON.stringify(obj, (key, value) => {
      // Skip DOM nodes and functions
      if (value instanceof Node) return undefined;
      if (typeof value === 'function') return undefined;

      // Handle circular references
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return undefined;
        }
        seen.add(value);
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
