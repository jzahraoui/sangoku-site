import JSZip from 'jszip';
import OCAFileGenerator from '../oca-file.js';
import RewApi from '../rew/rew-api.js';
import ampAssignType from '../amp-type.js';

/**
 * Export/report generation service extracted from MeasurementViewModel
 *.
 *
 * [ORCHESTRATION] service: builds the OCA file, the settings report, the MSO
 * sub package and the .avr receiver config as `{ filename, blob }` results —
 * saving to disk (`saveAs`) stays in the viewmodel. No Knockout, no DOM.
 */

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const unwrap = value => (typeof value === 'function' ? value() : value);

const labelOf = m => unwrap(m.displayMeasurementTitle) ?? unwrap(m.title);

function timestampSlug() {
  return new Date().toISOString().slice(0, 16).replace('T', '-').replaceAll(':', '-');
}

/** Build the receiver_config.avr download from the loaded AVR data. */
function buildAvrExport(avrData, rawIpAddress) {
  if (!avrData) throw new Error('please load file before');

  const ipAddress = rawIpAddress.trim();
  if (!ipAddress) throw new Error('please enter AVR IP address');
  if (!RewApi.isValidIpAddress(ipAddress)) {
    throw new Error('please enter a valid AVR IP address');
  }

  const newAvrData = {
    targetModelName: avrData.targetModelName,
    ipAddress,
    enMultEQType: avrData.enMultEQType,
    subwooferNum: avrData.subwooferNum,
    ampAssign: ampAssignType.getByIndex(avrData.enAmpAssignType),
    ampAssignInfo: avrData.ampAssignInfo,
    detectedChannels: avrData.detectedChannels.map(channel => ({
      commandId: channel.commandId,
    })),
  };

  return {
    filename: 'receiver_config.avr',
    blob: new Blob([JSON.stringify(newAvrData, null, 2)], {
      type: 'application/json',
    }),
  };
}

/**
 * Build the human-readable settings report (.txt) from a flat snapshot of
 * the app settings and the unique measurements serialised with toJSON().
 */
