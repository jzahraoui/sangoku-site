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
    this.currentDate = new Date();
    this.samplingRate = 48000;
  }

  getDistancePoisitionGuid() {
    const zeroGuid = '00000000-0000-0000-0000-000000000000';
    const value = this.fileContent.CalibrationSettings.DistancePoisitionGuid;
    if (value !== zeroGuid) {
      return value;
    }
    return this.fileContent.CalibrationSettings.TrimPositionGuids[0];
  }

  getPositionList() {
    if (!Array.isArray(this.fileContent?._measurements)) {
      throw new TypeError('No measurements data found');
    }

    // Filter out invalid measurements and extract unique position GUIDs
    const positions = this.fileContent._measurements
      .filter(m => m?.PositionGuid)
      .map(m => m.PositionGuid);

    if (positions.length === 0) {
      throw new Error('No valid position data found in measurements');
    }

    return [...new Set(positions)];
  }

  processPositions(
    avrChannel,
    channelGuid,
    channelName,
    positionList,
    distancePoisitionGuid
  ) {
    for (let positionNumber = 0; positionNumber < positionList.length; positionNumber++) {
      const position = positionList[positionNumber];
      const positionName = this.fileContent.PositionNames[position];
      const identifier = positionName
        ? `${channelName}_P${positionNumber}_(${positionName})`
        : `${channelName}_P${positionNumber}`;

      const measurement = this.fileContent._measurements.find(
        m => m.PositionGuid === position && m.ChannelGuid === channelGuid
      );

      if (!measurement?.Data) {
        lm.warn(`No data found for ${identifier}`);
        continue;
      }

      if (position === distancePoisitionGuid && measurement.AvrDistanceMeters) {
        avrChannel.channelReport.distance = measurement.AvrDistanceMeters;
      } else if (position === distancePoisitionGuid) {
        lm.warn(`No distance found for ${identifier}`);
      }

      const decodedFloat32Array = RewApi.decodeBase64ToFloat32(measurement.Data, true);
      avrChannel.responseData[positionNumber] = decodedFloat32Array;
    }
  }

  async parse() {
    const distancePoisitionGuid = this.getDistancePoisitionGuid();
    const positionList = this.getPositionList();
    const channelGuids = this.fileContent.OrderedChannelGuids;

    // get expected list
    const avrChannelList = this.jsonAvrData.detectedChannels.map(c => c.commandId);

    // Debug logging
    lm.debug('Available channels:', JSON.stringify(avrChannelList));

    const AvrOriginatingDesignationList = new Set(
      Object.values(this.fileContent._channelDataMap).map(m =>
        CHANNEL_TYPES.getStandardSubwooferName(m.Metadata.AvrOriginatingDesignation)
      )
    );
    const missingChannels = avrChannelList.filter(
      channel => !AvrOriginatingDesignationList.has(channel)
    );
    if (missingChannels.length !== 0) {
      throw new Error(`${
        missingChannels.length
      } channel(s) are missing, please ensure all AVR detected channels are present in mqx file,
        missing are: ${missingChannels.join(', ')}`);
    }

    for (const channelGuid of channelGuids) {
      const channelData = this.fileContent._channelDataMap[channelGuid];
      const channelName = CHANNEL_TYPES.getStandardSubwooferName(
        channelData?.Metadata.AvrOriginatingDesignation
      );

      lm.debug('Processing channel:', {
        channelGuid,
        channelName,
      });

      if (!channelName) {
        throw new Error(`No channel name found for ${channelGuid}`);
      }

      // Find the matching channel and create if it doesn't exist
      const avrChannel = this.jsonAvrData.detectedChannels.find(
        c => c.commandId === channelName
      );

      // if channel not exist into the avr file, skeep it
      if (!avrChannel) {
        continue;
      }

      avrChannel.responseData = {};

      this.processPositions(
        avrChannel,
        channelGuid,
        channelName,
        positionList,
        distancePoisitionGuid
      );
    }
  }
}

export default MqxTools;
