const values = [
  'Normal',
  'Zone2',
  'Zone3',
  'Zone2_3',
  'BiAmp',
  'ZoneMono',
  '2chBiAmp',
  '2ch',
  'FrontHi',
  'FrontWi',
  'FrontB',
  '9ch',
  '11ch',
  'PreAmp',
  'BiAmpZ2',
  'Free',
  'Atmos',
  'Auro3D',
  'TFront',
  'TMiddle',
  'FDolby',
  'SDolby',
];

const ampAssignType = Object.freeze({
  ...Object.fromEntries(values.map(v => [v, v])),
  getByIndex: index => {
    if (index < 0 || index >= values.length) return null;
    return values[index];
  },
  getIndexByValue: value => {
    return values.indexOf(value);
  },
});

export default ampAssignType;