function generateSettingsReport({ avrData, settings, reducedMeasurements }) {
  if (!avrData?.targetModelName) {
    throw new Error(`Please load avr file first`);
  }
  if (!settings.targetCurve) {
    throw new Error(
      `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`,
    );
  }

  // function to add "Hz" suffix to frequency values
  const addHzSuffix = freq => (freq ? `${freq} Hz` : 'None');

  // Generate a text file containing all the settings and parameters
  let textData = '';

  // Title and timestamp
  const now = new Date();
  textData += `=======================================================\n`;
  textData += `  ROOM CORRECTION HELPER - ${now.toLocaleDateString()} ${now.toLocaleTimeString()}\n`;
  textData += `=======================================================\n\n`;

  // Basic settings section
  textData += `BASIC SETTINGS\n`;
  textData += `-------------\n`;
  textData += `Loaded File:       ${settings.loadedFileName}\n`;
  textData += `Target Curve:      ${settings.targetCurve}\n`;
  textData += `Target Level:      ${settings.mainTargetLevel} dB\n`;
  textData += `Average Method:    ${settings.selectedAverageMethod}\n\n`;

  // AVR Info section
  textData += `AVR INFORMATION\n`;
  textData += `--------------\n`;
  textData += `Model:                    ${avrData.targetModelName}\n`;
  textData += `MultEQ Type:              ${avrData.avr.multEQType}\n`;
  textData += `Has Cirrus Logic DSP:     ${
    avrData.avr.hasCirrusLogicDsp ? 'Yes' : 'No'
  }\n`;
  textData += `Speed of Sound:           ${avrData.avr.speedOfSound} m/s\n\n`;

  // Speaker settings section
  textData += `SPEAKER SETTINGS\n`;
  textData += `----------------\n`;
  textData += `Smoothing Method:         ${settings.selectedSmoothingMethod}\n`;
  textData += `Windowing:                ${settings.selectedIrWindows}\n`;
  textData += `Room Curve:               ${settings.selectedRoomCurve}\n`;
  textData += `Individual Max Boost:     ${settings.individualMaxBoostValue} dB\n`;
  textData += `Overall Max Boost:        ${settings.overallBoostValue} dB\n`;
  textData += `\n`;

  // Subwoofer settings section
  textData += `SUBWOOFER SETTINGS\n`;
  textData += `------------------\n`;
  textData += `Number of Subs:           ${settings.numberOfSubwoofers}\n`;
  textData += `Revert LFE Filter Freq:   ${addHzSuffix(settings.revertLfeFrequency)}\n`;

  textData += `Max Boost Individual:     ${settings.maxBoostIndividualValue} dB\n`;
  textData += `Max Boost Overall:        ${settings.maxBoostOverallValue} dB\n`;

  textData += `Align Frequency:          ${addHzSuffix(settings.selectedSpeakerCrossover)}\n`;
  textData += `Selected Speaker:         ${settings.selectedSpeakerText}\n`;

  textData += `LPF for LFE:              ${settings.lpfForLFE} Hz\n`;
  textData += `Subwoofer Output:         ${settings.subwooferOutput}\n\n`;

  // Dynamic settings section
  textData += `DYNAMIC SETTINGS\n`;
  textData += `----------------\n`;
  textData += `Dynamic EQ:        ${settings.enableDynamicEq ? 'Enabled' : 'Disabled'}\n`;
  if (settings.enableDynamicEq) {
    textData += `  Reference Level:  ${settings.dynamicEqRefLevel} dB\n`;
  }
  textData += `Dynamic Volume:    ${
    settings.enableDynamicVolume ? 'Enabled' : 'Disabled'
  }\n`;
  if (settings.enableDynamicVolume) {
    textData += `  Volume Setting:   ${settings.dynamicVolumeSetting}\n`;
  }
  textData += `LF Containment:    ${
    settings.enableLowFrequencyContainment ? 'Enabled' : 'Disabled'
  }\n`;
  if (settings.enableLowFrequencyContainment) {
    textData += `  LFC Level:        ${settings.lowFrequencyContainmentLevel}\n`;
  }
  textData += `\n`;

  // Version information
  textData += `VERSION INFORMATION\n`;
  textData += `-------------------\n`;
  textData += `REW Version:       ${settings.rewVersion}\n`;
  textData += `RCH Version:       ${settings.currentVersion}\n\n`;

  // Create table header
  textData +=
    '\n+------------------------+---------------+----------+-------------+---------------------+----------+\n';
  textData +=
    '| Measurement            | Channel       | Distance | SPL Offset  | Crossover Frequency | Inverted |\n';
  textData +=
    '+------------------------+---------------+----------+-------------+---------------------+----------+\n';

  // Add table rows
  for (const measurement of reducedMeasurements) {
    const title = measurement.displayMeasurementTitle.padEnd(22);
    const channel = measurement.channelName.padEnd(13);
    const distance = measurement.distance.toFixed(2).padStart(8);
    const splOffset = measurement.splForAvr.toString().padStart(11);
    const crossover = measurement.crossover.toString().padStart(19);
    const inverted = (measurement.inverted ? 'Yes' : '').padEnd(8);

    textData += `| ${title} | ${channel} | ${distance} | ${splOffset} | ${crossover} | ${inverted} |\n`;
  }

  // Add table footer
  textData +=
    '+------------------------+---------------+----------+-------------+---------------------+----------+\n';

  const model = avrData.targetModelName.replaceAll(' ', '-');
  const filename = `${timestampSlug()}_${settings.targetCurve}_${model}.txt`;

  return {
    filename,
    blob: new Blob([textData], { type: 'application/text' }),
  };
}

/** Reset a sub, dump its frequency response as an MSO text file into the zip. */
async function appendMsoMeasurement(
  jszip,
  measurement,
  { minFreq, maxFreq, targetLevel },
) {
  await measurement.resetAll(targetLevel);
  const frequencyResponse = await measurement.getFrequencyResponse();
  await measurement.applyWorkingSettings();
  const subName = unwrap(measurement.channelName).replace('SW', 'SUB');
  const localFilename = `POS${unwrap(measurement.position)}-${subName}.txt`;

  const lines = [];
  for (let i = 0; i < frequencyResponse.freqs.length; i++) {
    const freq = frequencyResponse.freqs[i];
    if (freq >= minFreq && freq <= maxFreq) {
      lines.push(
        `${freq.toFixed(6)} ${frequencyResponse.magnitude[i].toFixed(
          3,
        )} ${frequencyResponse.phase[i].toFixed(4)}`,
      );
    }
  }

  if (!lines.length) {
    throw new Error(`no file content for ${localFilename}`);
  }

  jszip.file(localFilename, lines.join('\n'));
}

