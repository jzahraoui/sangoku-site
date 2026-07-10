/**
 * Pure numeric/comparison helpers extracted from MeasurementItem
 *.
 *
 * [MOTEUR] module: no Knockout, no DOM, no logger — callers inject
 * side-effects where needed.
 */

/**
 * Round a value to the given decimal precision, returning 0 for anything
 * non-finite. `onInvalid` (optional) is called with the raw value when it
 * cannot be interpreted as a finite number.
 */
function cleanFloat32Value(value, precision = 7, onInvalid = null) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    onInvalid?.(value);
    return 0;
  }
  const multiplier = 10 ** precision;
  return Math.round(num * multiplier) / multiplier;
}

function secondsToMeters(valueInSeconds, speedOfSound) {
  if (!Number.isFinite(valueInSeconds)) return 0;
  return valueInSeconds * speedOfSound;
}

function metersToSeconds(valueInMeters, speedOfSound) {
  if (!Number.isFinite(valueInMeters)) return 0;
  return valueInMeters / speedOfSound;
}

function arraysMatchWithTolerance(arr1, arr2, tolerance = 0.01) {
  return (
    Array.isArray(arr1) &&
    Array.isArray(arr2) &&
    arr1.length === arr2.length &&
    arr1.every((val, i) => Math.abs(val - arr2[i]) < tolerance)
  );
}

/**
 * Compare an IR-windows object served by REW (`source`) against a wanted
 * configuration (`target`). Attributes absent from `target` accept any
 * source value; numeric attributes match at 2-decimal precision.
 */
function compareIrWindows(source, target) {
  if (!source || !target) return false;

  const matches = (sourceVal, targetVal) => {
    if (targetVal === undefined) return true;
    return sourceVal === targetVal;
  };

  const numbersMatch = (sourceVal, targetVal) => {
    if (targetVal === undefined) return true;
    if (sourceVal === undefined) return false;
    return sourceVal.toFixed(2) === targetVal.toFixed(2);
  };

  return (
    matches(source.leftWindowType, target.leftWindowType) &&
    matches(source.rightWindowType, target.rightWindowType) &&
    numbersMatch(source.leftWindowWidthms, target.leftWindowWidthms) &&
    numbersMatch(source.rightWindowWidthms, target.rightWindowWidthms) &&
    numbersMatch(source.refTimems, target.refTimems) &&
    matches(source.addFDW, target.addFDW) &&
    matches(source.addMTW, target.addMTW) &&
    (!target.mtwTimesms || arraysMatchWithTolerance(source.mtwTimesms, target.mtwTimesms))
  );
}

/** Key-order-insensitive shallow JSON equality. */
function compareObjectsSorted(obj1, obj2) {
  const sortedStringify = obj =>
    JSON.stringify(
      Object.keys(obj)
        .sort((a, b) => a.localeCompare(b))
        .reduce((sorted, key) => {
          sorted[key] = obj[key];
          return sorted;
        }, {}),
    );

  return sortedStringify(obj1) === sortedStringify(obj2);
}

/** First index whose value is >= `value` (array sorted ascending). */
function binarySearchLowerBound(arr, value) {
  let lo = 0;
  let hi = arr.length;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

export {
  arraysMatchWithTolerance,
  binarySearchLowerBound,
  cleanFloat32Value,
  compareIrWindows,
  compareObjectsSorted,
  metersToSeconds,
  secondsToMeters,
};
