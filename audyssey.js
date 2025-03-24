const CHANNEL_TYPES = {
  // Speaker channels
  EnChannelType_FrontLeft: {
    measurementOrder: 0,
    channelIndex: 0,
    code: 'FL',
    group: 'Front',
  },
  EnChannelType_Center: {
    measurementOrder: 1,
    channelIndex: 1,
    code: 'C',
    group: 'Center',
  },
  EnChannelType_FrontRight: {
    measurementOrder: 2,
    channelIndex: 2,
    code: 'FR',
    group: 'Front',
  },
  EnChannelType_FrontWideRight: {
    measurementOrder: 3,
    channelIndex: 3,
    code: 'FWR',
    group: 'FrontWide',
  },
  EnChannelType_SurrRight: {
    measurementOrder: 4,
    channelIndex: 4,
    code: 'SRA',
    group: 'SurroundA',
  },
  EnChannelType_SurrRightA: {
    measurementOrder: 5,
    channelIndex: 5,
    code: 'SRA',
    group: 'SurroundA',
  },
  EnChannelType_SurrRightB: {
    measurementOrder: 6,
    channelIndex: 6,
    code: 'SRB',
    group: 'SurroundB',
  },
  // EnChannelType_SurrRightC: { measurementOrder: 7, channelIndex: 7, code: null },
  EnChannelType_SBackRight: {
    measurementOrder: 8,
    channelIndex: 8,
    code: 'SBR',
    group: 'SurroundBack',
  },
  EnChannelType_SBackCenter: {
    measurementOrder: 9,
    channelIndex: 9,
    code: 'SBL',
    group: 'SurroundBack',
  },
  EnChannelType_SBackLeft: {
    measurementOrder: 10,
    channelIndex: 10,
    code: 'SBL',
    group: 'SurroundBack',
  },
  // EnChannelType_SurrLeftC: { measurementOrder: 11, channelIndex: 11, code: null },
  EnChannelType_SurrLeftB: {
    measurementOrder: 12,
    channelIndex: 12,
    code: 'SLB',
    group: 'SurroundB',
  },
  EnChannelType_SurrLeftA: {
    measurementOrder: 13,
    channelIndex: 13,
    code: 'SLA',
    group: 'SurroundA',
  },
  EnChannelType_SurrLeft: {
    measurementOrder: 14,
    channelIndex: 14,
    code: 'SLA',
    group: 'SurroundA',
  },
  EnChannelType_FrontWideLeft: {
    measurementOrder: 15,
    channelIndex: 15,
    code: 'FWL',
    group: 'FrontWide',
  },
  EnChannelType_FrontHeightRight: {
    measurementOrder: 16,
    channelIndex: 18,
    code: 'FHR',
    group: 'FrontHeight',
  },
  EnChannelType_FrontDolbyRight: {
    measurementOrder: 17,
    channelIndex: 20,
    code: 'FDR',
    group: 'FrontDolby',
  },
  EnChannelType_TopFrontRight: {
    measurementOrder: 18,
    channelIndex: 19,
    code: 'TFR',
    group: 'TopFront',
  },
  EnChannelType_TopMiddleRight: {
    measurementOrder: 19,
    channelIndex: 21,
    code: 'TMR',
    group: 'TopMiddle',
  },
  EnChannelType_SurrDolbyRight: {
    measurementOrder: 20,
    channelIndex: 26,
    code: 'SDR',
    group: 'SurroundDolby',
  },
  EnChannelType_TopBackRight: {
    measurementOrder: 21,
    channelIndex: 22,
    code: 'TRR',
    group: 'TopBack',
  },
  EnChannelType_SurrHeightRight: {
    measurementOrder: 22,
    channelIndex: 24,
    code: 'SHR',
    group: 'SurroundHeight',
  },
  EnChannelType_RearHeightRight: {
    measurementOrder: 23,
    channelIndex: 25,
    code: 'RHR',
    group: 'RearHeight',
  },
  EnChannelType_SBDolbyRight: {
    measurementOrder: 24,
    channelIndex: 28,
    code: 'BDR',
    group: 'SBDolby',
  },
  EnChannelType_SBDolbyLeft: {
    measurementOrder: 25,
    channelIndex: 30,
    code: 'BDL',
    group: 'SBDolby',
  },
  EnChannelType_RearHeightLeft: {
    measurementOrder: 26,
    channelIndex: 33,
    code: 'RHL',
    group: 'RearHeight',
  },
  EnChannelType_SurrHeightLeft: {
    measurementOrder: 27,
    channelIndex: 34,
    code: 'SHL',
    group: 'SurroundHeight',
  },
  EnChannelType_TopBackLeft: {
    measurementOrder: 28,
    channelIndex: 36,
    code: 'TRL',
    group: 'TopBack',
  },
  EnChannelType_SurrDolbyLeft: {
    measurementOrder: 29,
    channelIndex: 32,
    code: 'SDL',
    group: 'SurroundDolby',
  },
  EnChannelType_TopMiddleLeft: {
    measurementOrder: 30,
    channelIndex: 37,
    code: 'TML',
    group: 'TopMiddle',
  },
  EnChannelType_TopFrontLeft: {
    measurementOrder: 31,
    channelIndex: 39,
    code: 'TFL',
    group: 'TopFront',
  },
  EnChannelType_FrontDolbyLeft: {
    measurementOrder: 32,
    channelIndex: 38,
    code: 'FDL',
    group: 'FrontDolby',
  },
  EnChannelType_FrontHeightLeft: {
    measurementOrder: 33,
    channelIndex: 40,
    code: 'FHL',
    group: 'FrontHeight',
  },
  EnChannelType_FrontHeightCenter: {
    measurementOrder: 34,
    channelIndex: 16,
    code: 'CH',
    group: 'FrontHeightCenter',
  },
  EnChannelType_Overhead: { measurementOrder: 35, channelIndex: 41, code: 'TS' },
  // EnChannelType_FrontHeightWideRight: { measurementOrder: 36, channelIndex: 23, code: null },
  // EnChannelType_SBHeightRight: { measurementOrder: 37, channelIndex: 27, code: null },
  // EnChannelType_SBHeightLeft: { measurementOrder: 38, channelIndex: 31, code: null },
  // EnChannelType_FrontHeightWideLeft: { measurementOrder: 39, channelIndex: 35, code: null },
  // EnChannelType_FrontDolbyCenter: { measurementOrder: 40, channelIndex: 17, code: null },
  // EnChannelType_SBDolbyCenter: { measurementOrder: 41, channelIndex: 29, code: null },

  // Subwoofer channels
  EnChannelType_SWLFE: {
    measurementOrder: 42,
    channelIndex: 42,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWLeft2sp: {
    measurementOrder: 42,
    channelIndex: 43,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWLeft3sp: {
    measurementOrder: 42,
    channelIndex: 44,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWRight2sp: {
    measurementOrder: 43,
    channelIndex: 45,
    code: 'SW2',
    group: 'Subwoofer',
  },
  EnChannelType_SWRight3sp: {
    measurementOrder: 43,
    channelIndex: 46,
    code: 'SW2',
    group: 'Subwoofer',
  },
  EnChannelType_SWFront2sp: {
    measurementOrder: 42,
    channelIndex: 47,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWFront3sp: {
    measurementOrder: 42,
    channelIndex: 48,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWBack2sp: {
    measurementOrder: 43,
    channelIndex: 49,
    code: 'SW2',
    group: 'Subwoofer',
  },
  EnChannelType_SWBack3sp: {
    measurementOrder: 44,
    channelIndex: 50,
    code: 'SW3',
    group: 'Subwoofer',
  },
  EnChannelType_SWMiddle2sp: {
    measurementOrder: 51,
    channelIndex: 51,
    code: null,
    group: 'Subwoofer',
  },
  EnChannelType_SWLFE2sp: {
    measurementOrder: 42,
    channelIndex: 52,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWLFE3sp: {
    measurementOrder: 42,
    channelIndex: 53,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWLFE4sp: {
    measurementOrder: 42,
    channelIndex: 65,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWMix1: {
    measurementOrder: 42,
    channelIndex: 54,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWMix2: {
    measurementOrder: 43,
    channelIndex: 55,
    code: 'SW2',
    group: 'Subwoofer',
  },
  EnChannelType_SWMix3: {
    measurementOrder: 44,
    channelIndex: 56,
    code: 'SW3',
    group: 'Subwoofer',
  },
  EnChannelType_SWMix4: {
    measurementOrder: 45,
    channelIndex: 57,
    code: 'SW4',
    group: 'Subwoofer',
  },
  EnChannelType_SWFrontLeft3sp: {
    measurementOrder: 42,
    channelIndex: 58,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWFrontLeft4sp: {
    measurementOrder: 42,
    channelIndex: 59,
    code: 'SW1',
    group: 'Subwoofer',
  },
  EnChannelType_SWFrontRight4sp: {
    measurementOrder: 43,
    channelIndex: 60,
    code: 'SW2',
    group: 'Subwoofer',
  },
  EnChannelType_SWFrontRight3sp: {
    measurementOrder: 43,
    channelIndex: 61,
    code: 'SW2',
    group: 'Subwoofer',
  },
  EnChannelType_SWRear3sp: {
    measurementOrder: 44,
    channelIndex: 64,
    code: 'SW3',
    group: 'Subwoofer',
  },
  EnChannelType_SWBackLeft4sp: {
    measurementOrder: 44,
    channelIndex: 62,
    code: 'SW3',
    group: 'Subwoofer',
  },
  EnChannelType_SWBackRight4sp: {
    measurementOrder: 45,
    channelIndex: 63,
    code: 'SW4',
    group: 'Subwoofer',
  },
  EnChannelType_SWMode: { measurementOrder: -1, channelIndex: -1, code: null },
  EnChannelType_SWLayout: { measurementOrder: -2, channelIndex: -2, code: null },

  // Helper methods
  getByMeasurementOrder(order) {
    return Object.entries(this).find(
      ([key, value]) => value.measurementOrder === order && typeof value === 'object'
    )?.[1];
  },

  getByChannelIndex(index) {
    return Object.entries(this).find(
      ([key, value]) => value.channelIndex === index && typeof value === 'object'
    )?.[1];
  },

  getByCode(code) {
    // Return early if code is not provided or invalid
    if (!code || typeof code !== 'string') return null;

    if (code.startsWith('SW')) {
      const neededKey = `EnChannelType_SWMix${code.slice(2)}`;
      const result = this[neededKey];
      if (!result) {
        console.error(`Subwoofer channel code ${code} not found`);
        return null;
      }
      return result;
    }

    const matchingResults = Object.values(this).filter(
      value => value?.code === code && typeof value === 'object'
    );

    if (!matchingResults.length === 0) {
      // return default SWMode channel if code is not found
      return this.EnChannelType_SWMode;
    }

    if (matchingResults.length > 1) {
      console.error(
        `Ambiguous channel code: ${code} matches multiple channel types: ${matchingResults.map(value => value.channelIndex).join(', ')}`
      );
    }

    return matchingResults?.[0];
  },

  /**
   * Finds the best matching channel code(s) for a given name
   * @param {string} name - The name to match against channel codes
   * @returns {string[]|null} Array of matching channel codes or null if no name provided
   */
  getBestMatchCode(name) {
    if (!name) return null;
    // Convert name to uppercase for case-insensitive comparison
    const searchTerm = name.toUpperCase();

    const subwooferMap = {
      SW1: ['SWL', 'SWFL', 'SWMIX1'],
      SW2: ['SWR', 'SWFR', 'SWMIX2'],
      SW3: ['SWBL', 'SWMIX3'],
      SW4: ['SWBR', 'SWMIX4'],
    };
    // check if searchTerm is include into subwooferMap
    for (const [key, values] of Object.entries(subwooferMap)) {
      if (values.some(channel => searchTerm.startsWith(channel))) {
        return key;
      }
    }
    // Get all channel types from the CHANNEL_TYPES object
    const channels = Object.values(CHANNEL_TYPES);
    // Process channels to find matches
    const matchingChannels = channels
      .filter(channel => searchTerm.startsWith(channel.code))
      .sort((a, b) => a.measurementOrder - b.measurementOrder);
    // if not found return
    if (matchingChannels.length === 0) return null;
    // Extract and return only the channel codes from matching channels
    const result = matchingChannels.map(channel => channel.code);
    // removes duplicates
    const uniqueCodes = [...new Set(result)];
    // if multiple results match
    if (uniqueCodes.length > 1) {
      console.error(
        `Ambiguous channel name: ${name} matches multiple channel codes: ${result.join(', ')}`
      );
      return null;
    }
    // return only the first match
    return uniqueCodes[0];
  },

  getAllDistinctCodes() {
    // Get all channel values
    const channels = Object.values(CHANNEL_TYPES);

    // Filter valid channels
    const validChannels = channels.filter(
      channel => channel && typeof channel === 'object' && channel.code
    );

    // Sort by measurement order
    const sortedChannels = validChannels.sort(
      (a, b) => a.measurementOrder - b.measurementOrder
    );

    // keep only codes
    const validCodes = sortedChannels.map(channel => channel.code);

    // Remove duplicates
    const uniqueCodes = [...new Set(validCodes)];

    // Return codes in sorted order
    return uniqueCodes;
  },

  getMeasurementOrder(channelType) {
    return this[channelType]?.measurementOrder;
  },

  getChannelIndex(channelType) {
    return this[channelType]?.channelIndex;
  },

  getCode(channelType) {
    return this[channelType]?.code;
  },
};

// Make the object immutable
Object.freeze(CHANNEL_TYPES);

// Export for module usage
export { CHANNEL_TYPES };
