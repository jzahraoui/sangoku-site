/**
 * REW working-settings presets (smoothing / IR windows) used by the alignment
 * and filter sequences. [MOTEUR] module, zero dependency.
 *
 * IR_WINDOW_PRESETS mirrors the POJO currently inline in MeasurementViewModel.js
 * (to be unified when the Knockout entry is retired — same mirroring precedent
 * as the averaging/predicted title constants).
 */

const DEFAULT_IR_WINDOW_CHOICE = 'Optimized MTW';
const FALLBACK_IR_WINDOW_CHOICE = 'None';
const DEFAULT_SMOOTHING_METHOD = 'None';

const IR_WINDOW_PRESETS = {
  None: {
    leftWindowType: 'Rectangular',
    rightWindowType: 'Rectangular',
    addFDW: false,
    addMTW: false,
  },
  'Optimized MTW': {
    leftWindowType: 'Rectangular',
    rightWindowType: 'Rectangular',
    addFDW: false,
    addMTW: true,
    mtwTimesms: [9000, 3000, 450, 120, 30, 7.7, 2.6, 0.9, 0.4, 0.15],
  },
};

/** Deep-ish copy of the preset (mtwTimesms cloned), like VM.getIrWindowConfig. */
function getIrWindowConfig(presetName = DEFAULT_IR_WINDOW_CHOICE) {
  const preset =
    IR_WINDOW_PRESETS[presetName] ?? IR_WINDOW_PRESETS[FALLBACK_IR_WINDOW_CHOICE];
  return {
    ...preset,
    ...(preset.mtwTimesms ? { mtwTimesms: [...preset.mtwTimesms] } : {}),
  };
}

const irWindowChoices = () =>
  Object.keys(IR_WINDOW_PRESETS).map(value => ({ value, text: value }));

export {
  DEFAULT_IR_WINDOW_CHOICE,
  DEFAULT_SMOOTHING_METHOD,
  FALLBACK_IR_WINDOW_CHOICE,
  IR_WINDOW_PRESETS,
  getIrWindowConfig,
  irWindowChoices,
};
