
class PersistentStore {
  constructor(storageKey) {
    if (!storageKey || typeof storageKey !== 'string') {
      throw new Error('Storage key must be a non-empty string');
    }
    this.storageKey = storageKey;
    // Bind the save method to this instance
    this.save = this.save.bind(this);

  }

  // Save data
  save(data) {
    try {
      // Remove circular references before stringifying
      const sanitizedData = this.removeCircularReferences(data);
      // const sanitizedData = JSON.stringify(plainData);
      // Store the sanitized data
      localStorage.setItem(this.storageKey, sanitizedData);
      console.debug('Saved data');
      return true;
    } catch (error) {
      console.error('Error saving data:' + error.message, error);
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
      console.debug('Loaded data');
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error loading data:', error);
      return null;
    }
  }

  // Clear data
  clear() {
    try {
      this._data = {};
      localStorage.removeItem(this.storageKey);
      return true;
    } catch (error) {
      console.error('Error clearing data:', error);
      return false;
    }
  }
  destroy() {
    // Clean up event listeners
    window.removeEventListener('beforeunload', this._boundSave);
    this.clear();
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