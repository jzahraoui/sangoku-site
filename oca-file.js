// Configure precision
Decimal.set({ precision: 32 });

const SUB_LENGTH = 16055;
const SPEAKERS_LENGTH = 16321;
const FREQUENCY_IN_HZ = 48000;
const GAIN_ADJUSTMENT = new Decimal('10').pow(new Decimal('-0.35'));
const SPEED_OF_SOUND = 343;
const MODEL_DISTANCE_LIMIT = 6.0 / SPEED_OF_SOUND * 1000;

async function createOCAFile(allResponses, tagetCurve) {
  const status = document.getElementById('status');
  status.innerHTML = '';
  const successDiv = document.createElement('div');
  successDiv.className = 'success';
  successDiv.textContent = 'Process started...';
  status.appendChild(successDiv);

  /*
 
       const filtersOnly = filterResponses(allResponses, {
         'notes': 'PK'
       });
 
       */
  if (!allResponses) {
    throw new Error(`Cannot retreive REW measurements`);
  }

  convertDelayToDistance(allResponses);

  const filtersList = await createsFilters(allResponses);

  const LFE = true;
  const timestamp = createTimestamp();
  const evoVersion = "custom";

  let baseOca = {};
  baseOca.versionEvo = evoVersion;
  baseOca.tcName = tagetCurve;
  baseOca.bassFill = 0;
  baseOca.softRoll = false;
  baseOca.ocaTypeId = "OCAFILE";
  baseOca.ocaVersion = 1;
  baseOca.title = "home made calibration";
  baseOca.model = "Denon AVC-A1H";
  baseOca.ifVersionMajor = 10;
  baseOca.ifVersionMinor = 5;
  baseOca.eqType = 2;
  baseOca.ampAssign = 6;
  baseOca.ampAssignBin = "04040102000100000200000008000000000000000000000000000000020800080810000102030407090000010001030000";
  baseOca.channels = filtersList;
  baseOca.enableDynamicEq = false;
  baseOca.dynamicEqRefLevel = 0;
  baseOca.enableDynamicVolume = false;
  baseOca.dynamicVolumeSetting = 0;
  baseOca.enableLowFrequencyContainment = false;
  baseOca.lowFrequencyContainmentLevel = 3;
  baseOca.numberOfSubwoofers = 4;
  baseOca.subwooferOutput = LFE ? "LFE" : "L+M";
  baseOca.lpfForLFE = 250;

  let jsonData = JSON.stringify(baseOca, null, 2);
  const blob = new Blob([jsonData], { type: 'application/json' });
  const urlBlob = URL.createObjectURL(blob);
  const downloadLink = document.createElement("a");
  downloadLink.href = urlBlob;
  const optName = `${timestamp}_A1EvoNeuron_${evoVersion}.oca`;
  downloadLink.download = optName;
  document.body.appendChild(downloadLink);
  downloadLink.click();
  document.body.removeChild(downloadLink);
  URL.revokeObjectURL(urlBlob);

  status.removeChild(successDiv);
  status.innerHTML = '';
  successDiv.className = 'success';
  successDiv.textContent = 'Successfull';
  status.appendChild(successDiv);
}

/**
 * Creates a formatted timestamp (YYYYMMDD_HHmm)
 * @returns {string} Formatted timestamp
 */
function createTimestamp() {
  const now = new Date();
  const pad = (num, len = 2) => String(num).padStart(len, '0');

  return (
    pad(now.getFullYear(), 4) +     // YYYY
    pad(now.getMonth() + 1) +       // MM
    pad(now.getDate()) +            // DD
    '_' +                           // separator
    pad(now.getHours()) +          // HH
    pad(now.getMinutes())          // mm
  );
}

