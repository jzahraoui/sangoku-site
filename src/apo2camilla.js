class FilterConverter {
  static MIN_FREQ = 10;
  static MAX_FREQ = 22000;
  static MIN_GAIN = -120;
  static MAX_GAIN = 30;
  static MIN_Q = 0.1;
  static MAX_Q = 50;

  constructor(content) {
    this.content = content;
    this.filters = this.parseEqualizerApo();
  }

  parseEqualizerApo() {
    const lines = this.content.split('\n');
    const filters = [];
    let currentChannel = null;
    const channelMap = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        if (trimmedLine.startsWith('# MSO channel name ')) {
          this.#parseChannelMap(line, channelMap);
        }
        continue;
      }

      currentChannel = this.#processLine(trimmedLine, line, filters, currentChannel, channelMap);
    }
    return filters;
  }

  #parseChannelMap(line, channelMap) {
    const MsoToApoChannel = line
      .replace('# MSO channel name = ', '')
      .replace(' Equalizer APO channel name = ', '')
      .trim()
      .replaceAll('"', '')
      .split(',');

    const msoChannel = MsoToApoChannel[0];
    const apoChannel = MsoToApoChannel[1];
    if (msoChannel && apoChannel) {
      channelMap[apoChannel] = msoChannel;
    }
  }

  #processLine(trimmedLine, line, filters, currentChannel, channelMap) {
    const lowerLine = trimmedLine.toLowerCase();

    if (lowerLine.startsWith('channel:')) {
      return this.#handleChannel(trimmedLine, filters, channelMap);
    }
    if (lowerLine.startsWith('copy:')) {
      return this.#handleCopy(line, filters, currentChannel, channelMap);
    }
    if (lowerLine.startsWith('filter:')) {
      this.#handleFilter(trimmedLine, currentChannel);
    } else if (lowerLine.startsWith('delay:')) {
      currentChannel.delayMs = Number.parseFloat(trimmedLine.split(' ')[1]);
    } else if (lowerLine.startsWith('preamp:')) {
      currentChannel.gainDb = Number.parseFloat(trimmedLine.split(' ')[1]);
    }
    return currentChannel;
  }

  #handleChannel(trimmedLine, filters, channelMap) {
    const apoChannel = trimmedLine.split(': ')[1];
    if (!filters.some(filter => filter.apoChannel === apoChannel)) {
      const msoChannel = channelMap[apoChannel];
      if (!msoChannel) {
        throw new Error(`Channel ${apoChannel} not found in channel map`);
      }
      const newChannel = {
        apoChannel,
        Channel: msoChannel,
        invertFactor: 1,
        gainDb: 0,
        delayMs: 0,
        filters: [],
      };
      filters.push(newChannel);
      return newChannel;
    }
    return filters.find(filter => filter.apoChannel === apoChannel);
  }

  #handleCopy(line, filters, currentChannel, channelMap) {
    const [channel, equation] = line.replace('Copy: ', '').split('=');
    const invertFactor = Number.parseFloat(equation);

    if (currentChannel?.apoChannel === channel) {
      currentChannel.invertFactor = invertFactor;
      return currentChannel;
    }

    const existingChannel = filters.find(filter => filter.apoChannel === channel);
    if (existingChannel) {
      existingChannel.invertFactor = invertFactor;
      return currentChannel;
    }

    if (channelMap[channel]) {
      const newChannel = {
        apoChannel: channel,
        Channel: channelMap[channel],
        invertFactor,
        gainDb: 0,
        delayMs: 0,
        filters: [],
      };
      filters.push(newChannel);
      return newChannel;
    }
    return currentChannel;
  }

  #handleFilter(trimmedLine, currentChannel) {
    const parts = trimmedLine.split(' ');
    if (parts[1].toUpperCase() !== 'ON') {
      return;
    }

    const filterType = parts[2];
    const freq = Number.parseFloat(parts[4]);
    const roundedFreq = roundFrequency(freq);

    if (filterType === 'PK') {
      const gain = Number.parseFloat(parts[7]);
      const qValue = Number.parseFloat(parts[10]);
      validateFilterParams(roundedFreq, qValue, gain);

      currentChannel.filters.push({
        type: 'Biquad',
        parameters: {
          type: 'Peaking',
          freq: roundedFreq,
          gain: Number(gain.toFixed(1)),
          q: Number(qValue.toFixed(3)),
        },
      });
    } else if (filterType === 'AP') {
      const qValue = Number.parseFloat(parts[7]);
      validateFilterParams(roundedFreq, qValue);

      currentChannel.filters.push({
        type: 'Biquad',
        parameters: {
          type: 'Allpass',
          freq: roundedFreq,
          q: Number(qValue.toFixed(2)),
        },
      });
    }
  }

  createCamillaDspConfig() {
    return this.filters.map((channel, index) => {
      const config = {
        filters: {},
        pipeline: [
          {
            type: 'Filter',
            channel: index,
            names: [],
          },
        ],
      };

      for (const [filterIndex, filterData] of channel.filters.entries()) {
        const filterName = `filter_${filterIndex + 1}`;
        config.pipeline[0].names.push(filterName);

        const filterConfig = {
          type: 'Biquad',
          parameters: {
            type: filterData.parameters.type,
            freq: filterData.parameters.freq,
          },
        };

        if (filterData.parameters.type === 'Peaking') {
          filterConfig.parameters.gain = filterData.parameters.gain;
          filterConfig.parameters.q = filterData.parameters.q;
        } else if (filterData.parameters.type === 'Allpass') {
          filterConfig.parameters.q = filterData.parameters.q;
        }

        config.filters[filterName] = filterConfig;
      }

      return {
        config: config,
        channel: channel.Channel,
      };
    });
  }

  // Main function using the helper
  createREWConfiguration() {
    // Transform each channel's filters into REW configuration format
    if (this.filters.length > 22) {
      throw new Error(`filters length ${this.filters.length} do not fit in REW`);
    }

    return this.filters.map(channel => {
      // Initialize an filters array of 22 size
      const channelConfig = new Array(22);

      // Process each filter in the channel using helper function
      for (const [index, filter] of channel.filters.entries()) {
        channelConfig[index] = createFilterConfig(filter, index);
      }

      //fill the rest of the array with empty filters
      for (let i = channel.filters.length; i < 22; i++) {
        const emptyFilter = {
          index: i + 1,
          type: 'None',
          enabled: true,
          isAuto: false,
        };
        channelConfig[i] = emptyFilter;
      }

      // Return complete channel configuration
      return {
        filters: channelConfig,
        channel: channel.Channel,
        gain: channel.gainDb,
        delay: channel.delayMs,
        invert: channel.invertFactor,
      };
    });
  }
}

