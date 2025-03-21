import MeasurementItem from './MeasurementItem.js';
import PersistentStore from './PersistentStore.js';
import BusinessTools from './BusinessTools.js';
import OCAFileGenerator from './oca-file.js';
import translations from './translations.js';
import AdyTools from './ady-tools.js';
import MultiSubOptimizer from './multi-sub-optimizer.js';

const store = new PersistentStore('myAppData');

class MeasurementViewModel {
  constructor(apiService) {
    const self = this;
    self.DEFAULT_LFE_PREDICTED = 'LFE predicted_P';
    self.UNKNOWN_GROUP_NAME = 'UNKNOWN';
    self.DEFAULT_CROSSOVER_VALUE = 80;
    self.DEFAULT_SHIFT_IN_METERS = 3;
    self.DEFAULT_TARGET_LEVEL = 75;
    self.inhibitGraphUpdates = true;

    self.EQ_SETTINGS = {
      MANUFACTURER: 'Generic',
      MODEL: 'Generic',
    };
    self.pollingInterval = 1000; // 1 seconds
    self.isPolling = ko.observable(false);
    self.pollerId = null;
    // Add translation support
    self.translations = ko.observable(
      translations[localStorage.getItem('userLanguage') || 'en']
    );

    // API Service
    self.apiService = apiService;

    self.businessTools = new BusinessTools(self);

    // Observables
    self.measurements = ko.observableArray([]);
    self.isLoading = ko.observable(false);
    self.error = ko.observable('');
    self.status = ko.observable('');
    self.selectedItem = ko.observable(null);

    // Computed
    self.hasStatus = ko.computed(() => !self.error() && self.status() !== '');
    self.hasError = ko.computed(() => self.error() !== '');
    self.hasItems = ko.computed(() => self.measurements().length > 0);

    self.handleError = function (message, error) {
      console.error(message, error);
      self.error(message);
      self.status('');
    };

    self.OCAFileGenerator = null;

    // Observable for selected speaker
    self.selectedSpeaker = ko.observable('');

    // Observable for target curve
    self.targetCurve = 'unknown';
    self.rewVersion = '';

    // Observable for the selected value
    self.selectedLfeFrequency = ko.observable('250');

    // Array of frequency options
    self.LfeFrequencies = [
      { value: '80', text: '80Hz' },
      { value: '90', text: '90Hz' },
      { value: '100', text: '100Hz' },
      { value: '110', text: '110Hz' },
      { value: '120', text: '120Hz' },
      { value: '150', text: '150Hz' },
      { value: '180', text: '180Hz' },
      { value: '200', text: '200Hz' },
      { value: '250', text: '250Hz' },
    ];

    // Observable for the selected value
    self.gobalCrossover = ko.observable();

    // Observable for the selected value
    self.selectedAlignFrequency = ko.observable();

    // Array of frequency options
    self.alingFrequencies = [
      { value: 0, text: 'N/A' },
      { value: 40, text: '40Hz' },
      { value: 60, text: '60Hz' },
      { value: 80, text: '80Hz' },
      { value: 90, text: '90Hz' },
      { value: 100, text: '100Hz' },
      { value: 110, text: '110Hz' },
      { value: 120, text: '120Hz' },
      { value: 150, text: '150Hz' },
      { value: 180, text: '180Hz' },
      { value: 200, text: '200Hz' },
      { value: 250, text: '250Hz' },
    ];

    // Array of frequency options
    self.speakerTypeChoices = [
      { value: 'S', text: 'Small' },
      { value: 'L', text: 'Large' },
      { value: 'E', text: 'Sub' },
    ];

    // Filter observables
    self.selectedMeasurementsFilter = ko.observable(true);

    // Available filter options
    self.selectedMeasurements = [
      { value: true, text: 'Selected' },
      { value: false, text: 'All' },
    ];

    self.selectedAverageMethod = ko.observable('');

    // Array of frequency options
    self.averageMethod = [
      { value: 'Vector average', text: 'Vector average' },
      { value: 'RMS average', text: 'RMS average' },
      { value: 'Magn plus phase average', text: 'RMS + phase avg.' },
      { value: 'dB average', text: 'dB average' },
      { value: 'dB plus phase average', text: 'dB + phase avg.' },
      { value: 'Vector sum', text: 'Vector sum' },
    ];

    // Subscribe to changes in global crossover
    self.gobalCrossover.subscribe(function (newValue) {
      if (newValue !== undefined) {
        // Update all enabled crossover selections
        ko.utils.arrayForEach(self.uniqueMeasurementsView(), function (measurement) {
          if (!measurement.isSub()) {
            measurement.crossover(newValue);
          }
        });
      }
    });

    // Observable to track drag state
    self.isDragging = ko.observable(false);

    // Observable array to store JSON data
    self.jsonAvrData = ko.observable();

    self.additionalBassGainValue = ko.observable(3);
    self.minadditionalBassGainValue = 0;
    self.maxadditionalBassGainValue = 6;
    self.maxBoostIndividualValue = ko.observable(0);
    self.minIndividualValue = 0;
    self.maxIndividualValue = 6;
    self.maxBoostOverallValue = ko.observable(0);
    self.minOverallValue = 0;
    self.maxOverallValue = 3;

    self.validateFile = function (file) {
      const maxSize = 50 * 1024 * 1024; // 15KB

      if (!file.name.endsWith('.avr') && !file.name.endsWith('.ady')) {
        self.handleError('Please select a .avr or .ady file');
        return false;
      }
      if (file.size > maxSize) {
        self.handleError('File size exceeds 50MB limit');
        return false;
      }

      return true;
    };

    self.onFileLoaded = async function (data) {
      // Handle the loaded JSON data
      self.status('Loaded file: ' + JSON.stringify(data?.title));
      const results = document.getElementById('resultsAvr');
      if (!results) {
        throw new Error('Results element not found');
      }
      results.innerHTML = '';

      const StandardChannelMapping = {
        59: 54,
        60: 55,
        62: 56,
        63: 57,
        58: 54,
        61: 55,
        64: 56,
        47: 54,
        49: 55,
      };

      if (!data.detectedChannels?.[0]) {
        self.handleError('No channels detected');
        return;
      }

      // convert directionnal bass to standard
      data.detectedChannels = data.detectedChannels.map(channel => ({
        ...channel,
        enChannelType:
          StandardChannelMapping[channel.enChannelType] || channel.enChannelType,
      }));

      const numbersOfSubs = data.subwooferNum;
      const subwooferMode = data.subwooferMode;
      const fisrtChannel = data.detectedChannels[0];
      const firstChannelDistance = fisrtChannel.channelReport.distance;

      if (firstChannelDistance) {
        self.DEFAULT_SHIFT_IN_METERS = firstChannelDistance;
      }

      // Check if we have any measurements meaning we have a ady file
      if (data.detectedChannels?.[0].responseData?.[0]) {
        // create zip containing all measurements
        const adyTools = new AdyTools(data);
        const content = await adyTools.parse();

        // check if directionnal bass is present when we have multiple subs
        if (numbersOfSubs && numbersOfSubs > 1) {
          if (!subwooferMode) {
            self.status(
              `${self.status()}\nWARNING: Subwoofer mode not detected with multiple subs. Make sure Directional bass mode was used`
            );
          } else {
            const directionnalBass = subwooferMode === 'Directional';
            if (!directionnalBass) {
              self.handleError('Directional bass mode not detected with multiple subs');
              return;
            }
          }
        }

        // TODO: ampassign can be directionnal must be converted to standard
        for (const [channelIndex, channel] of data.detectedChannels.entries()) {
          const responses = Object.entries(channel.responseData);
          for (const [position, response] of responses) {
            const encodedData = MeasurementItem.encodeRewToBase64(response);
            if (!encodedData) {
              self.handleError('Error encoding array');
              return;
            }
            const options = {
              identifier: `${channel.commandId}_P${Number(position) + 1}`,
              startTime: 0,
              sampleRate: 48000,
              splOffset: AdyTools.SPL_OFFSET,
              applyCal: false,
              data: encodedData,
            };
            await self.apiService.postSafe('import/impulse-response-data', options);
          }

          // remove responseData elements from data
          data.detectedChannels[channelIndex].responseData = [];
        }

        // Create download buttons
        const button = document.createElement('button');
        button.textContent = `Download measurements zip`;
        button.onclick = () => saveAs(content, `${data.title}.zip`);
        results.appendChild(button);
      }

      self.jsonAvrData(data);
      self.OCAFileGenerator = new OCAFileGenerator(data);
    };

    // Handle file reading
    self.readFile = async function (file) {
      if (self.isProcessing()) return;

      try {
        if (!self.isPolling()) {
          throw new Error('Please connect to REW');
        }

        await self.isProcessing(true);

      if (!file) {
          throw new Error('No file selected');
      }

      if (!self.validateFile(file)) {
          throw new Error('File validation failed');
      }

        const fileContent = await new Promise((resolve, reject) => {
      const reader = new FileReader();

          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Error reading file'));

          reader.readAsText(file);
        });

        const data = JSON.parse(fileContent);
          // Handle successful load
        await self.onFileLoaded(data);
        } catch (error) {
        self.handleError(`Error parsing file: ${error.message}`, error);
        } finally {
          self.isProcessing(false);
        }
      };

    // Drop handlers
    self.handleDrop = function (_, e) {
      e.preventDefault();
      self.isDragging(false);

      const file = e.dataTransfer.files[0];
      self.readFile(file);
    };

    self.handleDragOver = function (_, e) {
      e.preventDefault();
    };

    self.handleDragEnter = function (_, e) {
      e.preventDefault();
      self.isDragging(true);
    };

    self.handleDragLeave = function (_, e) {
      e.preventDefault();
      self.isDragging(false);
    };

    // File input handler
    self.handleFileSelect = function (_, e) {
      const file = e.target.files[0];
      self.readFile(file);
    };

    self.keepOriginalForAverage = ko.observable(true);

    self.replaceOriginalForLfeRevert = ko.observable(true);

    self.isProcessing = ko.observable(false);

    self.isProcessing.subscribe(async function (newValue) {
      try {
        if (newValue === false) {
          // Save to persistent storage first
          await self.saveMeasurements();

          if (self.inhibitGraphUpdates) {
            await self.apiService.updateAPI('inhibit-graph-updates', false);
          }
        } else if (newValue === true) {
          self.error('');
          if (self.inhibitGraphUpdates) {
            await self.apiService.updateAPI('inhibit-graph-updates', true);
          }
        }
      } catch (error) {
        throw new Error(`Error in isProcessing subscription: ${error.message}`, {
          cause: error,
        });
      }
    });

    self.currentSelectedPosition = ko.observable();

    self.importMsoConfigInRew = async function (REWconfigs) {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Importing MSO config...');

        for (const [position, subResponses] of Object.entries(
          self.byPositionsGroupedSubsMeasurements()
        )) {
          if (!subResponses?.length) continue;

          const subResponsesTitles = subResponses.map(response =>
            response.displayMeasurementTitle()
          );
          self.status(
            `${self.status()} \nImporting to position: ${position}\n${subResponsesTitles.join('\r\n')}`
          );

          await self.businessTools.importFilterInREW(REWconfigs, subResponses);
          self.status(
            `${self.status()} \nREW import successful for position: ${position}`
          );
        }

        self.status(`${self.status()} Importing finished`);
      } catch (error) {
        self.handleError(`REW import failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttoncheckREWButton = async function () {
      if (self.isProcessing()) return;
      try {
        //self.isProcessing(true);
        //self.status("Pulling...");
        //await self.loadData();
        self.toggleBackgroundPolling();
        //self.status(`${self.rewVersion}: ${self.measurements().length} measurements founds`);
      } catch (error) {
        self.handleError(`Pulling failed: ${error.message}`, error);
      } finally {
        //self.isProcessing(false);
      }
    };

    self.renameMeasurement = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Renaming started');
        for (const item of self.measurements()) {
          if (item.position() === 0) {
            continue;
          }
          // do not rename averaged measurements
          if (item.title().endsWith('avg')) {
            continue;
          }

          if (item.channelName() === self.UNKNOWN_GROUP_NAME) {
            continue;
          }

          const newName = `${item.channelName()}_P${item.position().toString().padStart(2, '0')}`;

          item.setTitle(newName);
        }
        self.status('Renaming succeful');
      } catch (error) {
        self.handleError(`Rename failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonresetREWButton = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Reseting...');
        const defaultSettings = {
          manufacturer: self.EQ_SETTINGS.MANUFACTURER,
          model: self.EQ_SETTINGS.MODEL,
        };
        self.status(`${self.status()}\nSet Generic EQ`);
        await self.apiService.postSafe(`eq/default-equaliser`, defaultSettings);
        self.status(`${self.status()}\nClear commands`);
        await self.apiService.clearCommands();
        const firstMeasurementLevel = await self.mainTargetLevel();
        for (const item of self.measurements()) {
          self.status(`${self.status()}\nReseting ${item.displayMeasurementTitle()}`);
          await item.resetAll(firstMeasurementLevel);
        }

        self.status(`${self.status()}\nReset successful`);
      } catch (error) {
        self.handleError(`Reset failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttoncreatesAverages = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Average is runing...');

        const allOffset = self.measurements().map(item => item.splOffsetdB());
        // Check if we have any measurements
        if (allOffset.length === 0) {
          throw new Error('No valid measurements found');
        }
        const uniqueOffsets = [...new Set(allOffset)];
        if (uniqueOffsets.length > 1) {
          throw new Error('Inconsistent SPL offsets detected in measurements');
        }

        const allAlignOffset = self.measurements().map(item => item.alignSPLOffsetdB());
        const uniqueAlignOffsets = new Set(allAlignOffset);
        if (uniqueAlignOffsets.size !== 1) {
          throw new Error(`Some measurements have SPL offset, please undo SPL alignment`);
        }

        const allcumulativeIRShiftSeconds = self
          .measurements()
          .map(item => item.cumulativeIRShiftSeconds().toFixed(7));
        const uniquecumulativeIRShiftSeconds = new Set(allcumulativeIRShiftSeconds);
        if (uniquecumulativeIRShiftSeconds.size !== 1) {
          throw new Error(
            `Some measurements have timing offset, please undo t=0 changes`
          );
        }

        // creates array of uuid attributes for each code into groupedResponse
        await self.businessTools.processGroupedResponses(
          self.groupedMeasurements(),
          self.selectedAverageMethod(),
          self.keepOriginalForAverage()
        );
        self.status(`Averages created successfully`);
      } catch (error) {
        self.handleError(`Averages failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonrevertLfeFilter = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Reverting LFE filter...');

        await self.businessTools.revertLfeFilterProccess(
          true,
          self.selectedLfeFrequency(),
          self.replaceOriginalForLfeRevert()
        );

        self.status('LFE filter reverted successfully');
      } catch (error) {
        self.handleError(`Reverting LFE filter failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonproduceSubSumAllPositions = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Computing sum...');

        const firstMeasurementLevel = await self.mainTargetLevel();
        for (const subItem of self.subsMeasurements()) {
          await subItem.setTargetLevel(firstMeasurementLevel);
        }

        for (const [position, subResponses] of Object.entries(
          self.byPositionsGroupedSubsMeasurements()
        )) {
          await self.produceSumProcess(self, subResponses);
        }
      } catch (error) {
        self.handleError(`Sum failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonAlignPeaks = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Align peaks...');

        const firstMeasurement = self.uniqueSpeakersMeasurements()[0];
        const firstMeasurementPeak = firstMeasurement.timeOfIRPeakSeconds;
        console.debug(
          `peak time target ${firstMeasurement.displayMeasurementTitle()}: ${(firstMeasurementPeak * 1000).toFixed(2)}ms`
        );

        for (const measurement of self.uniqueSpeakersMeasurements()) {
          // skip first measurement
          if (measurement.uuid === firstMeasurement.uuid) continue;
          const offset = -firstMeasurementPeak + measurement.timeOfIRPeakSeconds;
          console.debug(
            `${measurement.displayMeasurementTitle()} -> ${(offset * 1000).toFixed(2)}ms`
          );
          await measurement.addIROffsetSeconds(offset);
          // apply SPLoffset to other measurement positions
          await measurement.copyCumulativeIRShiftToOther();
        }

        self.status('Align peaks successful');
      } catch (error) {
        self.handleError(`Sum failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonAlignSPL = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Computing SPL alignment...');

        console.debug(`Computing SPL alignment`);
        const firstMeasurementLevel = await self.mainTargetLevel();

        for (const measurement of self.uniqueSpeakersMeasurements()) {
          await measurement.applyWorkingSettings();
          await measurement.resetTargetSettings();
          await measurement.eqCommands('Calculate target level');
          const targetLevel = await measurement.getTargetLevel();
          await measurement.addSPLOffsetDB(firstMeasurementLevel - targetLevel);
          await measurement.setTargetLevel(firstMeasurementLevel);
          await measurement.copySplOffsetDeltadBToOther();
          await measurement.removeWorkingSettings();
        }

        self.status('SPL alignment successful');
      } catch (error) {
        self.handleError(`SPL alignment: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonCreateFilter = async function (measurement) {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);

        await measurement.createStandardFilter();
        await measurement.copyFiltersToOther();
      } catch (error) {
        self.handleError(`Filter compute failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonproduceSubSum = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Computing sum...');

        // await this.createsSumFromFR(self.uniqueSubsMeasurements());

        await self.produceSumProcess(self, self.uniqueSubsMeasurements());
      } catch (error) {
        self.handleError(`Sum failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonproduceAlignedButton = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Searching for alignement...');

        await self.loadData();

        const selectedLfe = self.predictedLfeMeasurement();

        if (!selectedLfe) {
          throw new Error(`No LFE found, please use sum subs button`);
        }
        const speakerItem = self.findMeasurementByUuid(self.selectedSpeaker());
        const result = await self.businessTools.produceAligned(
          selectedLfe,
          self.selectedAlignFrequency(),
          speakerItem,
          self.uniqueSubsMeasurements()
        );
        for (const sub of self.uniqueSubsMeasurements()) {
          // copy to other positions
          await sub.copyCumulativeIRShiftToOther();
        }

        for (const predictedLfe of self.allPredictedLfeMeasurement()) {
          // skip selected lfe
          if (predictedLfe.uuid === selectedLfe.uuid) continue;
          await predictedLfe.setcumulativeIRShiftSeconds(
            selectedLfe.cumulativeIRShiftSeconds()
          );
          await predictedLfe.setInverted(selectedLfe.inverted());
        }

        self.status(result);
      } catch (error) {
        self.handleError(`Alignement search failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttongenratesPreview = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);

        for (const item of self.uniqueSpeakersMeasurements()) {
          // display progression in the status
          self.status(`Generating preview for ${item.displayMeasurementTitle()}`);
          await self.businessTools.createMeasurementPreview(item);
          await item.copyAllToOther();
        }

        self.status('Preview generated successfully');
      } catch (error) {
        self.handleError(`Preview failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttongeneratesFilters = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);

        for (const item of self.uniqueSpeakersMeasurements()) {
          // display progression in the status
          self.status(`Generating filter for channel ${item.channelName()}`);
          await item.createStandardFilter();
          await item.copyFiltersToOther();
        }

        self.status('Filters generated successfully');
      } catch (error) {
        self.handleError(`Filter generation failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.softRoll = ko.observable(false);
    self.enableDynamicEq = ko.observable(false);
    self.dynamicEqRefLevel = ko.observable(0);
    self.enableDynamicVolume = ko.observable(false);
    self.dynamicVolumeSetting = ko.observable(0);
    self.enableLowFrequencyContainment = ko.observable(false);
    self.lowFrequencyContainmentLevel = ko.observable(3);
    self.subwooferOutput = ko.observable('LFE');
    self.lpfForLFE = ko.observable();

    // Available filter options
    self.subwooferOutputChoice = [
      { value: 'LFE', text: 'LFE' },
      { value: 'L+M', text: 'L+M' },
    ];

    self.buttoncreateOCAButton = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('OCA file generation...');
        const measurementsinError = self
          .uniqueMeasurements()
          .filter(item => item.hasErrors());

        if (measurementsinError.length > 0) {
          console.warn(
            `There are ${measurementsinError.length} measurements with errors. Please fix them before generating the OCA file.`
          );
        }
        if (!self.OCAFileGenerator) {
          throw new Error(`Please load avr file first`);
        }
        this.targetCurve = await this.apiService.checkTargetCurve();
        self.OCAFileGenerator.tcName = `${self.targetCurve} ${await self.mainTargetLevel()}dB`;
        self.OCAFileGenerator.softRoll = self.softRoll();
        self.OCAFileGenerator.enableDynamicEq = self.enableDynamicEq();
        self.OCAFileGenerator.dynamicEqRefLevel = self.dynamicEqRefLevel();
        self.OCAFileGenerator.enableDynamicVolume = self.enableDynamicVolume();
        self.OCAFileGenerator.dynamicVolumeSetting = self.dynamicVolumeSetting();
        self.OCAFileGenerator.enableLowFrequencyContainment =
          self.enableLowFrequencyContainment();
        self.OCAFileGenerator.lowFrequencyContainmentLevel =
          self.lowFrequencyContainmentLevel();
        self.OCAFileGenerator.subwooferOutput = self.subwooferOutput();
        self.OCAFileGenerator.lpfForLFE = self.lpfForLFE();
        self.OCAFileGenerator.numberOfSubwoofers = self.uniqueSubsMeasurements().length;
        self.OCAFileGenerator.versionEvo = 'Sangoku_custom';

        const jsonData = await self.OCAFileGenerator.createOCAFile(
          self.uniqueMeasurements()
        );

        // Validate input
        if (!jsonData) {
          throw new Error('No data to save');
        }

        // Create timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${timestamp}_${self.OCAFileGenerator.versionEvo}.oca`;

        // Create blob
        const blob = new Blob([jsonData], {
          type: 'application/json',
        });

        // Save file
        saveAs(blob, filename);

        self.status('OCA file created successfully');
      } catch (error) {
        self.handleError(`OCA file failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonCreatesMsoExports = async function () {
      if (self.isProcessing()) return;
      try {
        if (!self.isPolling()) {
          throw new Error('Please start connetion first');
        }

        self.isProcessing(true);
        self.status('Exports Subs...');

        const frequencyResponses = [];
        const jszip = new JSZip();
        const zipFilename = `MSO ${self.OCAFileGenerator.model}.zip`;
        const minFreq = 5; // minimum frequency in Hz
        const maxFreq = 400; // maximum frequency in Hz

        // Helper function to process chunks of measurements
        async function processMeasurementChunk(measurements) {
          return Promise.all(
            measurements.map(async measurement => {
              await measurement.resetAll();
              const frequencyResponse = await measurement.getFrequencyResponse();
              const subName = measurement.channelName().replace('SW', 'Sub ');
              const localFilename = `${subName}_Pos ${measurement.position()}.txt`;

              const filecontent = frequencyResponse.freqs.reduce((acc, freq, i) => {
                if (freq >= minFreq && freq <= maxFreq) {
                  const line = `${freq.toFixed(6)}  ${frequencyResponse.magnitude[i].toFixed(3)} ${frequencyResponse.phase[i].toFixed(4)}`;
                  return acc ? `${acc}\n${line}` : line;
                }
                return acc;
              }, '');

              if (!filecontent) {
                throw new Error(`no file content for ${localFilename}`);
              }

              frequencyResponses.push(jszip.file(localFilename, filecontent));
            })
          );
        }

        // Process measurements in chunks of 4
        const measurements = self.subsMeasurements();
        const chunkSize = 5;

        for (let i = 0; i < measurements.length; i += chunkSize) {
          const chunk = measurements.slice(i, i + chunkSize);
          await processMeasurementChunk(chunk);
        }

        // Generate the zip file once and save it
        const zipContent = await jszip.generateAsync({ type: 'blob' });
        saveAs(zipContent, zipFilename);
        self.status('Exports Subs successful');
      } catch (error) {
        self.handleError(`Exports Subs failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.buttonMultiSubOptimizer = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('MultiSubOptimizer...');

        await self.loadData();

        const maximisedSumTitle = 'LFE Max Sum';
        const subsMeasurements = self.uniqueSubsMeasurements();
        const firstMeasurement = subsMeasurements[0];
        // align the others sub to first measurement delay
        const mainDelay = firstMeasurement.cumulativeIRShiftSeconds();
        const firstMeasurementLevel = await self.mainTargetLevel();
        const frequencyResponses = [];
        // Find the level of target curve at 40Hz
        const targetCurveResponse = await firstMeasurement.getTargetResponse('SPL', 6);
        if (!targetCurveResponse) {
          throw new Error('Failed to get target curve response');
        }
        const targetFreq = 40;
        const targetLevelAtFreq = (() => {
          const freqIndex = targetCurveResponse.freqs.reduce((closestIdx, curr, idx) => {
            const closestFreq = targetCurveResponse.freqs[closestIdx];
            return Math.abs(curr - targetFreq) < Math.abs(closestFreq - targetFreq)
              ? idx
              : closestIdx;
          }, 0);
          return targetCurveResponse.magnitude[freqIndex];
        })();
        // adjut target level according to the number of subs
        const numbersOfSubs = subsMeasurements.length;
        const overhead = 10 * Math.log10(numbersOfSubs);
        const targetLevel =
          targetLevelAtFreq - overhead + Number(self.additionalBassGainValue());

        let lowFrequency = Infinity;
        let highFrequency = 0;

        for (const measurement of subsMeasurements) {
          // await measurement.resetcumulativeIRShiftSeconds();
          await measurement.setInverted(false);
          await measurement.resetFilters();
          await measurement.resetSmoothing();
          await measurement.setcumulativeIRShiftSeconds(mainDelay);

          const frequencyResponse = await measurement.getFrequencyResponse(
            'SPL',
            '1/2',
            6
          );
          frequencyResponse.measurement = measurement.uuid;
          frequencyResponse.position = measurement.position();
          const detect = this.detectSubwooferCutoff(
            frequencyResponse.freqs,
            frequencyResponse.magnitude,
            -18
          );

          // if detect low frequency is lower than previous lowFrequency
          if (detect.lowCutoff < lowFrequency) {
            lowFrequency = Math.round(detect.lowCutoff);
          }
          if (detect.highCutoff > highFrequency) {
            highFrequency = Math.round(detect.highCutoff);
          }

          self.status(
            `${self.status()} \nAdjust ${measurement.displayMeasurementTitle()} SPL levels to ${targetLevel.toFixed(1)}dB`
          );
          self.status(
            `${self.status()} (center: ${detect.centerFrequency}Hz, ${detect.octaves} octaves, ${detect.lowCutoff}Hz - ${detect.highCutoff}Hz)`
          );
          await this.processCommands('Align SPL', [measurement.uuid], {
            frequencyHz: detect.centerFrequency,
            spanOctaves: detect.octaves,
            targetdB: targetLevel,
          });
        }

        const optimizerConfig = {
          frequency: {
            min: lowFrequency, // Hz
            max: highFrequency, // Hz
          },
          gain: {
            min: 0, // dB
            max: 0, // dB
            step: 0.1, // dB
          },
          delay: {
            min: -0.005, // 5ms
            max: 0.005, // 5ms
            step: 0.00001, // 0.01ms
          },
        };

        self.status(
          `${self.status()} \nfrequency range: ${optimizerConfig.frequency.min}Hz - ${optimizerConfig.frequency.max}Hz`
        );
        self.status(
          `${self.status()} delay range: ${optimizerConfig.delay.min * 1000}ms - ${optimizerConfig.delay.max * 1000}ms`
        );

        self.status(`${self.status()} \nDeleting previous settings...`);

        const previousMaxSum = self
          .measurements()
          .filter(item => item.title() === maximisedSumTitle);
        for (const item of previousMaxSum) {
          await item.delete();
        }

        for (const measurement of subsMeasurements) {
          const frequencyResponse = await measurement.getFrequencyResponse();
          frequencyResponse.measurement = measurement.uuid;
          frequencyResponse.position = measurement.position();
          frequencyResponses.push(frequencyResponse);
        }

        self.status(`${self.status()} \nSarting lookup...`);
        const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig);
        const optimizerResults = await optimizer.optimizeSubwoofers();

        const optimizedSubs = optimizerResults.optimizedSubs;

        // Apply each configuration sequentially
        for (const sub of optimizedSubs) {
          const subMeasurement = self.findMeasurementByUuid(sub.measurement);
          if (!subMeasurement) {
            throw new Error(`Measurement not found for ${sub.measurement}`);
          }
          try {
            // invert
            if (sub.param.polarity === -1) {
              await subMeasurement.setInverted(true);
            } else if (sub.param.polarity === 1) {
              await subMeasurement.setInverted(false);
            } else {
              throw new Error(
                `Invalid invert value for ${await subMeasurement.displayMeasurementTitle()}`
              );
            }
            // reverse delay if previous iteration and apply specified delay
            await subMeasurement.addIROffsetSeconds(sub.param.delay);

            await subMeasurement.addSPLOffsetDB(sub.param.gain);
          } catch (error) {
            throw new Error(
              `Error processing channel ${subMeasurement.displayMeasurementTitle()}: ${error.message}`
            );
          }
          const delayMs = (sub.param.delay * 1000).toFixed(2);
          const infoMessage = `${subMeasurement.displayMeasurementTitle()} inverted: ${sub.param.polarity === -1} delay: ${delayMs}ms`;
          self.status(`${self.status()} \n${infoMessage}`);
          console.debug(infoMessage);
        }

        self.status(`${self.status()} \nCreates sub sumation`);
        // DEBUG use REW api way to generate the sum for compare
        // const maximisedSum = await self.produceSumProcess(self, subsMeasurements);

        const optimizedSubsSum = await optimizer.getFinalSubSum();

        const optimizedSubsSumPeak = self.getMaxFromArray(optimizedSubsSum.magnitude);

        const detectOptimizedSubs = this.detectSubwooferCutoff(
          optimizedSubsSum.freqs,
          optimizedSubsSum.magnitude,
          targetLevelAtFreq - optimizedSubsSumPeak
        );

        const maximisedSum = await this.sendToREW(optimizedSubsSum, maximisedSumTitle);
        // DEBUG to check it this is the same
        // await this.sendToREW(optimizerResults.bestSum, 'test');

        self.status(
          `${self.status()} \nCreating EQ filters for sub sumation ${detectOptimizedSubs.lowCutoff}Hz - ${detectOptimizedSubs.highCutoff}Hz`
        );

        await this.apiService.postSafe(`eq/match-target-settings`, {
          startFrequency: detectOptimizedSubs.lowCutoff,
          endFrequency: detectOptimizedSubs.highCutoff,
          individualMaxBoostdB: self.maxBoostIndividualValue(),
          overallMaxBoostdB: self.maxBoostOverallValue(),
          flatnessTargetdB: 1,
          allowNarrowFiltersBelow200Hz: false,
          varyQAbove200Hz: false,
          allowLowShelf: false,
          allowHighShelf: false,
        });

        await maximisedSum.setTargetLevel(firstMeasurementLevel);
        await maximisedSum.eqCommands('Match target');

        const filters = await maximisedSum.getFilters();

        //await self.removeMeasurement(maximisedSum);

        self.status(`${self.status()} \nApply calculated filters to each sub`);

        for (const sub of subsMeasurements) {
          await sub.setFilters(filters);
          await sub.copyFiltersToOther();
          await sub.copyCumulativeIRShiftToOther();
          await sub.copySplOffsetDeltadBToOther();
        }

        self.status(`${self.status()} \nMultiSubOptimizer successfull`);
      } catch (error) {
        self.handleError(`MultiSubOptimizer failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.copyParametersToAllPosition = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Copy started');
        await self.copyMeasurementCommonAttributes();
        self.status('Copy succeful');
      } catch (error) {
        self.handleError(`Copy failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.previewMeasurement = async function (measurement) {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        await self.businessTools.createMeasurementPreview(measurement);
        await measurement.copyAllToOther();
      } catch (error) {
        self.handleError(`Preview generation failed: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    // Computed for filtered measurements
    self.subsMeasurements = ko.computed(() => {
      return self.measurements().filter(item => item.isSub());
    });

    self.groupedMeasurements = ko.computed(() => {
      // group data by channelName attribute and set isSelected to true for the first occurrence
      return self.measurements().reduce((acc, item) => {
        const channelName = item.channelName();

        if (channelName === self.UNKNOWN_GROUP_NAME) {
          return acc;
        }

        if (!acc[channelName]) {
          acc[channelName] = {
            items: [],
            count: 0,
          };
        }
        // Add item to group
        acc[channelName].items.push(item);
        acc[channelName].count++;
        return acc;
      }, {});
    });
    // creates a map from groupedMeasurements with items grouped by the same position attribute
    self.byPositionsGroupedSubsMeasurements = ko.computed(() => {
      return self.subsMeasurements().reduce((acc, item) => {
        const key = item.position();
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(item);
        return acc;
      }, {});
    });

    self.measurementsPositionList = ko.computed(() => {
      try {
        return [
          ...new Set(
            self
              .measurements()
              .map(item => item.position())
              .filter(Boolean)
          ),
        ];
      } catch (error) {
        self.handleError('Error computing measurements position list:', error);
        return [];
      }
    });

    // Filtered measurements
    self.uniqueMeasurements = ko.computed(() => {
      const measurements = self.measurements();
      return measurements.length ? measurements.filter(item => item.isSelected()) : [];
    }, self);

    // Filtered measurements
    self.notUniqueMeasurements = ko.computed(() => {
      const measurements = self.measurements();
      return measurements.length ? measurements.filter(item => !item.isSelected()) : [];
    }, self);

    // Filtered measurements
    self.uniqueMeasurementsView = ko.computed(() => {
      if (self.selectedMeasurementsFilter()) {
        return self.uniqueMeasurements();
      }
      return self.measurements();
    });

    self.minDistanceInMeters = ko.computed(() => {
      return Math.min(...self.uniqueMeasurements().map(item => item.distanceInMeters()));
    });

    self.maxDistanceInMetersWarning = ko.computed(() => {
      return self.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_LIMIT;
    });

    self.maxDistanceInMetersError = ko.computed(() => {
      return self.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_CRITICAL_LIMIT;
    });

    self.maxDdistanceInMeters = ko.computed(() => {
      return Math.max(...self.uniqueMeasurements().map(item => item.distanceInMeters()));
    });

    self.uniqueSubsMeasurements = ko.computed(() => {
      return self.uniqueMeasurements().filter(item => item.isSub());
    });

    self.predictedLfeMeasurementTitle = ko.computed(() => {
      // Get the unique measurements array
      const uniqueSubs = self.uniqueSubsMeasurements();

      // Early return if no measurements
      if (!uniqueSubs || uniqueSubs.length === 0) {
        return undefined;
      }

      // Case: Single subwoofer
      if (uniqueSubs.length === 1) {
        const firstSub = uniqueSubs[0];
        return firstSub?.title() || undefined;
      }

      // Case: Multiple subwoofers
      if (uniqueSubs.length > 1) {
        const position = self.currentSelectedPosition();
        return position ? `${self.DEFAULT_LFE_PREDICTED}${position}` : undefined;
      }

      return undefined;
    });

    self.allPredictedLfeMeasurement = ko.computed(() => {
      const uniqueSubs = self.uniqueSubsMeasurements();
      // Case: Single subwoofer
      if (uniqueSubs.length === 1) {
        return self.subsMeasurements();
      } else {
        return self
          .measurements()
          .filter(response => response?.title().startsWith(self.DEFAULT_LFE_PREDICTED));
      }
    });

    self.predictedLfeMeasurement = ko.computed(() => {
      return self
        .allPredictedLfeMeasurement()
        .find(response => response?.title() === self.predictedLfeMeasurementTitle());
    });

    self.uniqueSpeakersMeasurements = ko.computed(() => {
      return self.uniqueMeasurements().filter(item => !item.isSub());
    });
  }

  async mainTargetLevel() {
    const firstMeasurement = this.uniqueMeasurements()[0];
    if (!firstMeasurement) {
      return this.DEFAULT_TARGET_LEVEL;
    }
    const level = await firstMeasurement.getTargetLevel();
    return Number(level.toFixed(2));
  }

  async setTargetLevelToAll() {
    const firstMeasurementLevel = await this.mainTargetLevel();
    for (const measurement of this.measurements()) {
      await measurement.setTargetLevel(firstMeasurementLevel);
    }
    return firstMeasurementLevel;
  }

  getMaxFromArray(array) {
    if (!Array.isArray(array)) {
      throw new Error('Input is not an array');
    }

    let maxPeak = -Infinity;
    for (const value of array) {
      if (value > maxPeak) {
        maxPeak = value;
      }
    }
    return maxPeak;
  }

  /**
   * Detect subwoofer frequency cutoff points
   * @param {number[]} frequencies - Array of frequency points
   * @param {number[]} magnitude - Array of magnitude values in dB
   * @param {number} thresholdDb - Cutoff threshold in dB (default -6dB)
   * @param {number} low - Lower frequency bound (default 10Hz)
   * @param {number} high - Upper frequency bound (default 500Hz)
   * @returns {Object} Object containing low and high cutoff frequencies and peak magnitude
   */
  detectSubwooferCutoff(frequencies, magnitude, thresholdDb = -6, low = 10, high = 500) {
    // Input validation
    if (
      !frequencies?.length ||
      !magnitude?.length ||
      frequencies.length !== magnitude.length
    ) {
      throw new Error('Invalid input arrays');
    }

    if (thresholdDb >= 0) {
      throw new Error('Threshold must be negative');
    }

    // Find peak magnitude using array methods instead of loop
    const peakMagnitude = this.getMaxFromArray(
      magnitude.filter((_, i) => frequencies[i] >= low && frequencies[i] <= high)
    );

    // Calculate threshold level once
    const thresholdLevel = peakMagnitude + thresholdDb;

    // Find low frequency cutoff using find method
    const lowIndex = frequencies.findIndex((_, i) => magnitude[i] >= thresholdLevel);

    // Find high frequency cutoff using findLast method
    const highIndex = frequencies.findLastIndex((_, i) => magnitude[i] >= thresholdLevel);

    // Calculate cutoff frequencies with interpolation
    let lowCutoff =
      lowIndex > 0
        ? this.interpolateFrequency(
            frequencies[lowIndex - 1],
            frequencies[lowIndex],
            magnitude[lowIndex - 1],
            magnitude[lowIndex],
            thresholdLevel
          )
        : frequencies[lowIndex];

    let highCutoff =
      highIndex < frequencies.length - 1
        ? this.interpolateFrequency(
            frequencies[highIndex],
            frequencies[highIndex + 1],
            magnitude[highIndex],
            magnitude[highIndex + 1],
            thresholdLevel
          )
        : frequencies[highIndex];

    // find the center frequency by octaves bettween lowCutoff and highCutoff
    const centerFrequency = this.roundToPrecision(Math.sqrt(lowCutoff * highCutoff), 1);

    // count the number of octaves between low and high cutoff from center frequency and round to lowest integer
    const octaves = Math.floor(Math.log2(highCutoff / centerFrequency) * 2);

    // Round to nearest integer
    highCutoff = Math.round(highCutoff);
    lowCutoff = Math.round(lowCutoff);

    return {
      lowCutoff,
      highCutoff,
      centerFrequency,
      octaves,
      peakMagnitude,
    };
  }

  /**
   * Linear interpolation for frequency
   */
  interpolateFrequency(freq1, freq2, mag1, mag2, targetMag) {
    const ratio = (targetMag - mag1) / (mag2 - mag1);
    return freq1 + (freq2 - freq1) * ratio;
  }

  /**
   * Round number to specified decimal places
   */
  roundToPrecision(number, precision = 1) {
    return Number(Math.round(number + 'e' + precision) + 'e-' + precision);
  }

  async createsSumFromFR(measurementList) {
    try {
      if (!Array.isArray(measurementList) || measurementList.length === 0) {
        throw new Error('Invalid measurement list');
      }
      const frequencyResponses = [];
      for (const measurement of measurementList) {
        const frequencyResponse = await measurement.getFrequencyResponse();
        frequencyResponse.uuid = measurement.uuid;
        frequencyResponses.push(frequencyResponse);
      }

      const optimizer = await new MultiSubOptimizer(frequencyResponses);
      const optimizedSubsSum =
        await optimizer.calculateCombinedResponse(frequencyResponses);
      const data = await optimizer.displayResponse(optimizedSubsSum);

      // Create blob with data content
      const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });

      // Save file using FileSaver
      await saveAs(blob, `sum.txt`);
    } catch (error) {
      throw new Error(`Failed to create sum: ${error.message}`, {
        cause: error,
      });
    }
  }

  async sendToREW(optimizedSubsSum, maximisedSumTitle) {
    const encodedMagnitudeData = MeasurementItem.encodeRewToBase64(
      optimizedSubsSum.magnitude
    );
    const encodedPhaseData = MeasurementItem.encodeRewToBase64(optimizedSubsSum.phase);

    if (!encodedMagnitudeData || !encodedPhaseData) {
      this.handleError('Error encoding array');
      return;
    }
    const options = {
      identifier: maximisedSumTitle.slice(0, 24),
      isImpedance: false,
      startFreq: optimizedSubsSum.freqs[0],
      freqStep: optimizedSubsSum.freqStep,
      magnitude: encodedMagnitudeData,
      phase: encodedPhaseData,
    };
    await this.apiService.postSafe('import/frequency-response-data', options);

    // trick to retreive the imported measurement
    await this.loadData();
    const maximisedSum = this.measurements().find(
      item => item.title() === options.identifier
    );

    if (!maximisedSum) {
      throw new Error('Error creating maximised sum');
    }

    return maximisedSum;
  }

  async copyMeasurementCommonAttributes() {
    console.time('copyMeasurements');

    for (const item of this.uniqueMeasurements()) {
      await item.copyAllToOther();
    }

    console.timeEnd('copyMeasurements');
  }

  updateTranslations(language) {
    this.translations(translations[language]);
    // Update any observable text that needs translation
    // Force Knockout to re-evaluate bindings
    ko.tasks.runEarly();
  }

  async produceSumProcess(self, subsList) {
    if (!subsList?.length) {
      throw new Error(`No subs found`);
    }
    if (subsList.length < 2) {
      throw new Error(`Not enough subs found to compute sum`);
    }
    const subResponsesTitles = subsList.map(response =>
      response.displayMeasurementTitle()
    );
    self.status(`${self.status()} \nUsing: \n${subResponsesTitles.join('\r\n')}`);
    // get first subsList element position
    const position = subsList[0].position();
    const resultTitle = self.DEFAULT_LFE_PREDICTED + position;

    const previousSubSum = self.measurements().find(item => item.title() === resultTitle);
    // remove previous
    if (previousSubSum) {
      await self.removeMeasurement(previousSubSum);
    }
    // create sum of all subwoofer measurements
    const newDefaultLfePredicted = await self.businessTools.createsSum(
      subsList,
      true,
      resultTitle
    );

    self.status(
      `${self.status()} \nSubwoofer sum created successfully: ${newDefaultLfePredicted.title()}`
    );
    return newDefaultLfePredicted;
  }

  async loadData() {
    try {
      this.isLoading(true);

      const data = await this.apiService.fetchREW();

      this.mergeMeasurements(data);
    } catch (error) {
      throw new Error(`Failed to load data: ${error.message}`, {
        cause: error,
      });
    } finally {
      this.isLoading(false);
    }
  }

  mergeMeasurements(data) {
    const currentMeasurements = this.measurements();
    const existingKeys = new Set(currentMeasurements.map(m => m.uuid));
    const newKeys = new Set(Object.values(data).map(m => m.uuid));

    // Handle updates and additions
    const mergedMeasurements = Object.entries(data).map(([key, item]) => {
      const existingMeasurement = currentMeasurements.find(m => m.uuid === item.uuid);
      if (existingMeasurement) {
        //console.debug(`Update existing measurement: ${key}: ${item.title}`);
        return this.updateObservableObject(existingMeasurement, item);
      }
      console.debug(`Create new measurement: ${key}: ${item.title}`);
      return new MeasurementItem(item, this);
    });

    this.measurements(mergedMeasurements);

    // Handle deletions
    const deletedKeys = [...existingKeys].filter(uuid => !newKeys.has(uuid));
    if (deletedKeys.length > 0) {
      for (const uuid of deletedKeys) {
        const isDeleted = this.measurements.remove(function (item) {
          return item.uuid === uuid;
        });
        if (isDeleted) console.debug(`removed: ${uuid}`);
      }
    }

    // update associated filters
    const unlikedFilter = mergedMeasurements.filter(
      item => item.associatedFilter && !newKeys.has(item.associatedFilter)
    );

    if (unlikedFilter.length > 0) {
      for (const item of unlikedFilter) {
        item.associatedFilter = null;
        console.debug(`Removing filter: ${item.displayMeasurementTitle()}`);
      }
    }
  }

  // Helper function to handle observable properties
  updateObservableObject(target, source) {
    Object.keys(source).forEach(key => {
      if (ko.isObservable(target[key])) {
        // If the property is an observable, update its value
        target[key](source[key]);
      } else if (typeof source[key] === 'object' && source[key] !== null && target[key]) {
        // Handle nested objects
        this.updateObservableObject(target[key], source[key]);
      } else if (!ko.isObservable(target[key])) {
        // For non-observable properties, directly assign
        target[key] = source[key];
      }
    });
    return target;
  }

  findMeasurementByUuid(uuid) {
    return this.measurements().find(m => m.uuid === uuid);
  }

  // add measurement
  async addMeasurementApi(itemUuid) {
    if (!itemUuid) {
      throw new Error('Add Measurement: Invalid measurement item');
    }
    const existingItem = this.findMeasurementByUuid(itemUuid);
    if (existingItem) {
      console.warn(`measurement ${itemUuid} already exists, not added`);
      return existingItem;
    }
    try {
      // First attempt to delete from API to ensure consistency
      const item = await this.apiService.fetchREW(itemUuid, 'GET', null, 0);
      // Transform data using the MeasurementItem class
      const measurementItem = new MeasurementItem(item, this);
      await this.addMeasurement(measurementItem);
      console.debug(`measurement ${item.title} added`);
      return measurementItem;
    } catch (error) {
      this.handleError(`Failed to add measurement: ${error.message}`, error);
    }
  }

  // add measurement
  async addMeasurement(item) {
    if (!item) {
      throw new Error('Add Measurement: Invalid measurement item');
    }

    try {
      // check if already exists
      const existingItem = this.findMeasurementByUuid(item.uuid);

      if (existingItem) {
        console.warn(
          `measurement ${item.measurementIndex()}: ${item.title()} already exists, not added`
        );
        return false;
      } else {
        this.measurements.push(item);
      }

      return true; // Indicate successful addition
    } catch (error) {
      this.handleError(`Failed to add measurement: ${error.message}`, error);
    }
  }

  async removeMeasurement(item) {
    if (!item) {
      return false;
    }

    await this.removeMeasurementUuid(item.uuid);
    // remove associatedFilter
    await this.removeMeasurementUuid(item.associatedFilter);

    this.status(
      `${this.status()} \nmeasurement ${item.displayMeasurementTitle()} removed`
    );

    return true;
  }

  async removeMeasurementUuid(itemUuid) {
    if (!itemUuid) {
      return false;
    }

    if (!this.findMeasurementByUuid(itemUuid)) {
      console.debug('nothing to delete');
      return false;
    }

    try {
      // First attempt to delete from API to ensure consistency
      await this.apiService.postDelete(itemUuid, 0);

      this.measurements.remove(function (item) {
        return item.uuid === itemUuid;
      });

      console.debug(`measurement ${itemUuid} removed`);

      return true; // Indicate successful deletion
    } catch (error) {
      if (error.message.includes('There is no measurement')) {
        console.warn(`measurement ${itemUuid} not found, not removed`);
        return false;
      }
      throw new Error(`Failed to remove measurement: ${error.message}`, { cause: error });
    }
  }

  // add measurement
  async doArithmeticOperation(itemUuidA, itemUuidB, operationObject) {
    if (!itemUuidA || !itemUuidB) {
      throw new Error('Arithmetic Operation: Invalid measurement item');
    }

    const allowedCommands = [
      'A + B',
      'A - B',
      'A * B',
      'A * B conjugate',
      'A / B',
      '|A| / |B|',
      '(A + B) / 2',
      'Merge B to A',
      '1 / A',
      '1 / B',
      '1 / |A|',
      '1 / |B|',
      'Invert A phase',
      'Invert B phase',
    ];

    if (allowedCommands.indexOf(operationObject.function) === -1) {
      throw new Error(`Command ${operationObject.function} is not allowed`);
    }

    const operationResult = await this.processCommands(
      'Arithmetic',
      [itemUuidA, itemUuidB],
      operationObject
    );

    // Save to persistent storage
    return operationResult;
  }

  // add measurement
  async processCommands(commandName, uuids, commandData) {
    if (!uuids || !Array.isArray(uuids)) {
      throw new Error('Process Command: Invalid measurement item');
    }

    const withoutResultCommands = [
      'Align SPL',
      'Time align',
      'Align IR start',
      'Cross corr align',
      'Smooth',
      'Remove IR delays',
    ];

    const allowedCommands = [
      ...withoutResultCommands,
      'Vector average',
      'RMS average',
      'dB average',
      'Magn plus phase average',
      'dB plus phase average',
      'Vector sum',
      'Arithmetic',
    ];

    if (allowedCommands.indexOf(commandName) === -1) {
      throw new Error(`Command ${commandName} is not allowed`);
    }

    try {
      const operationResult = await this.apiService.postNext(
        commandName,
        uuids,
        commandData,
        0
      );

      if (withoutResultCommands.indexOf(commandName) !== -1) {
        return operationResult;
      } else {
        const operationResultUuid = Object.values(operationResult.results || {})[0]?.UUID;
        // Save to persistent storage
        return await this.addMeasurementApi(operationResultUuid);
      }
    } catch (error) {
      throw new Error(`Failed to create ${commandName} operation: ${error.message}`, {
        cause: error,
      });
    }
  }

  async findAligment(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 3,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5
  ) {
    if (createSum && !sumTitle) {
      throw new Error('sumTitle is required when createSum is true');
    }

    try {
      await this.apiService.postSafe(`alignment-tool/remove-time-delay`, false);
      await this.apiService.postAlign('Reset all');
      await this.apiService.postSafe(`alignment-tool/max-negative-delay`, minSearchRange);
      await this.apiService.postSafe(`alignment-tool/max-positive-delay`, maxSearchRange);
      await this.apiService.postSafe('alignment-tool/uuid-a', channelA.uuid);
      await this.apiService.postSafe('alignment-tool/uuid-b', channelB.uuid);
      // await this.apiService.postSafe(`alignment-tool/mode`, "Phase");
      // const AlignResults = await postAlign('Align phase', frequency);
      await this.apiService.postSafe(`alignment-tool/mode`, 'Impulse');
      const AlignResults = await this.apiService.postAlign('Align IRs', frequency);

      const AlignResultsDetails = AlignResults.results[0];

      if (AlignResultsDetails.Error?.length > 0) {
        throw new Error(AlignResultsDetails.Error);
      }

      const shiftDelayMs = Number(AlignResultsDetails['Delay B ms']);
      if (shiftDelayMs === undefined) {
        throw new Error(
          'alignment-tool: Invalid AlignResults object or missing Delay B ms'
        );
      }
      if (shiftDelayMs === maxSearchRange || shiftDelayMs === minSearchRange) {
        console.warn('alignment-tool: Shift is maxed out to the limit: ' + shiftDelayMs);
      }
      const isBInverted = AlignResultsDetails['Invert B'] === 'true';

      if (isBInverted) {
        console.warn('alignment-tool: results provided were with channel B inverted');
      }
      if (createSum) {
        const alignedSum = await this.apiService.postAlign('Aligned sum');
        const alignedSumUuid = Object.values(alignedSum.results || {})[0]?.UUID;
        const alignedSumObject = await this.addMeasurementApi(alignedSumUuid);
        await alignedSumObject.setTitle(sumTitle);
      }
      const shiftDelay = shiftDelayMs / 1000;
      return { shiftDelay, isBInverted };
    } catch (error) {
      throw new Error(error.message, { cause: error });
    }
  }

  async findAligmentNew(
    channelA,
    channelB,
    frequency,
    maxSearchRange = 2,
    createSum = false,
    sumTitle = null,
    minSearchRange = -0.5
  ) {
    if (createSum && !sumTitle) {
      throw new Error('sumTitle is required when createSum is true');
    }

    try {
      // one octave below frequency
      const lowFrequency = frequency / 2;

      // one octave above frequency
      const highFrequency = frequency * 2;

      const optimizerConfig = {
        frequency: {
          min: lowFrequency, // Hz
          max: highFrequency, // Hz
        },
        gain: {
          min: 0, // dB
          max: 0, // dB
          step: 0.1, // dB
        },
        delay: {
          min: -maxSearchRange / 1000, // 0.5ms
          max: -minSearchRange / 1000, // 2ms
          step: 0.00001, // 0.01ms
        },
      };

      const channelAFrequencyResponse = await channelA.getFrequencyResponse();
      channelAFrequencyResponse.measurement = channelA.uuid;
      const channelBFrequencyResponse = await channelB.getFrequencyResponse();
      channelBFrequencyResponse.measurement = channelB.uuid;

      const frequencyResponses = [channelAFrequencyResponse, channelBFrequencyResponse];

      const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig);
      const optimizerResults = await optimizer.optimizeSubwoofers();

      const optimizedResults = optimizerResults.optimizedSubs[0].param;
      if (!optimizedResults) {
        throw new Error('No results found');
      }

      const isBInverted = optimizedResults.polarity === -1 ? true : false;
      const shiftDelay = -optimizedResults.delay;

      if (createSum) {
        const bestSumFullRange = await optimizer.getFinalSubSum();
        // await this.sendToREW(optimizerResults.bestSum, sumTitle + 'New');
        // await this.sendToREW(optimizerResults.optimizedSubs[0], sumTitle + 'New');
        await this.sendToREW(bestSumFullRange, sumTitle + 'N');
      }

      return { shiftDelay, isBInverted };
    } catch (error) {
      throw new Error(error.message, { cause: error });
    }
  }

  restore() {
    const data = store.load();
    if (data) {
      // Transform data using the MeasurementItem class
      const enhancedMeasurements = Object.values(data.measurements).map(
        item => new MeasurementItem(item, this)
      );
      this.measurements(enhancedMeasurements);
      // this.mergeMeasurements(data.measurements);
      this.selectedSpeaker(data.selectedSpeaker);
      this.targetCurve = data.targetCurve;
      this.rewVersion = data.rewVersion;
      this.selectedLfeFrequency(data.selectedLfeFrequency);
      this.selectedAlignFrequency(data.selectedAlignFrequency);
      this.selectedAverageMethod(data.selectedAverageMethod);
      this.jsonAvrData(data.avrFileContent);
      this.lpfForLFE(data.selectedAlignFrequency);
      this.OCAFileGenerator = data.avrFileContent
        ? new OCAFileGenerator(data.avrFileContent)
        : null;
    }
  }

  saveMeasurements() {
    // Save to persistent store
    const reducedMeasurements = this.measurements().map(item => item.toJSON());
    const data = {
      measurements: reducedMeasurements,
      selectedSpeaker: this.selectedSpeaker(),
      targetCurve: this.targetCurve,
      rewVersion: this.rewVersion,
      selectedLfeFrequency: this.selectedLfeFrequency(),
      selectedAlignFrequency: this.selectedAlignFrequency(),
      selectedAverageMethod: this.selectedAverageMethod(),
      ...(this.OCAFileGenerator && {
        avrFileContent: this.OCAFileGenerator.avrFileContent,
      }),
    };
    // Convert observables to plain objects
    // const plainData = ko.toJS(data);
    store.save(data);
  }

  async startBackgroundPolling() {
    if (this.isPolling()) return;
    if (this.isProcessing()) return;
    if (this.isLoading()) return;
    if (this.hasError()) return;

    try {
      // Initial load
      await this.apiService.initializeAPI();
      this.rewVersion = await this.apiService.checkVersion();
      this.targetCurve = await this.apiService.checkTargetCurve();
      await this.loadData();
      this.isPolling(true);

      // Set up regular polling
      this.pollerId = setInterval(async () => {
        if (this.isPolling()) {
          if (this.isProcessing()) return;
          if (this.isLoading()) return;
          if (this.hasError()) return;
          try {
            await this.loadData();
          } catch (error) {
            this.handleError(`Background poll failed: ${error.message}`);
          }
        }
      }, this.pollingInterval);
    } catch (error) {
      this.handleError(`Failed to start background polling: ${error.message}`);
      this.stopBackgroundPolling();
    }
  }

  stopBackgroundPolling() {
    this.isPolling(false);
    if (this.pollerId) {
      clearInterval(this.pollerId);
      this.pollerId = null;
    }
  }

  toggleBackgroundPolling() {
    if (this.isPolling()) {
      this.stopBackgroundPolling();
    } else {
      this.startBackgroundPolling();
    }
  }
}

export default MeasurementViewModel;
