/**
 * validators.js
 * Fonctions de validation communes pour AutoEQ
 */

/**
 * Valide une fonction callback
 * @param {*} fn
 * @param {string} name
 * @param {boolean} allowNull - Si true, retourne une fonction vide si null/undefined
 * @returns {Function}
 */
export function validateFunction(fn, name, allowNull = true) {
  if (fn === null || fn === undefined) {
    if (allowNull) return () => {};
    throw new TypeError(`${name} is required and must be a function`);
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`${name} must be a function, got ${typeof fn}`);
  }
  return fn;
}

/**
 * Valide un nombre avec bornes et valeur par défaut
 * @param {*} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {number|null} defaultValue
 * @returns {number}
 */
export function validateNumber(
  value,
  name,
  min = -Infinity,
  max = Infinity,
  defaultValue = null,
) {
  if (value === undefined || value === null) {
    if (defaultValue !== null) return defaultValue;
    throw new TypeError(`${name} is required`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${value}`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/**
 * Valide un booléen avec valeur par défaut
 * @param {*} value
 * @param {string} name
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
export function validateBoolean(value, name, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean, got ${typeof value}`);
  }
  return value;
}