// Helper function to create filter configuration
function createFilterConfig(filter, index) {
  // Extract filter parameters for cleaner reference
  const { freq, q, type, gain } = filter.parameters;

  // Create base filter configuration
  const filterConfig = {
    enabled: true,
    isAuto: false,
    frequency: freq,
    q: q,
    index: index + 1,
  };

  // Set filter type and gain based on filter type
  if (type === 'Peaking') {
    filterConfig.type = 'PK';
    filterConfig.gaindB = gain;
  } else if (type === 'Allpass') {
    filterConfig.type = 'All pass';
  }

  return filterConfig;
}

function roundFrequency(freq) {
  const roundFactor = freq < 1000 ? 100 : 1;
  return Math.round(freq * roundFactor) / roundFactor;
}

function validateFilterParams(freq, q, gain = null) {
  if (!(FilterConverter.MIN_FREQ <= freq && freq <= FilterConverter.MAX_FREQ)) {
    throw new Error(
      `Frequency must be between ${FilterConverter.MIN_FREQ}Hz and ${FilterConverter.MAX_FREQ}Hz`
    );
  }
  if (!(FilterConverter.MIN_Q <= q && q <= FilterConverter.MAX_Q)) {
    throw new Error(
      `Q must be between ${FilterConverter.MIN_Q} and ${FilterConverter.MAX_Q}`
    );
  }
  if (
    gain !== null &&
    !(FilterConverter.MIN_GAIN <= gain && gain <= FilterConverter.MAX_GAIN)
  ) {
    throw new Error(
      `Gain must be between ${FilterConverter.MIN_GAIN}dB and ${FilterConverter.MAX_GAIN}dB`
    );
  }
}

export default FilterConverter;
