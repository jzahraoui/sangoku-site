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
    if (index < 1 || index >= values.length + 1)
      throw new Error(`Invalid EnAmpAssignType index: ${index}`);
    return values[index - 1];
  },
  getIndexByValue: value => {
    const index = values.indexOf(value);
    if (index === -1) throw new Error(`Invalid EnAmpAssignType value: ${value}`);
    return index + 1;
  },
});

export default ampAssignType;
