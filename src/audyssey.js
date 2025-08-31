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
    position: 'Center',
  },
  EnChannelType_FrontRight: {
    measurementOrder: 2,
    channelIndex: 2,
    code: 'FR',
    group: 'Front',
    position: 'Right',
  },
  EnChannelType_FrontWideRight: {
    measurementOrder: 3,
    channelIndex: 3,
    code: 'FWR',
    group: 'FrontWide',
    position: 'Right',
  },
  EnChannelType_SurrRight: {
    measurementOrder: 4,
    channelIndex: 4,
    code: 'SRA',
    group: 'Surround',
    position: 'Right',
  },
  EnChannelType_SurrRightA: {
    measurementOrder: 5,
    channelIndex: 5,
    code: 'SRA',
    group: 'SurroundA',
    position: 'Right',
  },
  EnChannelType_SurrRightB: {
    measurementOrder: 6,
    channelIndex: 6,
    code: 'SRB',
    group: 'SurroundB',
    position: 'Right',
  },
  // EnChannelType_SurrRightC: { measurementOrder: 7, channelIndex: 7, code: null },
  EnChannelType_SBackRight: {
    measurementOrder: 8,
    channelIndex: 8,
    code: 'SBR',
    group: 'SurroundBack',
    position: 'Right',
  },
  EnChannelType_SBackCenter: {
    measurementOrder: 9,
    channelIndex: 9,
    code: 'SBL',
    group: 'SurroundBack',
    position: 'Center',
  },
  EnChannelType_SBackLeft: {
    measurementOrder: 10,
    channelIndex: 10,
    code: 'SBL',
    group: 'SurroundBack',
    position: 'Left',
  },
  // EnChannelType_SurrLeftC: { measurementOrder: 11, channelIndex: 11, code: null },
  EnChannelType_SurrLeftB: {
    measurementOrder: 12,
    channelIndex: 12,
    code: 'SLB',
    group: 'SurroundB',
    position: 'Left',
  },
  EnChannelType_SurrLeftA: {
    measurementOrder: 13,
    channelIndex: 13,
    code: 'SLA',
    group: 'SurroundA',
    position: 'Left',
  },
  EnChannelType_SurrLeft: {
    measurementOrder: 14,
    channelIndex: 14,
    code: 'SLA',
    group: 'Surround',
    position: 'Left',
  },
  EnChannelType_FrontWideLeft: {
    measurementOrder: 15,
    channelIndex: 15,
    code: 'FWL',
    group: 'FrontWide',
    position: 'Left',
  },
  EnChannelType_FrontHeightRight: {
    measurementOrder: 16,
    channelIndex: 18,
    code: 'FHR',
    group: 'FrontHeight',
    position: 'Right',
  },
  EnChannelType_FrontDolbyRight: {
    measurementOrder: 17,
    channelIndex: 20,
    code: 'FDR',
    group: 'FrontDolby',
    position: 'Right',
  },
  EnChannelType_TopFrontRight: {
    measurementOrder: 18,
    channelIndex: 19,
    code: 'TFR',
    group: 'TopFront',
    position: 'Right',
  },
  EnChannelType_TopMiddleRight: {
    measurementOrder: 19,
    channelIndex: 21,
    code: 'TMR',
    group: 'TopMiddle',
    position: 'Right',
  },
  EnChannelType_SurrDolbyRight: {
    measurementOrder: 20,
    channelIndex: 26,
    code: 'SDR',
    group: 'SurroundDolby',
    position: 'Right',
  },
  EnChannelType_TopBackRight: {
    measurementOrder: 21,
    channelIndex: 22,
    code: 'TRR',
    group: 'TopBack',
    position: 'Right',
  },
  EnChannelType_SurrHeightRight: {
    measurementOrder: 22,
    channelIndex: 24,
    code: 'SHR',
    group: 'SurroundHeight',
    position: 'Right',
  },
  EnChannelType_RearHeightRight: {
    measurementOrder: 23,
    channelIndex: 25,
    code: 'RHR',
    group: 'RearHeight',
    position: 'Right',
  },
  EnChannelType_SBDolbyRight: {
    measurementOrder: 24,
    channelIndex: 28,
    code: 'BDR',
    group: 'SBDolby',
    position: 'Right',
  },
  EnChannelType_SBDolbyLeft: {
    measurementOrder: 25,
    channelIndex: 30,
    code: 'BDL',
    group: 'SBDolby',
    position: 'Left',
  },
  EnChannelType_RearHeightLeft: {
    measurementOrder: 26,
    channelIndex: 33,
    code: 'RHL',
    group: 'RearHeight',
    position: 'Left',
  },
  EnChannelType_SurrHeightLeft: {
    measurementOrder: 27,
    channelIndex: 34,
    code: 'SHL',
    group: 'SurroundHeight',
    position: 'Left',
  },
  EnChannelType_TopBackLeft: {
    measurementOrder: 28,
    channelIndex: 36,
    code: 'TRL',
    group: 'TopBack',
    position: 'Left',
  },
  EnChannelType_SurrDolbyLeft: {
    measurementOrder: 29,
    channelIndex: 32,
    code: 'SDL',
    group: 'SurroundDolby',
    position: 'Left',
  },
  EnChannelType_TopMiddleLeft: {
    measurementOrder: 30,
    channelIndex: 37,
    code: 'TML',
    group: 'TopMiddle',
    position: 'Left',
  },
  EnChannelType_TopFrontLeft: {
    measurementOrder: 31,
    channelIndex: 39,
    code: 'TFL',
    group: 'TopFront',
    position: 'Left',
  },
  EnChannelType_FrontDolbyLeft: {
    measurementOrder: 32,
    channelIndex: 38,
    code: 'FDL',
    group: 'FrontDolby',
    position: 'Left',
  },
  EnChannelType_FrontHeightLeft: {
    measurementOrder: 33,
    channelIndex: 40,
    code: 'FHL',
    group: 'FrontHeight',
    position: 'Left',
  },
  EnChannelType_FrontHeightCenter: {
    measurementOrder: 34,
    channelIndex: 16,
    code: 'CH',
    group: 'FrontHeightCenter',
    position: 'Center',
  },
  EnChannelType_Overhead: {
    measurementOrder: 35,
    channelIndex: 41,
    code: 'TS',
    position: 'None',
  },
  // EnChannelType_FrontHeightWideRight: { measurementOrder: 36, channelIndex: 23, code: null, position: 'Right' },
  // EnChannelType_SBHeightRight: { measurementOrder: 37, channelIndex: 27, code: null, position: 'Right' },
  // EnChannelType_SBHeightLeft: { measurementOrder: 38, channelIndex: 31, code: null, position: 'Left' },
  // EnChannelType_FrontHeightWideLeft: { measurementOrder: 39, channelIndex: 35, code: null, position: 'Left' },
  // EnChannelType_FrontDolbyCenter: { measurementOrder: 40, channelIndex: 17, code: null, position: 'Center' },
  // EnChannelType_SBDolbyCenter: { measurementOrder: 41, channelIndex: 29, code: null, position: 'Center' },

  // Subwoofer channels
  EnChannelType_SWLFE: {
    measurementOrder: 42,
    channelIndex: 42,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWLeft2sp: {
    measurementOrder: 42,
    channelIndex: 43,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'Left',
  },
  EnChannelType_SWLeft3sp: {
    measurementOrder: 42,
    channelIndex: 44,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'Left',
  },
  EnChannelType_SWRight2sp: {
    measurementOrder: 43,
    channelIndex: 45,
    code: 'SW2',
    group: 'Subwoofer',
    position: 'Right',
  },
  EnChannelType_SWRight3sp: {
    measurementOrder: 43,
    channelIndex: 46,
    code: 'SW2',
    group: 'Subwoofer',
    position: 'Right',
  },
  EnChannelType_SWFront2sp: {
    measurementOrder: 42,
    channelIndex: 47,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'Front',
  },
  EnChannelType_SWFront3sp: {
    measurementOrder: 42,
    channelIndex: 48,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'Front',
  },
  EnChannelType_SWBack2sp: {
    measurementOrder: 43,
    channelIndex: 49,
    code: 'SW2',
    group: 'Subwoofer',
    position: 'Back',
  },
  EnChannelType_SWBack3sp: {
    measurementOrder: 44,
    channelIndex: 50,
    code: 'SW3',
    group: 'Subwoofer',
    position: 'Back',
  },
  EnChannelType_SWMiddle2sp: {
    measurementOrder: 51,
    channelIndex: 51,
    code: null,
    group: 'Subwoofer',
    position: 'Middle',
  },
  EnChannelType_SWLFE2sp: {
    measurementOrder: 42,
    channelIndex: 52,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWLFE3sp: {
    measurementOrder: 42,
    channelIndex: 53,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWLFE4sp: {
    measurementOrder: 42,
    channelIndex: 65,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWMix1: {
    measurementOrder: 42,
    channelIndex: 54,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWMix2: {
    measurementOrder: 43,
    channelIndex: 55,
    code: 'SW2',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWMix3: {
    measurementOrder: 44,
    channelIndex: 56,
    code: 'SW3',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWMix4: {
    measurementOrder: 45,
    channelIndex: 57,
    code: 'SW4',
    group: 'Subwoofer',
    position: 'None',
  },
  EnChannelType_SWFrontLeft3sp: {
    measurementOrder: 42,
    channelIndex: 58,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'FrontLeft',
  },
  EnChannelType_SWFrontLeft4sp: {
    measurementOrder: 42,
    channelIndex: 59,
    code: 'SW1',
    group: 'Subwoofer',
    position: 'FrontLeft',
  },
  EnChannelType_SWFrontRight4sp: {
    measurementOrder: 43,
    channelIndex: 60,
    code: 'SW2',
    group: 'Subwoofer',
    position: 'FrontRight',
  },
  EnChannelType_SWFrontRight3sp: {
    measurementOrder: 43,
    channelIndex: 61,
    code: 'SW2',
    group: 'Subwoofer',
    position: 'FrontRight',
  },
  EnChannelType_SWRear3sp: {
    measurementOrder: 44,
    channelIndex: 64,
    code: 'SW3',
    group: 'Subwoofer',
    position: 'Rear',
  },
  EnChannelType_SWBackLeft4sp: {
    measurementOrder: 44,
    channelIndex: 62,
    code: 'SW3',
    group: 'Subwoofer',
    position: 'BackLeft',
  },
  EnChannelType_SWBackRight4sp: {
    measurementOrder: 45,
    channelIndex: 63,
    code: 'SW4',
    group: 'Subwoofer',
    position: 'BackRight',
  },
  EnChannelType_SWMode: {
    measurementOrder: -1,
    channelIndex: -1,
    code: null,
    position: 'None',
  },
  EnChannelType_SWLayout: {
    measurementOrder: -2,
    channelIndex: -2,
    code: null,
    position: 'None',
  },

  // Helper methods
  getByMeasurementOrder(order) {
    return Object.values(this).find(
      value => value.measurementOrder === order && typeof value === 'object'
    );
  },

  getByChannelIndex(index) {
    return Object.values(this).find(
      value => value.channelIndex === index && typeof value === 'object'
    );
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

    if (matchingResults.length === 0) {
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

  getStandardSubwooferName(subName) {
    if (!subName) return null;

    const searchTerm = subName.toUpperCase();

    // Define standard mapping for subwoofer channel names
    const SUBWOOFER_MAPPINGS = {
      // Left channel subwoofers
      SW1: 'SW1', // Subwoofer Mix 1
      SWL: 'SW1', // Subwoofer Left
      SWFL: 'SW1', // Subwoofer Front Left
      SWMIX1: 'SW1', // Subwoofer Mix 1

      // Right channel subwoofers
      SW2: 'SW2', // Subwoofer Mix 2
      SWR: 'SW2', // Subwoofer Right
      SWFR: 'SW2', // Subwoofer Front Right
      SWMIX2: 'SW2', // Subwoofer Mix 2

      // Back Left channel subwoofers
      SW3: 'SW3', // Subwoofer Mix 3
      SWBL: 'SW3', // Subwoofer Back Left
      SWMIX3: 'SW3', // Subwoofer Mix 3

      // Back Right channel subwoofers
      SW4: 'SW4', // Subwoofer Mix 4
      SWBR: 'SW4', // Subwoofer Back Right
      SWMIX4: 'SW4', // Subwoofer Mix 4
    };

    // Find matching subwoofer channel
    for (const [channel, standardName] of Object.entries(SUBWOOFER_MAPPINGS)) {
      if (searchTerm.startsWith(channel)) {
        return standardName;
      }
    }

    // Return original name if no standard mapping found
    return subName;
  },

  /**
   * Finds the best matching channel code(s) for a given name
   * @param {string} name - The name to match against channel codes
   * @returns {string[]|null} Array of matching channel codes or null if no name provided
   */
  getBestMatchCode(name) {
    if (!name) return null;

    name = name.toUpperCase();

    if (name.startsWith('SW')) {
      return this.getStandardSubwooferName(name);
    }

    // Get all channel types from the CHANNEL_TYPES object
    const channels = Object.values(CHANNEL_TYPES);
    // Process channels to find matches
    const matchingChannels = channels
      .filter(channel => name.startsWith(channel.code))
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
    return [...new Set(
      Object.values(CHANNEL_TYPES)
        .filter(channel => channel && typeof channel === 'object' && channel.code)
        .sort((a, b) => a.measurementOrder - b.measurementOrder)
        .map(channel => channel.code)
    )];
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

  getGroup(channelType) {
    return this[channelType]?.group;
  },

  getGroupMembers(groupName) {
    return Object.values(CHANNEL_TYPES).filter(channel => channel.group === groupName);
  },
};

// Make the object immutable
Object.freeze(CHANNEL_TYPES);

// Export for module usage
export { CHANNEL_TYPES };
