/**
 * filterTypes.js
 *
 * Filter type constants for BiquadFilter.
 */

export const FILTER_TYPES = Object.freeze({
  NONE: 'NONE',
  PEAKING: 'PEAKING',
  ALL_PASS: 'ALL_PASS',
  LOW_PASS: 'LOW_PASS',
  HIGH_PASS: 'HIGH_PASS',
  LOW_PASS_1: 'LOW_PASS_1',
  HIGH_PASS_1: 'HIGH_PASS_1',
  NOTCH: 'NOTCH',
  LOW_SHELF: 'LOW_SHELF',
  HIGH_SHELF: 'HIGH_SHELF',
  MODAL: 'MODAL',
});

/** Variantes de pente des shelves REW (LS/HS, LS 6dB/HS 6dB, LS 12dB/HS 12dB). */
export const SHELF_VARIANTS = Object.freeze(['plain', '6dB', '12dB']);
