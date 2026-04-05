import RewApi from './rew/rew-api.js';
import { CHANNEL_TYPES } from './audyssey.js';
import lm from './logs.js';

class MqxTools {
  constructor(fileContent, jsonAvrData) {
    if (!fileContent) {
      throw new Error(`no avr file content provided`);
    }
    if (!jsonAvrData) {
      throw new Error(`no jsonAvrData provided`);
    }
    this.fileContent = fileContent;
    this.jsonAvrData = jsonAvrData;
  }

  getDistancePositionGuid() {
    const zeroGuid = '00000000-0000-0000-0000-000000000000';
    const settings = this.fileContent.CalibrationSettings;
    if (!settings) {
      throw new Error('No CalibrationSettings found in file content');
    }
    const value = settings.DistancePoisitionGuid;
    if (value && value !== zeroGuid) {
      return value;
    }
    const fallback = settings.TrimPositionGuids?.[0];
    if (!fallback) {
      throw new Error('No valid distance position GUID found in CalibrationSettings');
    }
    return fallback;
  }

  getPositionList() {
    if (!Array.isArray(this.fileContent?._measurements)) {
      throw new TypeError('No measurements data found');
    }

    // Extract unique position GUIDs, skipping invalid measurements
    const positions = new Set(
      this.fileContent._measurements.flatMap(m =>
        m?.PositionGuid ? [m.PositionGuid] : [],
      ),
    );

    if (positions.size === 0) {
      throw new Error('No valid position data found in measurements');
    }

    return [...positions];
  }

  processPositions(
    avrChannel,
    channelGuid,
    channelName,
    positionList,
    distancePositionGuid,
    measurementsByKey,
  ) {
    for (const [positionNumber, position] of positionList.entries()) {
      const positionName = this.fileContent.PositionNames?.[position];
      const identifier = positionName
        ? `${channelName}_P${positionNumber}_(${positionName})`
        : `${channelName}_P${positionNumber}`;

      const measurement = measurementsByKey.get(`${position}:${channelGuid}`);

      if (!measurement?.Data) {
        lm.warn(`No data found for ${identifier}`);
        continue;
      }

      if (position === distancePositionGuid) {
        if (measurement.AvrDistanceMeters && avrChannel.channelReport) {
          avrChannel.channelReport.distance = measurement.AvrDistanceMeters;
        } else if (!measurement.AvrDistanceMeters) {
          lm.warn(`No distance found for ${identifier}`);
        }
      }

      avrChannel.responseData[positionNumber] = RewApi.decodeBase64ToFloat32(
        measurement.Data,
        true,
      );
    }
  }

  parse() {
    const distancePositionGuid = this.getDistancePositionGuid();
    const positionList = this.getPositionList();
    const channelDataMap = this.fileContent._channelDataMap;
    const channelGuids = this.fileContent.OrderedChannelGuids;

    if (!channelDataMap || !channelGuids) {
      throw new Error(
        'Missing channel data map or ordered channel GUIDs in file content',
      );
    }

    // Build a lookup Map for O(1) measurement access: 'positionGuid:channelGuid' -> measurement
    const measurementsByKey = new Map(
      this.fileContent._measurements
        .filter(m => m?.PositionGuid && m?.ChannelGuid)
        .map(m => [`${m.PositionGuid}:${m.ChannelGuid}`, m]),
    );

    const avrChannelList = this.jsonAvrData.detectedChannels.map(c => c.commandId);
    lm.debug('Available channels:', JSON.stringify(avrChannelList));

    const mqxChannelNames = new Set(
      Object.values(channelDataMap).map(m =>
        CHANNEL_TYPES.getStandardSubwooferName(m.Metadata.AvrOriginatingDesignation),
      ),
    );
    const missingChannels = avrChannelList.filter(
      channel => !mqxChannelNames.has(channel),
    );
    if (missingChannels.length > 0) {
      throw new Error(
        `${missingChannels.length} channel(s) are missing, please ensure all AVR detected channels are present in mqx file, missing are: ${missingChannels.join(', ')}`,
      );
    }

    for (const channelGuid of channelGuids) {
      const channelData = channelDataMap[channelGuid];
      const channelName = CHANNEL_TYPES.getStandardSubwooferName(
        channelData?.Metadata.AvrOriginatingDesignation,
      );

      lm.debug('Processing channel:', { channelGuid, channelName });

      if (!channelName) {
        throw new Error(`No channel name found for ${channelGuid}`);
      }

      const avrChannel = this.jsonAvrData.detectedChannels.find(
        c => c.commandId === channelName,
      );

      // skip channels not present in the AVR file
      if (!avrChannel) {
        continue;
      }

      avrChannel.responseData = {};

      this.processPositions(
        avrChannel,
        channelGuid,
        channelName,
        positionList,
        distancePositionGuid,
        measurementsByKey,
      );
    }
  }
}

export default MqxTools;
