import MeasurementItem from './MeasurementItem.js';
import PersistentStore from './PersistentStore.js';
import BusinessTools from './BusinessTools.js';
import OCAFileGenerator from './oca-file.js';
import translations from './translations.js';
import AdyTools from './ady-tools.js';
import MqxTools from './mqx-tools.js';
import MultiSubOptimizer from './multi-sub-optimizer.js';
import AvrCaracteristics from './avr-caracteristics.js';

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

    // Observable for selected speaker
    self.selectedSpeaker = ko.observable('');

    // Observable for target curve
    self.targetCurve = 'unknown';
    self.rewVersion = '';

    // Observable for the selected value
    self.selectedLfeFrequency = ko.observable('250');

    // Array of frequency options
    self.LfeFrequencies = [
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
      { value: 'Magn plus phase average', text: 'RMS + phase avg.' },
      { value: 'dB plus phase average', text: 'dB + phase avg.' },
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

    self.additionalBassGainValue = ko.observable(0);
    self.minadditionalBassGainValue = -6;
    self.maxadditionalBassGainValue = 6;
    self.maxBoostIndividualValue = ko.observable(0);
    self.minIndividualValue = 0;
    self.maxIndividualValue = 6;
    self.maxBoostOverallValue = ko.observable(0);
    self.minOverallValue = 0;
    self.maxOverallValue = 3;
    self.loadedFileName = '';

    self.validateFile = function (file) {
      const maxSize = 70 * 1024 * 1024; // 70MB

      if (
        !file.name.endsWith('.avr') &&
        !file.name.endsWith('.ady') &&
        !file.name.endsWith('.mqx')
      ) {
        self.handleError('Please select a .avr or .ady file');
        return false;
      }
      if (file.size > maxSize) {
        self.handleError('File size exceeds 50MB limit');
        return false;
      }

      return true;
    };

    self.onFileLoaded = async function (data, filename) {
      // clear error and load data to prevent buggy behavior
      self.error('');
      self.loadData();

      // Handle the loaded JSON data
      self.status('Loaded file: ' + filename);

      try {
        if (filename.endsWith('.mqx')) {
          if (!self.jsonAvrData()) {
            throw new Error('Please load AVR data first');
          }
          const mqxTools = new MqxTools(data, self.jsonAvrData());
          await mqxTools.parse();
          data = mqxTools.jsonAvrData;
        }

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
          throw new Error('No channels detected');
        }

        // convert directionnal bass to standard
        data.detectedChannels = data.detectedChannels.map(channel => ({
          ...channel,
          enChannelType:
            StandardChannelMapping[channel.enChannelType] || channel.enChannelType,
        }));

        // new alignments method set impulse response to 0ms
        if (!filename.endsWith('.avr')) {
          self.DEFAULT_SHIFT_IN_METERS = 0;
        }

        const avr = new AvrCaracteristics(data.targetModelName, data.enMultEQType);
        data.avr = avr.toJSON();

        // Check if we have any measurements meaning we have a ady file
        if (data.detectedChannels?.[0].responseData?.[0]) {
          // create zip containing all measurements
          const hasCirrusLogicDsp = data.avr.hasCirrusLogicDsp;
          const needCal = hasCirrusLogicDsp || filename.endsWith('.mqx');
          const adyTools = new AdyTools(data);
          const zipContent = await adyTools.parseContent(needCal);

          if (filename.endsWith('.ady')) {
            adyTools.isDirectionalWhenMultiSubs();
          }

          // TODO: ampassign can be directionnal must be converted to standard
          if (self.isPolling()) {
            const orderedImpulses = adyTools.impulses.sort((a, b) =>
              a.name.localeCompare(b.name)
            );
            for (const processedResponse of orderedImpulses) {
              const identifier = processedResponse.name;
              const response = processedResponse.data;
              const max = Math.max(...response.map(x => Math.abs(x)));
              const lastMeasurementIndex = self.measurements().length;
              const encodedData = MeasurementItem.encodeRewToBase64(response);

              if (!encodedData) {
                throw new Error('Error encoding array');
              }
              const options = {
                identifier: identifier,
                startTime: 0,
                sampleRate: adyTools.samplingRate,
                splOffset: AdyTools.SPL_OFFSET,
                applyCal: false,
                data: encodedData,
              };
              await self.apiService.postSafe('import/impulse-response-data', options);

              const item = await self.apiService.fetchREW(
                lastMeasurementIndex + 1,
                'GET',
                null,
                0
              );
              const measurementItem = new MeasurementItem(item, self);
              measurementItem.IRPeakValue = max;
              await self.addMeasurement(measurementItem);
              if (max >= 1) {
                console.warn(
                  `${identifier} IR is above 1(${max.toFixed(2)}), please check your measurements`
                );
              }
            }
          }

          // Create download buttons
          const button = document.createElement('button');
          button.textContent = `Download measurements zip`;
          button.onclick = () => saveAs(zipContent, `${data.title}.zip`);
          results.appendChild(button);
        }
      } catch (error) {
        self.handleError(error.message);
      } finally {
        // Clean up response data regardless of file type
        if (data?.detectedChannels && Array.isArray(data.detectedChannels)) {
          for (const channel of data.detectedChannels) {
            channel.responseData = {};
          }
          self.jsonAvrData(data);
        }
      }
    };

    // Handle file reading
    self.readFile = async function (file) {
      if (self.isProcessing()) return;

      try {
        await self.isProcessing(true);

        if (!file) {
          throw new Error('No file selected');
        }

        if (!self.validateFile(file)) {
          throw new Error('File validation failed');
        }

        let fileContent = await new Promise((resolve, reject) => {
          const reader = new FileReader();

          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Error reading file'));

          reader.readAsText(file);
        });

        // if mqx file contain garbage after closing json, truncate after the closing brake corresponding to the fisrt open bracket
        if (file.name.endsWith('.mqx')) {
          fileContent = self.cleanJSON(fileContent);
        }

        const data = JSON.parse(fileContent);
        self.loadedFileName = file.name;
        // Handle successful load
        await self.onFileLoaded(data, file.name);
      } catch (error) {
        self.handleError(`Error parsing file: ${error.message}`, error);
      } finally {
        self.isProcessing(false);
      }
    };

    self.cleanJSON = function (fileContent) {
      // Early return if the input is empty or not a string
      if (!fileContent || typeof fileContent !== 'string') {
        throw new Error('Invalid input: fileContent must be a non-empty string');
      }

      const firstOpen = fileContent.indexOf('{');
      if (firstOpen === -1) {
        throw new Error('Invalid file format: no JSON object found');
      }

      let openCount = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = firstOpen; i < fileContent.length; i++) {
        const char = fileContent[i];

        // Handle string literals
        if (char === '"' && !escapeNext) {
          inString = !inString;
          continue;
        }

        // Handle escape characters
        if (char === '\\' && !escapeNext) {
          escapeNext = true;
          continue;
        }
        escapeNext = false;

        // Only count braces when not in a string
        if (!inString) {
          if (char === '{') {
            openCount++;
          } else if (char === '}') {
            openCount--;
            if (openCount === 0) {
              return fileContent.slice(firstOpen, i + 1);
            }
          }
        }
      }

      throw new Error('Invalid JSON structure: unmatched braces');
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

    self.DeleteOriginalForAverage = ko.observable('all');

    self.useAllPassFiltersForSubs = ko.observable(false);

    self.DeleteOriginalForLfeRevert = ko.observable(true);

    self.isProcessing = ko.observable(false);

    self.isProcessing.subscribe(async function (newValue) {
      try {
        if (newValue === false) {
          // Save to persistent storage first
          self.saveMeasurements();

          if (self.isPolling() && self.inhibitGraphUpdates) {
            await self.apiService.updateAPI('inhibit-graph-updates', false);
            // await self.apiService.updateAPI('blocking', false);
          }
        } else if (newValue === true) {
          self.error('');
          if (self.isPolling() && self.inhibitGraphUpdates) {
            await self.apiService.updateAPI('inhibit-graph-updates', true);
            // await self.apiService.updateAPI('blocking', true);
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
          if (item.isAverage) {
            continue;
          }

          if (item.isUnknownChannel) {
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

    self.buttonResetApplication = async function () {
      if (self.isProcessing()) return;
      try {
        self.status('Reseting...');

        self.stopBackgroundPolling();

        store.clear();

        // Reset all application state
        self.measurements([]);
        self.jsonAvrData(null);

        self.targetCurve = '';
        self.rewVersion = '';
        self.additionalBassGainValue(0);
        self.maxBoostIndividualValue(0);
        self.maxBoostOverallValue(0);
        self.loadedFileName = '';

        // Reset selectors to default values
        self.selectedSpeaker('');
        self.selectedLfeFrequency('250');
        self.selectedAlignFrequency(0);
        self.selectedAverageMethod('');
        self.selectedMeasurementsFilter(true);

        self.status(`${self.status()}\nReset successful`);
      } catch (error) {
        self.handleError(`Reset failed: ${error.message}`, error);
      }
    };

    self.buttoncreatesAverages = async function () {
      if (self.isProcessing()) return;
      try {
        if (!self.isPolling()) {
          throw new Error('Please connect to REW before creating averages');
        }
        self.isProcessing(true);
        self.status('Average calculation started...');

        // Get valid measurements to average
        const filteredMeasurements = self
          .measurements()
          .filter(
            item =>
              !item.isAverage &&
              !item.isPredicted &&
              !item.isUnknownChannel &&
              item.position() !== 0 &&
              item.IRPeakValue <= 1
          );

        // Check if we have enough measurements
        if (filteredMeasurements.length < 2) {
          throw new Error('Need at least 2 valid measurements to calculate average');
        }

        const allOffset = filteredMeasurements.map(item => ({
          title: item.displayMeasurementTitle(),
          alignOffset: item.alignSPLOffsetdB().toFixed(2),
          offset: item.splOffsetdB().toFixed(2),
        }));
        const uniqueAlignOffsets = new Set(allOffset.map(x => x.alignOffset));
        if (uniqueAlignOffsets.size !== 1) {
          const measurementsWithOffsets = allOffset
            .filter(x => x.alignOffset !== '0.00')
            .map(x => `${x.title}: ${x.alignOffset}dB`)
            .join(', ');
          throw new Error(
            `Some measurements have inconsistent SPL alignment offsets: ${measurementsWithOffsets}`
          );
        }

        const uniqueOffsets = new Set(allOffset.map(x => x.offset));
        if (uniqueOffsets.size !== 1) {
          const firstMeasurementOffset = allOffset[0].offset;
          const measurementsWithOffsets = allOffset
            .filter(x => x.offset !== firstMeasurementOffset)
            .map(x => `${x.title}: ${x.offset}dB`)
            .join(', ');
          throw new Error(
            `Inconsistent SPL offsets detected in measurements: ${measurementsWithOffsets} expected ${firstMeasurementOffset}dB`
          );
        }

        // creates array of uuid attributes for each code into groupedResponse
        await self.businessTools.processGroupedResponses(
          self.groupedMeasurements(),
          self.selectedAverageMethod(),
          self.DeleteOriginalForAverage()
        );
        const averagePosition = self
          .measurementsPositionList()
          .find(pos => pos.text === 'Average');
        self.currentSelectedPosition(averagePosition.value);
        self.status('Average calculations completed successfully');
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
          self.DeleteOriginalForLfeRevert()
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

        // target level must be correct to ensure accurate predicted measurements
        await self.setTargetLevelToAll();

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

        for (const measurement of self.uniqueSpeakersMeasurements()) {
          await measurement.setZeroAtIrPeak();
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
        await self.loadData();
        const workingMeasurements = self.uniqueSpeakersMeasurements();
        if (workingMeasurements.length === 0) {
          throw new Error('No measurements found for SPL alignment');
        }
        const workingMeasurementsUuids = workingMeasurements.map(m => m.uuid);
        const firstMeasurement = workingMeasurements[0];
        const previousTargetcurveTitle = `Target ${firstMeasurement.title()}`;

        let alignSplOptions;
        if (workingMeasurementsUuids.length === 1) {
          alignSplOptions = {
            frequencyHz: 2500,
            spanOctaves: 5,
            targetdB: self.DEFAULT_TARGET_LEVEL,
          };
        } else {
          alignSplOptions = {
            frequencyHz: 2500,
            spanOctaves: 5,
            targetdB: 'average',
          };
        }

        // delete previous target curve
        const previousTargetcurve = self
          .measurements()
          .filter(item => item.title() === previousTargetcurveTitle);
        for (const item of previousTargetcurve) {
          await self.removeMeasurement(item);
        }

        await firstMeasurement.resetTargetSettings();
        for (const work of workingMeasurements) {
          await work.applyWorkingSettings();
        }

        await self.processCommands('Smooth', workingMeasurementsUuids, {
          smoothing: '1/1',
        });

        const alignResult = await self.processCommands(
          'Align SPL',
          [...workingMeasurementsUuids],
          alignSplOptions
        );

        // must be calculated before removing working settings
        await firstMeasurement.eqCommands('Calculate target level');
        await firstMeasurement.eqCommands('Generate target measurement');

        // set target level to all measurements including subs
        await self.setTargetLevelToAll();

        // update attribute for all measurements processed to be able to be used in copySplOffsetDeltadBToOther
        for (const work of workingMeasurements) {
          const alignOffset = MeasurementItem.getAlignSPLOffsetdBByUUID(
            alignResult,
            work.uuid
          );
          work.splOffsetdB(work.splOffsetdBUnaligned() + alignOffset);
          work.alignSPLOffsetdB(alignOffset);
          await work.removeWorkingSettings();
        }

        // copy SPL alignment level to other measurements positions
        for (const measurement of self.uniqueMeasurements()) {
          await measurement.copySplOffsetDeltadBToOther();
        }

        // ajust subwoofer levels
        await self.adjustSubwooferSPLLevels(self, self.uniqueSubsMeasurements());

        const subsMeasurementsUuids = self.uniqueSubsMeasurements().map(m => m.uuid);

        if (subsMeasurementsUuids.length !== 0) {
          await self.processCommands('Smooth', subsMeasurementsUuids, {
            smoothing: 'Psy',
          });
        }

        self.status(`${self.status()} \nSPL alignment successful `);
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

        if (!speakerItem) {
          throw new Error(`Speaker not found`);
        }
        // TODO: check if speaker filter is created

        // set at crossover frequency
        self.selectedAlignFrequency(speakerItem.crossover());

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

        self.lpfForLFE(Math.max(120, self.selectedAlignFrequency()));

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
    self.lpfForLFE = ko.observable(120);

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
        const avrData = self.jsonAvrData();
        if (!avrData || !avrData.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        const OCAFile = new OCAFileGenerator(avrData);

        self.targetCurve = await self.apiService.checkTargetCurve();
        OCAFile.tcName = `${self.targetCurve} ${await self.mainTargetLevel()}dB`;
        OCAFile.softRoll = self.softRoll();
        OCAFile.enableDynamicEq = self.enableDynamicEq();
        OCAFile.dynamicEqRefLevel = self.dynamicEqRefLevel();
        OCAFile.enableDynamicVolume = self.enableDynamicVolume();
        OCAFile.dynamicVolumeSetting = self.dynamicVolumeSetting();
        OCAFile.enableLowFrequencyContainment = self.enableLowFrequencyContainment();
        OCAFile.lowFrequencyContainmentLevel = self.lowFrequencyContainmentLevel();
        OCAFile.subwooferOutput = self.subwooferOutput();
        OCAFile.lpfForLFE = self.lpfForLFE();
        OCAFile.numberOfSubwoofers = self.uniqueSubsMeasurements().length;
        OCAFile.versionEvo = 'Sangoku_custom';

        const jsonData = await OCAFile.createOCAFile(self.uniqueMeasurements());

        // Validate input
        if (!jsonData) {
          throw new Error('No data to save');
        }

        // Create timestamp
        const timestamp = new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-');
        const model = OCAFile.model.replaceAll(' ', '-');
        const filename = `${timestamp}_${self.targetCurve}_${model}.oca`;

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

    self.buttoncreateSetting = async function () {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('text generation...');

        const avrData = self.jsonAvrData();
        if (!avrData || !avrData.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        self.targetCurve = await self.apiService.checkTargetCurve();
        self.rewVersion = await this.apiService.checkVersion();
        const selectedSpeakerText =
          self.findMeasurementByUuid(self.selectedSpeaker())?.displayMeasurementTitle() ||
          'None';

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
        textData += `Loaded File:       ${self.loadedFileName}\n`;
        textData += `Target Curve:      ${self.targetCurve}\n`;
        textData += `Target Level:      ${await self.mainTargetLevel()} dB\n`;
        textData += `Average Method:    ${self.selectedAverageMethod()}\n`;
        textData += `REW Version:       ${self.rewVersion}\n\n`;

        // AVR Info section
        textData += `AVR INFORMATION\n`;
        textData += `--------------\n`;
        textData += `Model:                ${avrData.targetModelName}\n`;
        textData += `MultEQ Type:          ${avrData.avr.multEQDescription}\n`;
        textData += `Has Cirrus Logic DSP: ${avrData.hasCirrusLogicDsp ? 'Yes' : 'No'}\n`;
        textData += `Speed of Sound:       ${avrData.avr.speedOfSound} m/s\n\n`;

        // Subwoofer settings section
        textData += `SUBWOOFER SETTINGS\n`;
        textData += `------------------\n`;
        textData += `Number of Subs:           ${self.uniqueSubsMeasurements().length}\n`;
        textData += `Revert LFE Filter Freq:   ${self.selectedLfeFrequency()} Hz\n`;

        textData += `Additional Bass Gain:     ${self.additionalBassGainValue()} dB\n`;
        textData += `Max Boost Individual:     ${self.maxBoostIndividualValue()} dB\n`;
        textData += `Max Boost Overall:        ${self.maxBoostOverallValue()} dB\n`;

        textData += `Align Frequency:          ${self.selectedAlignFrequency()} Hz\n`;
        textData += `Selected Speaker:         ${selectedSpeakerText}\n`;

        textData += `LPF for LFE:              ${self.lpfForLFE()} Hz\n`;
        textData += `Subwoofer Output:         ${self.subwooferOutput()}\n\n`;

        // Dynamic settings section
        textData += `DYNAMIC SETTINGS\n`;
        textData += `----------------\n`;
        textData += `Dynamic EQ:        ${self.enableDynamicEq() ? 'Enabled' : 'Disabled'}\n`;
        if (self.enableDynamicEq()) {
          textData += `  Reference Level:  ${self.dynamicEqRefLevel()} dB\n`;
        }
        textData += `Dynamic Volume:    ${self.enableDynamicVolume() ? 'Enabled' : 'Disabled'}\n`;
        if (self.enableDynamicVolume()) {
          textData += `  Volume Setting:   ${self.dynamicVolumeSetting()}\n`;
        }
        textData += `LF Containment:    ${self.enableLowFrequencyContainment() ? 'Enabled' : 'Disabled'}\n`;
        if (self.enableLowFrequencyContainment()) {
          textData += `  LFC Level:        ${self.lowFrequencyContainmentLevel()}\n`;
        }
        textData += `Version:           Sangoku_custom\n\n`;

        // Save to persistent store
        const reducedMeasurements = self.uniqueMeasurements().map(item => item.toJSON());

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
          const distance = String(measurement.distance.toFixed(2)).padStart(8);
          const splOffset = String(measurement.splForAvr).padStart(11);
          const crossover = String(measurement.crossover).padStart(19);
          const inverted = String(measurement.inverted ? 'Yes' : '').padEnd(8);

          textData += `| ${title} | ${channel} | ${distance} | ${splOffset} | ${crossover} | ${inverted} |\n`;
        }

        // Add table footer
        textData +=
          '+------------------------+---------------+----------+-------------+---------------------+----------+\n';

        // Create timestamp
        const timestamp = new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-');
        const model = avrData.targetModelName.replaceAll(' ', '-');
        const filename = `${timestamp}_${self.targetCurve}_${model}.txt`;

        // Create blob
        const blob = new Blob([textData], {
          type: 'application/text',
        });

        // Save file
        saveAs(blob, filename);

        self.status('Settings file created successfully');
      } catch (error) {
        self.handleError(`Settings file failed: ${error.message}`, error);
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
        const zipFilename = `MSO-${self.jsonAvrData().model}.zip`;
        const minFreq = 5; // minimum frequency in Hz
        const maxFreq = 400; // maximum frequency in Hz

        // Helper function to process chunks of measurements
        async function processMeasurementChunk(measurements) {
          return Promise.all(
            measurements.map(async measurement => {
              await measurement.resetAll();
              const frequencyResponse = await measurement.getFrequencyResponse();
              const subName = measurement.channelName().replace('SW', 'SUB');
              const localFilename = `POS${measurement.position()}-${subName}.txt`;

              const filecontent = frequencyResponse.freqs.reduce((acc, freq, i) => {
                if (freq >= minFreq && freq <= maxFreq) {
                  const line = `${freq.toFixed(6)} ${frequencyResponse.magnitude[i].toFixed(3)} ${frequencyResponse.phase[i].toFixed(4)}`;
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

    self.buttonChooseSubOptimizer = async function () {
      if (self.uniqueSubsMeasurements().length === 0) {
        self.handleError('No subwoofers found');
        return;
      }
      if (self.uniqueSubsMeasurements().length === 1) {
        self.buttonSingleSubOptimizer(self.uniqueSubsMeasurements()[0]);
      }
      if (self.uniqueSubsMeasurements().length > 1) {
        self.buttonMultiSubOptimizer();
      }
    };

    self.buttonSingleSubOptimizer = async function (subMeasurement) {
      if (self.isProcessing()) return;
      try {
        self.isProcessing(true);
        self.status('Sub Optimizer...');

        const { lowFrequency, highFrequency, targetLevelAtFreq } =
          await self.adjustSubwooferSPLLevels(self, [subMeasurement]);

        self.status(
          `${self.status()} \nCreating EQ filters for sub ${lowFrequency}Hz - ${highFrequency}Hz`
        );

        await self.apiService.postSafe(`eq/match-target-settings`, {
          startFrequency: lowFrequency,
          endFrequency: highFrequency,
          individualMaxBoostdB: self.maxBoostIndividualValue(),
          overallMaxBoostdB: self.maxBoostOverallValue(),
          flatnessTargetdB: 1,
          allowNarrowFiltersBelow200Hz: false,
          varyQAbove200Hz: false,
          allowLowShelf: false,
          allowHighShelf: false,
        });

        await subMeasurement.eqCommands('Match target');
        await subMeasurement.copyFiltersToOther();

        const isFiltersOk = await subMeasurement.checkFilterGain();
        if (isFiltersOk !== 'OK') {
          throw new Error(isFiltersOk);
        }
      } catch (error) {
        self.handleError(`Sub Optimizer failed: ${error.message}`, error);
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
        const firstMeasurementLevel = await self.mainTargetLevel();
        const frequencyResponses = [];
        const { lowFrequency, highFrequency, targetLevelAtFreq } =
          await self.adjustSubwooferSPLLevels(self, subsMeasurements);

        // set the same delay for all subwoofers
        await self.setSameDelayToAll(subsMeasurements);

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
            min: -0.002, // 2ms
            max: 0.002, // 2ms
            step: self.jsonAvrData().avr.minDistAccuracy || 0.00001, // 0.01ms
          },
          allPass: {
            enabled: self.useAllPassFiltersForSubs(),
            frequency: {
              min: 10, // Hz
              max: 500, // Hz
              step: 10, // Hz
            },
            q: {
              min: 0.1,
              max: 0.5,
              step: 0.1,
            },
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
          .filter(item => item.title().startsWith(maximisedSumTitle));
        for (const item of previousMaxSum) {
          await item.delete();
        }

        for (const measurement of subsMeasurements) {
          await measurement.setInverted(false);
          // why is this needed?
          await measurement.resetFilters();
          const frequencyResponse = await measurement.getFrequencyResponse();
          frequencyResponse.measurement = measurement.uuid;
          frequencyResponse.name = measurement.displayMeasurementTitle();
          frequencyResponse.position = measurement.position();
          frequencyResponses.push(frequencyResponse);
        }

        self.status(`${self.status()} \nSarting lookup...`);
        const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig);
        const optimizerResults = optimizer.optimizeSubwoofers();

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
        }

        self.status(`${self.status()} \n${optimizer.logText}`);

        self.status(`${self.status()} \nCreates sub sumation`);
        // DEBUG use REW api way to generate the sum for compare
        // const maximisedSum = await self.produceSumProcess(self, subsMeasurements);

        const optimizedSubsSum = optimizer.getFinalSubSum();

        const targetData = await subsMeasurements[0].getTargetResponse('SPL', 12);
        const measurementLowCutoff = MeasurementItem.findCutoff(
          true,
          targetData,
          optimizedSubsSum,
          -2
        );
        const measurementHighCutoff = MeasurementItem.findCutoff(
          false,
          targetData,
          optimizedSubsSum,
          0
        );

        const maximisedSum = await self.sendToREW(optimizedSubsSum, maximisedSumTitle);

        await self.sendToREW(
          optimizer.theoreticalMaxResponse,
          maximisedSumTitle + ' Theo'
        );
        // DEBUG to check it this is the same
        // await self.sendToREW(optimizerResults.bestSum, 'test');

        self.status(
          `${self.status()} \nCreating EQ filters for sub sumation ${measurementLowCutoff}Hz - ${measurementHighCutoff}Hz`
        );

        await self.apiService.postSafe(`eq/match-target-settings`, {
          startFrequency: measurementLowCutoff,
          endFrequency: measurementHighCutoff,
          individualMaxBoostdB: self.maxBoostIndividualValue(),
          overallMaxBoostdB: self.maxBoostOverallValue(),
          flatnessTargetdB: 1,
          allowNarrowFiltersBelow200Hz: false,
          varyQAbove200Hz: false,
          allowLowShelf: false,
          allowHighShelf: false,
        });

        // reserve filter emplacement 20 for all pass
        if (optimizerConfig.allPass.enabled) {
          const maximisedSumFilter = {
            index: 20,
            enabled: true,
            isAuto: false,
            type: 'None',
          };
          await maximisedSum.setSingleFilter(maximisedSumFilter);
        }

        await maximisedSum.setTargetLevel(firstMeasurementLevel);
        await maximisedSum.resetTargetSettings();
        await maximisedSum.eqCommands('Match target');

        const filters = await maximisedSum.getFilters();

        //await self.removeMeasurement(maximisedSum);

        self.status(`${self.status()} \nApply calculated filters to each sub`);

        for (const sub of subsMeasurements) {
          // find the optimized sub for this measurement
          const optimizedSub = optimizedSubs.find(
            optimizedSub => optimizedSub.measurement === sub.uuid
          );

          let subFilters = [...filters];

          // allpass settings
          if (optimizedSub?.param.allPass.enabled) {
            const allPassFilter = {
              index: 20,
              enabled: true,
              isAuto: false,
              frequency: optimizedSub.param.allPass.frequency,
              q: optimizedSub.param.allPass.q,
              type: 'All pass',
            };

            // find index of filter with index = 20
            const index = subFilters.findIndex(filter => filter.index === 20);
            // replace filter with index = 20
            if (index === -1) {
              throw new Error(`Filter not found for index 20`);
            } else {
              subFilters[index] = allPassFilter;
            }
          }
          await sub.setFilters(subFilters);
          await sub.copyFiltersToOther();
          await sub.copyCumulativeIRShiftToOther();
          await sub.copySplOffsetDeltadBToOther();
        }

        const isFiltersOk = await maximisedSum.checkFilterGain();
        if (isFiltersOk !== 'OK') {
          throw new Error(isFiltersOk);
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
    self.subsMeasurements = ko.computed(() =>
      self.measurements().filter(item => item.isSub())
    );

    self.validMeasurements = ko.computed(() =>
      self.measurements().filter(item => item.isValid)
    );

    self.groupedMeasurements = ko.computed(() => {
      // group data by channelName attribute and set isSelected to true for the first occurrence
      return self.measurements().reduce((acc, item) => {
        const channelName = item.channelName();

        if (item.isUnknownChannel) {
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
        const allMeasurementPositions = self
          .measurements()
          .map(item => item.position())
          .filter(Boolean);

        const uniquePositions = [...new Set(allMeasurementPositions)];

        const positionsSet = uniquePositions
          .map(pos => {
            const item = self.measurements().find(m => m.position() === pos);
            return { value: pos, text: item.displayPositionText() };
          })
          .sort((a, b) => a.text.localeCompare(b.text));

        return positionsSet;
      } catch (error) {
        self.handleError('Error computing measurements position list:', error);
        return [];
      }
    });

    // Filtered measurements
    self.uniqueMeasurements = ko.computed(() => {
      const measurements = self.measurements();
      // Early return for empty collection
      if (!measurements || measurements.length === 0) {
        return [];
      }
      return measurements.filter(item => item.isSelected());
    }, self);

    // Filtered measurements
    self.notUniqueMeasurements = ko.computed(() => {
      const measurements = self.measurements();
      // Early return for empty collection
      if (!measurements || measurements.length === 0) {
        return [];
      }
      return measurements.filter(item => !item.isSelected());
    }, self);

    // Filtered measurements
    self.uniqueMeasurementsView = ko.computed(() => {
      if (self.selectedMeasurementsFilter()) {
        return self.uniqueMeasurements();
      }
      return self.measurements();
    });

    self.minDistanceInMeters = ko.computed(() =>
      Math.min(...self.uniqueMeasurements().map(item => item.distanceInMeters()))
    );

    self.maxDistanceInMetersWarning = ko
      .computed(() => {
        const minDistance = self.minDistanceInMeters() || 0; // Fallback to 0 if undefined
        const limit = MeasurementItem.MODEL_DISTANCE_LIMIT;

        // Ensure we're working with numbers
        return Number(minDistance) + Number(limit);
      })
      .extend({ pure: true }); // Only updates when dependencies actually change

    self.maxDistanceInMetersError = ko
      .computed(() => {
        const minDistance = self.minDistanceInMeters();
        const criticalLimit = MeasurementItem.MODEL_DISTANCE_CRITICAL_LIMIT;

        return Number(minDistance) + criticalLimit;
      })
      .extend({ pure: true }); // Ensures updates only occur when dependencies change

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

  async setSameDelayToAll(measurements) {
    if (measurements.length <= 1) {
      return;
    }
    const firstMeasurement = measurements[0];
    // align the others sub to first measurement delay
    const mainDelay = firstMeasurement.cumulativeIRShiftSeconds();
    for (const measurement of measurements) {
      await measurement.setcumulativeIRShiftSeconds(mainDelay);
    }
  }

  async adjustSubwooferSPLLevels(self, subsMeasurements) {
    if (subsMeasurements.length === 0) {
      return;
    }

    const minFrequency = 10;
    const maxFrequency = 19990;

    const firstMeasurement = subsMeasurements[0];

    // Find the level of target curve at 40Hz
    const targetLevelAtFreq = await self.getTargetLevelAtFreq(40, firstMeasurement);

    // adjut target level according to the number of subs
    const numbersOfSubs = subsMeasurements.length;
    const overhead = 10 * Math.log10(numbersOfSubs);
    const targetLevel =
      targetLevelAtFreq - overhead + Number(self.additionalBassGainValue());

    let lowFrequency = Infinity;
    let highFrequency = 0;

    for (const measurement of subsMeasurements) {
      await measurement.resetSmoothing();
      await measurement.resetTargetSettings();

      const frequencyResponse = await measurement.getFrequencyResponse('SPL', '1/2', 6);
      frequencyResponse.measurement = measurement.uuid;
      frequencyResponse.name = measurement.displayMeasurementTitle();
      frequencyResponse.position = measurement.position();
      const detect = self.detectSubwooferCutoff(
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

      let logMessage = `\nAdjust ${measurement.displayMeasurementTitle()} SPL levels to ${targetLevel.toFixed(1)}dB`;
      logMessage += `(center: ${detect.centerFrequency}Hz, ${detect.octaves} octaves, ${detect.lowCutoff}Hz - ${detect.highCutoff}Hz)`;

      const alignResult = await self.processCommands('Align SPL', [measurement.uuid], {
        frequencyHz: detect.centerFrequency,
        spanOctaves: detect.octaves,
        targetdB: targetLevel,
      });

      const alignOffset = MeasurementItem.getAlignSPLOffsetdBByUUID(
        alignResult,
        measurement.uuid
      );

      logMessage += ` => ${alignOffset}dB`;
      self.status(`${self.status()} ${logMessage}`);

      measurement.splOffsetdB(measurement.splOffsetdBUnaligned() + alignOffset);
      measurement.alignSPLOffsetdB(alignOffset);
      await measurement.copySplOffsetDeltadBToOther();
    }

    if (lowFrequency < minFrequency) {
      lowFrequency = minFrequency;
    }
    if (highFrequency > maxFrequency) {
      highFrequency = maxFrequency;
    }

    return { lowFrequency, highFrequency, targetLevelAtFreq };
  }

  async getTargetLevelAtFreq(targetFreq = 40, measurement) {
    // Input validation
    if (!Number.isFinite(targetFreq) || targetFreq <= 0) {
      throw new Error('Target frequency must be a positive number');
    }

    if (!measurement) {
      measurement = this.uniqueMeasurements()[0];
    }

    if (!measurement) {
      throw new Error('No measurements available');
    }

    // Find the level of target curve at 40Hz

    const targetCurveResponse = await measurement.getTargetResponse('SPL', 6);
    if (!targetCurveResponse) {
      throw new Error('Failed to get target curve response');
    }

    const freqIndex = targetCurveResponse.freqs.reduce((closestIdx, curr, idx) => {
      const closestFreq = targetCurveResponse.freqs[closestIdx];
      return Math.abs(curr - targetFreq) < Math.abs(closestFreq - targetFreq)
        ? idx
        : closestIdx;
    }, 0);
    return targetCurveResponse.magnitude[freqIndex];
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
  detectSubwooferCutoff(
    fullFrequencies,
    fullMagnitude,
    thresholdDb = -6,
    low = 10,
    high = 500
  ) {
    // Input validation
    if (
      !fullFrequencies?.length ||
      !fullMagnitude?.length ||
      fullFrequencies.length !== fullMagnitude.length
    ) {
      throw new Error('Invalid input arrays');
    }

    if (thresholdDb >= 0) {
      throw new Error('Threshold must be negative');
    }

    // Create new arrays to store filtered values
    const frequencies = [];
    const magnitude = [];

    // Iterate through frequencies and keep only those within range
    fullFrequencies.forEach((freq, index) => {
      if (freq >= low && freq <= high) {
        frequencies.push(freq);
        magnitude.push(fullMagnitude[index]);
      }
    });

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
    const factor = Math.pow(10, precision);
    return Math.round(number * factor) / factor;
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

      const optimizer = new MultiSubOptimizer(frequencyResponses);
      const optimizedSubsSum = optimizer.calculateCombinedResponse(frequencyResponses);
      const data = optimizer.displayResponse(optimizedSubsSum);

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
      const item = await this.apiService.fetchREW(itemUuid, 'GET', null, 0);
      // Transform data using the MeasurementItem class
      const measurementItem = new MeasurementItem(item, this);
      await this.addMeasurement(measurementItem);
      return measurementItem;
    } catch (error) {
      this.handleError(`Failed to add measurement: ${error.message}`, error);
      return false;
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
      } else {
        this.measurements.push(item);
        console.debug(`measurement ${item.title()} added`);
      }
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
        // TODO: REW bug ? return code 200 instead of 202 and no results in the response
        if (!operationResult.results) {
          throw new Error(
            `Missing result from API response: ${JSON.stringify(operationResult)}`
          );
        }
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
          min: -maxSearchRange / 1000,
          max: -minSearchRange / 1000,
          step: 0.00001, // 0.01ms
        },
      };

      const channelAFrequencyResponse = await channelA.getFrequencyResponse();
      channelAFrequencyResponse.measurement = channelA.uuid;
      const channelBFrequencyResponse = await channelB.getFrequencyResponse();
      channelBFrequencyResponse.measurement = channelB.uuid;

      const frequencyResponses = [channelAFrequencyResponse, channelBFrequencyResponse];

      const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig);
      const optimizerResults = optimizer.optimizeSubwoofers();

      const optimizedResults = optimizerResults.optimizedSubs[0].param;
      if (!optimizedResults) {
        throw new Error('No results found');
      }

      const isBInverted = optimizedResults.polarity === -1 ? true : false;
      const shiftDelay = -optimizedResults.delay;

      if (createSum) {
        const bestSumFullRange = optimizer.getFinalSubSum();
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
      if (data.avrFileContent) {
      // avrFileContent must be loaded before measurements as they needs the informations
      this.jsonAvrData(data.avrFileContent);
      // Transform data using the MeasurementItem class
      const enhancedMeasurements = Object.values(data.measurements).map(
        item => new MeasurementItem(item, this)
      );
      this.measurements(enhancedMeasurements);
      }
      this.selectedSpeaker(data.selectedSpeaker);
      this.targetCurve = data.targetCurve;
      this.rewVersion = data.rewVersion;
      this.selectedLfeFrequency(data.selectedLfeFrequency);
      this.selectedAlignFrequency(data.selectedAlignFrequency);
      this.selectedAverageMethod(data.selectedAverageMethod);
      this.additionalBassGainValue(data.additionalBassGainValue || 0);
      this.maxBoostIndividualValue(data.maxBoostIndividualValue || 0);
      this.maxBoostOverallValue(data.maxBoostOverallValue || 0);
      this.loadedFileName = data.loadedFileName || '';
      data.isPolling ? this.startBackgroundPolling() : this.stopBackgroundPolling();
      this.DEFAULT_SHIFT_IN_METERS = data.defaultShift || 3;
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
      additionalBassGainValue: this.additionalBassGainValue(),
      maxBoostIndividualValue: this.maxBoostIndividualValue(),
      maxBoostOverallValue: this.maxBoostOverallValue(),
      avrFileContent: this.jsonAvrData(),
      loadedFileName: this.loadedFileName,
      isPolling: this.isPolling(),
      defaultShift: this.DEFAULT_SHIFT_IN_METERS,
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
