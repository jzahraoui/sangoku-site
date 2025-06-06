import MeasurementItem from './MeasurementItem.js';
import { CHANNEL_TYPES } from './audyssey.js';

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
    this.SPL_OFFSET = 80.0;
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
      throw new Error('No measurements data found');
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

  async parse() {
    const distancePoisitionGuid = this.getDistancePoisitionGuid();
    const positionList = this.getPositionList();
    const channelGuids = this.fileContent.OrderedChannelGuids;

    // get expected list
    const avrChannelList = this.jsonAvrData.detectedChannels.map(c => c.commandId);

    // Debug logging
    console.debug('Available channels:', JSON.stringify(avrChannelList));

    const AvrOriginatingDesignationList = Array.from(
      new Set(
        Object.values(this.fileContent._channelDataMap).map(m =>
          CHANNEL_TYPES.getStandardSubwooferName(m.Metadata.AvrOriginatingDesignation)
        )
      )
    );
    const missingChannels = avrChannelList.filter(
      channel => !AvrOriginatingDesignationList.includes(channel)
    );
    if (missingChannels.length !== 0) {
      throw new Error(`${missingChannels.length} channel(s) are missing, please ensure all AVR detected channels are present in mqx file,
        missing are: ${missingChannels.join(', ')}`);
    }

    for (const channelGuid of channelGuids) {
      const channelData = this.fileContent._channelDataMap[channelGuid];
      const channelName = CHANNEL_TYPES.getStandardSubwooferName(
        channelData?.Metadata.AvrOriginatingDesignation
      );

      console.debug('Processing channel:', {
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

      for (const position of positionList) {
        const positionNumber = positionList.indexOf(position);
        const positionName = this.fileContent.PositionNames[position];
        let identifier = `${channelName}_P${positionNumber}`;
        if (positionName) {
          identifier = `${identifier}_(${positionName})`;
        }
        const measurement = this.fileContent._measurements.find(
          m => m.PositionGuid === position && m.ChannelGuid === channelGuid
        );

        if (!measurement?.Data) {
          console.warn(`No data found for ${identifier}`);
          continue;
        }

        if (position === distancePoisitionGuid) {
          if (!measurement?.AvrDistanceMeters) {
            console.warn(`No distance found for ${identifier}`);
          } else {
            avrChannel.channelReport.distance = measurement.AvrDistanceMeters;
          }
        }

        // Convert the little endian data to big endian
        const littleEndianData = measurement.Data;
        const decodedFloat32Array = MeasurementItem.decodeRewBase64(
          littleEndianData,
          true
        );
        avrChannel.responseData[positionNumber] = decodedFloat32Array;
      }
    }
  }
}

export default MqxTools;
