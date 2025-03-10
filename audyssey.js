const CHANNEL_TYPES = {
  // Speaker channels
  EnChannelType_FrontLeft: { measurementOrder: 0, channelIndex: 0, code: 'FL' },
  EnChannelType_Center: { measurementOrder: 1, channelIndex: 1, code: 'C' },
  EnChannelType_FrontRight: { measurementOrder: 2, channelIndex: 2, code: 'FR' },
  EnChannelType_FrontWideRight: { measurementOrder: 3, channelIndex: 3, code: 'FWR' },
  // EnChannelType_SurrRight: { measurementOrder: 4, channelIndex: 4, code: "SRA" },
  EnChannelType_SurrRightA: { measurementOrder: 5, channelIndex: 5, code: 'SRA' },
  EnChannelType_SurrRightB: { measurementOrder: 6, channelIndex: 6, code: 'SRB' },
  // EnChannelType_SurrRightC: { measurementOrder: 7, channelIndex: 7, code: null },
  EnChannelType_SBackRight: { measurementOrder: 8, channelIndex: 8, code: 'SBR' },
  // EnChannelType_SBackCenter: { measurementOrder: 9, channelIndex: 9, code: "SBL" },
  EnChannelType_SBackLeft: { measurementOrder: 10, channelIndex: 10, code: 'SBL' },
  // EnChannelType_SurrLeftC: { measurementOrder: 11, channelIndex: 11, code: null },
  EnChannelType_SurrLeftB: { measurementOrder: 12, channelIndex: 12, code: 'SLB' },
  EnChannelType_SurrLeftA: { measurementOrder: 13, channelIndex: 13, code: 'SLA' },
  // EnChannelType_SurrLeft: { measurementOrder: 14, channelIndex: 14, code: "SLA" },
  EnChannelType_FrontWideLeft: { measurementOrder: 15, channelIndex: 15, code: 'FWL' },
  EnChannelType_FrontHeightRight: { measurementOrder: 16, channelIndex: 18, code: 'FHR' },
  EnChannelType_FrontDolbyRight: { measurementOrder: 17, channelIndex: 20, code: 'FDR' },
  EnChannelType_TopFrontRight: { measurementOrder: 18, channelIndex: 19, code: 'TFR' },
  EnChannelType_TopMiddleRight: { measurementOrder: 19, channelIndex: 21, code: 'TMR' },
  EnChannelType_SurrDolbyRight: { measurementOrder: 20, channelIndex: 26, code: 'SDR' },
  EnChannelType_TopBackRight: { measurementOrder: 21, channelIndex: 22, code: 'TRR' },
  EnChannelType_SurrHeightRight: { measurementOrder: 22, channelIndex: 24, code: 'SHR' },
  EnChannelType_RearHeightRight: { measurementOrder: 23, channelIndex: 25, code: 'RHR' },
  EnChannelType_SBDolbyRight: { measurementOrder: 24, channelIndex: 28, code: 'BDR' },
  EnChannelType_SBDolbyLeft: { measurementOrder: 25, channelIndex: 30, code: 'BDL' },
  EnChannelType_RearHeightLeft: { measurementOrder: 26, channelIndex: 33, code: 'RHL' },
  EnChannelType_SurrHeightLeft: { measurementOrder: 27, channelIndex: 34, code: 'SHL' },
  EnChannelType_TopBackLeft: { measurementOrder: 28, channelIndex: 36, code: 'TRL' },
  EnChannelType_SurrDolbyLeft: { measurementOrder: 29, channelIndex: 32, code: 'SDL' },
  EnChannelType_TopMiddleLeft: { measurementOrder: 30, channelIndex: 37, code: 'TML' },
  EnChannelType_TopFrontLeft: { measurementOrder: 31, channelIndex: 39, code: 'TFL' },
  EnChannelType_FrontDolbyLeft: { measurementOrder: 32, channelIndex: 38, code: 'FDL' },
  EnChannelType_FrontHeightLeft: { measurementOrder: 33, channelIndex: 40, code: 'FHL' },
  EnChannelType_FrontHeightCenter: { measurementOrder: 34, channelIndex: 16, code: 'CH' },
  EnChannelType_Overhead: { measurementOrder: 35, channelIndex: 41, code: 'TS' },
  // EnChannelType_FrontHeightWideRight: { measurementOrder: 36, channelIndex: 23, code: null },
  // EnChannelType_SBHeightRight: { measurementOrder: 37, channelIndex: 27, code: null },
  // EnChannelType_SBHeightLeft: { measurementOrder: 38, channelIndex: 31, code: null },
  // EnChannelType_FrontHeightWideLeft: { measurementOrder: 39, channelIndex: 35, code: null },
  // EnChannelType_FrontDolbyCenter: { measurementOrder: 40, channelIndex: 17, code: null },
  // EnChannelType_SBDolbyCenter: { measurementOrder: 41, channelIndex: 29, code: null },

  // Subwoofer channels
  // EnChannelType_SWLFE: { measurementOrder: 42, channelIndex: 42, code: "SW1" },
  // EnChannelType_SWLeft2sp: { measurementOrder: 42, channelIndex: 43, code: "SW1" },
  // EnChannelType_SWLeft3sp: { measurementOrder: 42, channelIndex: 44, code: "SW1" },
  // EnChannelType_SWRight2sp: { measurementOrder: 43, channelIndex: 45, code: "SW2" },
  // EnChannelType_SWRight3sp: { measurementOrder: 43, channelIndex: 46, code: "SW2" },
  // EnChannelType_SWFront2sp: { measurementOrder: 42, channelIndex: 47, code: "SW1" },
  // EnChannelType_SWFront3sp: { measurementOrder: 42, channelIndex: 48, code: "SW1" },
  // EnChannelType_SWBack2sp: { measurementOrder: 43, channelIndex: 49, code: "SW2" },
  // EnChannelType_SWBack3sp: { measurementOrder: 44, channelIndex: 50, code: "SW3" },
  // EnChannelType_SWMiddle2sp: { measurementOrder: 51, channelIndex: 51, code: null },
  // EnChannelType_SWLFE2sp: { measurementOrder: 42, channelIndex: 52, code: "SW1" },
  // EnChannelType_SWLFE3sp: { measurementOrder: 42, channelIndex: 53, code: "SW1" },
  // EnChannelType_SWLFE4sp: { measurementOrder: 42, channelIndex: 65, code: "SW1" },
  EnChannelType_SWMix1: { measurementOrder: 42, channelIndex: 54, code: 'SW1' },
  EnChannelType_SWMix2: { measurementOrder: 43, channelIndex: 55, code: 'SW2' },
  EnChannelType_SWMix3: { measurementOrder: 44, channelIndex: 56, code: 'SW3' },
  EnChannelType_SWMix4: { measurementOrder: 45, channelIndex: 57, code: 'SW4' },
  EnChannelType_SWFrontLeft3sp: { measurementOrder: 42, channelIndex: 58, code: 'SW1' },
  EnChannelType_SWFrontLeft4sp: { measurementOrder: 42, channelIndex: 59, code: 'SW1' },
  EnChannelType_SWFrontRight4sp: { measurementOrder: 43, channelIndex: 60, code: 'SW2' },
  EnChannelType_SWFrontRight3sp: { measurementOrder: 43, channelIndex: 61, code: 'SW2' },
  EnChannelType_SWRear3sp: { measurementOrder: 44, channelIndex: 64, code: 'SW3' },
  EnChannelType_SWBackLeft4sp: { measurementOrder: 44, channelIndex: 62, code: 'SW3' },
  EnChannelType_SWBackRight4sp: { measurementOrder: 45, channelIndex: 63, code: 'SW4' },
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

    return (
      Object.entries(this).find(
        ([key, value]) => value.code === code && typeof value === 'object'
      )?.[1] || this.EnChannelType_SWMode
    );
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