async function createsFilters(measurement) {

  // Convert the object to an array of its values
  const dataArray = Object.values(measurement);

  const channels = [];

  // creates a for loop on dataArray
  for (const item of dataArray) {
    let filterResponseUuid;

    // check if item is an object and has timeOfIRStartSeconds attribute
    if (!item ||
      typeof item !== 'object' ||
      !Object.prototype.hasOwnProperty.call(item, 'timeOfIRStartSeconds')) {
      continue;
    }

    try {
      const channelName = CHANNEL_TYPES.getBestMatchCode(item.title);
      // skiping not matching channels
      if (!channelName) {
        continue;
      }
      const channelDetails = CHANNEL_TYPES.getByCode(channelName);
      const isSub = channelName.startsWith('SW');
      let crossover = isSub ? null : 80;
      const sampleCount = isSub ? SUB_LENGTH : SPEAKERS_LENGTH;
      const rightWindowWidth = sampleCount * 1000 / FREQUENCY_IN_HZ;
      const filterResponse = await postNext('Generate filters measurement', item.uuid);
      filterResponseUuid = Object.values(filterResponse.results || {})[0]?.UUID;
      if (!filterResponseUuid) {
        throw new Error(`no filters for ${item.title}`);
      }
      await postSafe(`measurements/${filterResponseUuid}/ir-windows`,
        {
          leftWindowType: "Rectangular",
          rightWindowType: "Rectangular",
          leftWindowWidthms: "0",
          rightWindowWidthms: rightWindowWidth.toFixed(21),
          refTimems: "0",
          addFDW: "false"
        },
        "Update processed");

      const filterImpulseResponse = await fetchSafe(`impulse-response?windowed=true&normalised=true&samplerate=${FREQUENCY_IN_HZ}`,
        filterResponseUuid);

      /*
      const filterImpulseResponse = await fetchSafe(`filters-impulse-response?length=${sampleCount}&samplerate=${FREQUENCY_IN_HZ}`,
        filterResponseUuid);

      if (response.data === filterImpulseResponse.data) {
        console.info(`${item.title}: data match`);
      }
      */

      if (!filterImpulseResponse) continue;

      const bytes = decodeBase64ToBinary(filterImpulseResponse.data);
      const dataView = new DataView(bytes.buffer);
      validateDataSize(dataView, sampleCount);
      const filter = new Array(sampleCount);
      const invertFactor = item.inverted ? -1 : 1;
      for (let i = 0; i < sampleCount; i++) {
        //const value = dataView.getFloat64(i * Float64Array.BYTES_PER_ELEMENT, false);
        const value = dataView.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, false);
        const transformedValue = new Decimal(value)
          .times(new Decimal(GAIN_ADJUSTMENT))
          .times(new Decimal(invertFactor));
        filter[i] = transformedValue;
      }

      const channelItem = {
        channelType: channelDetails.channelIndex,
        speakerType: "S",
        distanceInMeters: item.cumulativeIRDistanceMeters,
        trimAdjustmentInDbs: roundGain(item.alignSPLOffsetdB),
        filter: filter,
        ...(crossover != null && { xover: crossover })
      };
      await postDelete(filterResponseUuid);

      channels.push(channelItem);

    } catch (error) {
      throw new Error(error.message);
    }
  }
  // Sort by measurement order
  const sortedChannels = channels.sort((a, b) =>
    CHANNEL_TYPES.getByChannelIndex(a.channelType).measurementOrder - CHANNEL_TYPES.getByChannelIndex(b.channelType).measurementOrder
  );

  return sortedChannels;
}

function convertDelayToDistance(measurement, shiftConstantInMeters = 2.58) {

  // Convert the object to an array of its values
  const dataArray = Object.values(measurement);

  // retreive max cumulativeIRShiftSeconds value from dataArray items
  //const maxDelay = Math.max(...dataArray.map(item => item.cumulativeIRShiftSeconds || 0));

  // for each item do operation 
  dataArray.forEach(item => {
    const cumulativeIRDistanceMeters = (item.cumulativeIRShiftSeconds) * SPEED_OF_SOUND;
    // operation on item
    item.cumulativeIRDistanceMeters = Math.round((shiftConstantInMeters + cumulativeIRDistanceMeters) * 100) / 100;
  });
}

function validateDataSize(dataView, sampleCount) {
  const expectedSize = (sampleCount + 1) * Float32Array.BYTES_PER_ELEMENT;
  if (dataView.byteLength !== expectedSize) {
    throw new Error(
      `Invalid data size. Expected ${expectedSize} bytes, ` +
      `got ${dataView.byteLength} bytes`
    );
  }
}
// Decode to binary data
function decodeBase64ToBinary(base64String) {
  const binaryString = atob(base64String);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes;
}


function roundGain(gain) {
  const roundedGain = Math.round(gain * 2) / 2;
  if (Math.abs(roundedGain) > 12) {
    throw new Error(`${roundedGain} dB gain is beyond hardware limits!`);
  }
  return roundedGain;
}