function createExportsService({ log = noopLog } = {}) {
  /**
   * Build the .oca file from the AVR data, the unique measurements and a
   * snapshot of the export configuration.
   */
  async function generateOcaExport({ avrData, measurements, config }) {
    const measurementsinError = measurements.filter(item => unwrap(item.hasErrors));

    if (measurementsinError.length > 0) {
      log.warn(
        `There are ${measurementsinError.length} measurements with errors. Please fix them before generating the OCA file.`,
      );
    }
    if (!avrData?.targetModelName) {
      throw new Error(`Please load avr file first`);
    }
    const OCAFile = new OCAFileGenerator(avrData);

    if (!config.targetCurve) {
      throw new Error(
        `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`,
      );
    }
    OCAFile.fileFormat = config.fileFormat;
    OCAFile.tcName = config.tcName;
    OCAFile.softRoll = config.softRoll;
    OCAFile.enableDynamicEq = config.enableDynamicEq;
    OCAFile.dynamicEqRefLevel = config.dynamicEqRefLevel;
    OCAFile.enableDynamicVolume = config.enableDynamicVolume;
    OCAFile.dynamicVolumeSetting = config.dynamicVolumeSetting;
    OCAFile.enableLowFrequencyContainment = config.enableLowFrequencyContainment;
    OCAFile.lowFrequencyContainmentLevel = config.lowFrequencyContainmentLevel;
    OCAFile.subwooferOutput = config.subwooferOutput;
    OCAFile.lpfForLFE = config.lpfForLFE;
    OCAFile.numberOfSubwoofers = config.numberOfSubwoofers;
    OCAFile.versionEvo = `RCH ${config.currentVersion}`;

    const jsonData = await OCAFile.createOCAFile(measurements);

    // Validate input
    if (!jsonData) {
      throw new Error('No data to save');
    }

    const model = avrData.targetModelName.replaceAll(' ', '-');
    const filename = `${timestampSlug()}_${config.fileFormat}_${config.targetCurve}_${model}.oca`;

    return {
      filename,
      blob: new Blob([jsonData], { type: 'application/json' }),
    };
  }

  /** Build the MSO sub package (one response file per sub and position). */
  async function buildMsoExportZip(measurements, { model, targetLevel }) {
    const jszip = new JSZip();
    const zipFilename = `MSO-${model}.zip`;
    const minFreq = 5; // minimum frequency in Hz
    const maxFreq = 400; // maximum frequency in Hz

    const chunkSize = 5;

    for (let i = 0; i < measurements.length; i += chunkSize) {
      const chunk = measurements.slice(i, i + chunkSize);
      for (const measurement of chunk) {
        await appendMsoMeasurement(jszip, measurement, { minFreq, maxFreq, targetLevel });
      }
    }

    // Generate the zip file once and save it
    const blob = await jszip.generateAsync({ type: 'blob' });
    return { filename: zipFilename, blob };
  }

  /** Import an Equalizer APO config into REW, position group by position group. */
  async function importMsoConfig(
    REWconfigs,
    groupedSubs,
    importFilterInREW,
    { onPositionImported } = {},
  ) {
    log.info('Importing MSO config...');

    for (const [position, subResponses] of Object.entries(groupedSubs)) {
      if (!subResponses?.length) continue;

      const subResponsesTitles = subResponses.map(response => labelOf(response));
      log.info(`Importing to position: ${position}\n${subResponsesTitles.join('\r\n')}`);

      await importFilterInREW(REWconfigs, subResponses);
      onPositionImported?.(position);
    }

    log.info(`Importing finished`);
  }

  return {
    appendMsoMeasurement,
    buildAvrExport,
    buildMsoExportZip,
    generateOcaExport,
    generateSettingsReport,
    importMsoConfig,
  };
}

export { buildAvrExport, createExportsService };
