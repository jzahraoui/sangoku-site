import RewApi from './rew-api.js';
import MeasurementItem from './MeasurementItem.js';
import PersistentStore from './PersistentStore.js';
import BusinessTools from './BusinessTools.js';
import OCAFileGenerator from './oca-file.js';
import translations from './translations.js';
import AdyTools from './ady-tools.js';
import MqxTools from './mqx-tools.js';
import MultiSubOptimizer from './multi-sub-optimizer.js';
import AvrCaracteristics from './avr-caracteristics.js';
import ko from 'knockout';
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import ampAssignType from './amp-type.js';
import { CHANNEL_TYPES } from './audyssey.js';

const store = new PersistentStore('myAppData');

class MeasurementViewModel {
  static DEFAULT_TARGET_LEVEL = 75;
  static DEFAULT_SHIFT_IN_METERS = 3;
  static maximisedSumTitle = 'LFE Max Sum';

  blocking = false;
  pollingInterval = 1000; // 1 seconds

  constructor() {
    this.inhibitGraphUpdates = ko.observable(true);
    this.isPolling = ko.observable(false);
    this.pollerId = null;
    // Add translation support
    this.translations = ko.observable(
      translations[localStorage.getItem('userLanguage') || 'en']
    );

    this.ocaFileFormat = ko.observable('odd');
    this.avrIpAddress = ko.observable('');

    // retreive version from index.html
    this.currentVersion = document
      .querySelector('footer .version')
      .textContent.replace('Version ', '');

    // API Service
    this.apiBaseUrl = ko.observable('http://localhost:4735');
    this.apiService = new RewApi(
      this.apiBaseUrl(),
      this.inhibitGraphUpdates(),
      this.blocking
    );

    this.businessTools = new BusinessTools(this);

    // Observables
    this.measurements = ko.observableArray([]);
    this.isLoading = ko.observable(false);
    this.error = ko.observable('');
    this.status = ko.observable('');
    this.selectedItem = ko.observable(null);
    this.upperFrequencyBound = ko.observable(16000);
    this.lowerFrequencyBound = ko.observable(15);

    // Computed
    this.hasStatus = ko.computed(() => !this.error() && this.status() !== '');
    this.hasError = ko.computed(() => this.error() !== '');
    this.hasItems = ko.computed(() => this.measurements().length > 0);

    this.appendStatus = msg => this.status(`${this.status()}\n${msg}`);

    this.handleError = (message, error) => {
      console.error(message, error);
      this.error(message);
      this.status('');
      this.apiService.clearCommands();
    };

    // Observable for selected speaker
    this.selectedSpeaker = ko.observable('');

    // Observable for target curve
    this.targetCurve = ko.observable('None');
    this.rewVersion = ko.observable('');

    // Observable for the selected value
    this.selectedLfeFrequency = ko.observable('250');

    // Observable for the selected value
    this.gobalCrossover = ko.observable();

    // Filter observables
    this.selectedMeasurementsFilter = ko.observable(true);

    // Available filter options
    this.selectedMeasurements = [
      { value: true, text: 'Selected' },
      { value: false, text: 'All' },
    ];

    this.selectedAverageMethod = ko.observable('');

    // Array of frequency options
    this.averageMethod = [
      { value: 'Vector average', text: 'Vector average' },
      { value: 'Magn plus phase average', text: 'RMS + phase avg.' },
      { value: 'dB plus phase average', text: 'dB + phase avg.' },
    ];

    // Array of smoothing options
    this.smoothingChoices = [
      { value: '1/1', text: '1/1 Octave' },
      { value: '1/2', text: '1/2 Octave' },
      { value: '1/3', text: '1/3 Octave' },
      { value: '1/6', text: '1/6 Octave' },
      { value: '1/12', text: '1/12 Octave' },
      { value: '1/24', text: '1/24 Octave' },
      { value: '1/48', text: '1/48 Octave' },
      { value: 'Var', text: 'Variable' },
      { value: 'Psy', text: 'Psychoacoustic' },
      { value: 'ERB', text: 'ERB' },
      { value: 'None', text: 'None' },
    ];

    this.selectedSmoothingMethod = ko.observable('None');

    this.irWindowsChoices = [
      {
        value: 'None',
        text: 'None',
        config: {
          leftWindowType: 'Rectangular',
          rightWindowType: 'Rectangular',
          leftWindowWidthms: MeasurementItem.leftWindowWidthMilliseconds,
          rightWindowWidthms: MeasurementItem.rightWindowWidthMilliseconds,
          addFDW: false,
          addMTW: false,
        },
      },
      {
        value: 'Optimized MTW',
        text: 'Optimized MTW',
        config: {
          leftWindowType: 'Rectangular',
          rightWindowType: 'Rectangular',
          leftWindowWidthms: MeasurementItem.leftWindowWidthMilliseconds,
          rightWindowWidthms: MeasurementItem.rightWindowWidthMilliseconds,
          addFDW: false,
          addMTW: true,
          mtwTimesms: [9000, 3000, 450, 120, 30, 7.7, 2.6, 0.9, 0.4, 0.15],
        },
      },
    ];

    this.selectedIrWindows = ko.observable('Optimized MTW');

    // get seletced IR window config
    this.selectedIrWindowsConfig = ko.computed(() => {
      const selected = this.selectedIrWindows();
      const found = this.irWindowsChoices.find(choice => choice.value === selected);
      return found ? found.config : null;
    });

    // Subscribe to changes in global crossover
    this.gobalCrossover.subscribe(newValue => {
      if (newValue === undefined) return;
      for (const group of Object.values(this.measurementsByGroup())) {
        if (!group.isSub) {
          group.crossover(newValue);
        }
      }
    });

    // Observable to track drag state
    this.isDragging = ko.observable(false);

    // Observable array to store JSON data
    this.jsonAvrData = ko.observable();

    // Array of frequency options with fallback values
    this.alingFrequencies = ko.computed(() => {
      const indexes = this.jsonAvrData()?.avr?.frequencyIndexes;
      return indexes || AvrCaracteristics.DEFAULT_FREQUENCIES;
    });

    this.LfeFrequencies = ko.computed(() => {
      const freqs = this.jsonAvrData()?.avr?.lfeFrequencies;
      return freqs || AvrCaracteristics.DEFAULT_LFE_FREQUENCIES;
    });

    // subwoofer filter options
    this.additionalBassGainValue = ko.observable(0);
    this.minadditionalBassGainValue = -12;
    this.maxadditionalBassGainValue = 12;
    this.maxBoostIndividualValue = ko.observable(0);
    this.minIndividualValue = 0;
    this.maxIndividualValue = 6;
    this.maxBoostOverallValue = ko.observable(0);
    this.minOverallValue = 0;
    this.maxOverallValue = 3;
    this.loadedFileName = ko.observable('');
    this.shiftInMeters = ko.computed(() =>
      this.loadedFileName().endsWith('.avr')
        ? MeasurementViewModel.DEFAULT_SHIFT_IN_METERS
        : 0
    );
    this.distanceUnit = ko.observable('M');

    // speaker filter options
    this.individualMaxBoostValue = ko.observable(3);
    this.individualMaxBoostValueMin = 0;
    this.individualMaxBoostValueMax = 6;
    this.overallBoostValue = ko.observable(3);
    this.overallBoostValueMin = 0;
    this.overallBoostValueMax = 6;

    this.measurementsByGroup = ko.computed(() => {
      if (!this.jsonAvrData()?.detectedChannels) return {};

      const groupMap = {};
      for (const item of this.jsonAvrData().detectedChannels) {
        const group = CHANNEL_TYPES.getGroupByChannelIndex(item.enChannelType);
        if (group === null) {
          throw new Error(
            `Unknown channel type: ${item.commandId} (id:${item.enChannelType})`
          );
        }
        if (!groupMap[group]) {
          const isSub = group === 'Subwoofer';
          const crossover = ko.observable(
            isSub ? 0 : MeasurementItem.DEFAULT_CROSSOVER_VALUE
          );
          groupMap[group] = {
            crossover,
            isSub,
            speakerType: ko.computed(() => {
              if (isSub) return 'E';
              return crossover() === 0 ? 'L' : 'S';
            }),
          };
        }
      }
      return groupMap;
    });

    this.validateFile = file => {
      const MAX_SIZE = 70 * 1024 * 1024;
      const VALID_EXTENSIONS = ['.avr', '.ady', '.mqx'];

      const hasValidExtension = VALID_EXTENSIONS.some(ext => file.name.endsWith(ext));
      if (!hasValidExtension) {
        this.handleError('Please select a .avr, .ady, or .mqx file');
        return false;
      }

      if (file.size > MAX_SIZE) {
        this.handleError('File size exceeds 70MB limit');
        return false;
      }

      return true;
    };

    this.processMqxFile = async data => {
      if (!this.jsonAvrData()) {
        throw new Error('Please load AVR data first');
      }
      const mqxTools = new MqxTools(data, this.jsonAvrData());
      await mqxTools.parse();
      return mqxTools.jsonAvrData;
    };

    this.normalizeChannelMapping = data => {
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

      // convert directionnal bass to standard
      data.detectedChannels = data.detectedChannels.map(channel => ({
        ...channel,
        enChannelType:
          StandardChannelMapping[channel.enChannelType] || channel.enChannelType,
      }));
    };

    this.processImpulseResponse = async (processedResponse, adyTools) => {
      const identifier = processedResponse.name;
      const response = processedResponse.data;
      const max = Math.max(...response.map(x => Math.abs(x)));
      const lastMeasurementIndex = this.measurements().length;
      const encodedData = MeasurementItem.encodeRewToBase64(response);

      if (!encodedData) {
        throw new Error('Error encoding array');
      }
      const options = {
        identifier,
        startTime: 0,
        sampleRate: adyTools.samplingRate,
        splOffset: this.jsonAvrData().avr?.splOffset ?? 80,
        applyCal: false,
        data: encodedData,
      };
      await this.apiService.postSafe('import/impulse-response-data', options);

      const item = await this.apiService.fetchREW(
        lastMeasurementIndex + 1,
        'GET',
        null,
        0
      );
      const measurementItem = await this.addMeasurementApi(item.uuid);
      measurementItem.IRPeakValue = max;
      if (max >= 1) {
        console.warn(
          `${identifier} IR is above 1(${max.toFixed(2)}), please check your measurements`
        );
      }
    };

    this.processAdyMeasurements = async (data, filename, adyTools, zipContent) => {
      if (filename.endsWith('.ady')) {
        adyTools.isDirectionalWhenMultiSubs();
      }

      // TODO: ampassign can be directionnal must be converted to standard
      if (this.isPolling()) {
        adyTools.impulses.sort((a, b) => a.name.localeCompare(b.name));
        for (const processedResponse of adyTools.impulses) {
          await this.processImpulseResponse(processedResponse, adyTools);
        }
      }

      const results = document.getElementById('resultsAvr');

      // Create download buttons
      const button = document.createElement('button');
      button.textContent = `Download measurements zip`;
      button.onclick = () => saveAs(zipContent, `${data.title}.zip`);
      results.appendChild(button);
    };

    this.onFileLoaded = async (data, filename) => {
      // clear error and load data to prevent buggy behavior
      this.error('');
      this.loadData();
      this.status('Loaded file: ' + filename);

      try {
        if (filename.endsWith('.mqx')) {
          data = await this.processMqxFile(data, filename);
        }

        const results = document.getElementById('resultsAvr');
        if (!results) {
          throw new Error('Results element not found');
        }
        results.innerHTML = '';

        if (!data.detectedChannels?.[0]) {
          throw new Error('No channels detected');
        }

        this.normalizeChannelMapping(data);

        const avr = new AvrCaracteristics(data.targetModelName, data.enMultEQType);
        data.avr = avr.toJSON();
        if (avr.hasCirrusLogicDsp) {
          this.ocaFileFormat('a1');
        } else {
          this.ocaFileFormat('odd');
        }

        // load data to prevent bug when avr data is not loaded
        this.jsonAvrData(data);

        // Check if we have any measurements meaning we have a ady file
        if (data.detectedChannels?.[0].responseData?.[0]) {
          const hasCirrusLogicDsp = data.avr.hasCirrusLogicDsp;
          const needCal = hasCirrusLogicDsp || filename.endsWith('.mqx');
          const adyTools = new AdyTools(data);
          // create zip containing all measurements
          const zipContent = await adyTools.parseContent(needCal);
          await this.processAdyMeasurements(data, filename, adyTools, zipContent);
        }
      } catch (error) {
        throw new Error(`File processing failed: ${error.message}`);
      } finally {
        // Clean up response data regardless of file type
        if (data?.detectedChannels && Array.isArray(data.detectedChannels)) {
          for (const channel of data.detectedChannels) {
            channel.responseData = {};
          }
          this.jsonAvrData(data);
        }
      }
    };

    // Handle file reading
    this.readFile = async file => {
      if (this.isProcessing()) return;

      try {
        await this.isProcessing(true);

        if (!file) {
          throw new Error('No file selected');
        }

        if (!this.validateFile(file)) {
          throw new Error('File validation failed');
        }

        let fileContent = await file.text();

        // if mqx file contain garbage after closing json, truncate after the closing brake corresponding to the fisrt open bracket
        if (file.name.endsWith('.mqx')) {
          fileContent = this.cleanJSON(fileContent);
        }

        const data = JSON.parse(fileContent);
        this.loadedFileName(file.name);
        // Handle successful load
        await this.onFileLoaded(data, file.name);
      } catch (error) {
        this.handleError(`Error parsing file: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.cleanJSON = fileContent => {
      // Early return if the input is empty or not a string
      if (!fileContent || typeof fileContent !== 'string') {
        throw new Error('Invalid input: fileContent must be a non-empty string');
      }

      const firstOpen = fileContent.indexOf('{');
      if (firstOpen === -1) {
        throw new Error('Invalid file format: no JSON object found');
      }

      const closingIndex = this.findClosingBrace(fileContent, firstOpen);
      if (closingIndex === -1) {
        throw new Error('Invalid JSON structure: unmatched braces');
      }

      return fileContent.slice(firstOpen, closingIndex + 1);
    };

    this.findClosingBrace = (content, startIndex) => {
      let openCount = 0;
      let inString = false;
      let escapeNext = false;

      for (let i = startIndex; i < content.length; i++) {
        const char = content[i];

        if (char === '"' && !escapeNext) {
          inString = !inString;
        } else if (char === '\\' && !escapeNext) {
          escapeNext = true;
          continue;
        } else if (!inString) {
          if (char === '{') openCount++;
          else if (char === '}' && --openCount === 0) return i;
        }
        escapeNext = false;
      }

      return -1;
    };

    // Drop handlers
    this.handleDrop = (_, e) => {
      e.preventDefault();
      this.isDragging(false);

      const file = e.dataTransfer.files[0];
      this.readFile(file);
    };

    this.handleDragOver = (_, e) => {
      e.preventDefault();
    };

    this.handleDragEnter = (_, e) => {
      e.preventDefault();
      this.isDragging(true);
    };

    this.handleDragLeave = (_, e) => {
      e.preventDefault();
      this.isDragging(false);
    };

    // File input handler
    this.handleFileSelect = (_, e) => {
      const file = e.target.files[0];
      this.readFile(file);
    };

    this.DeleteOriginalForAverage = ko.observable('all');

    this.useAllPassFiltersForSubs = ko.observable(false);

    this.DeleteOriginalForLfeRevert = ko.observable(true);

    this.isProcessing = ko.observable(false);

    this.isProcessing.subscribe(async newValue => {
      // inhibit Graph Updates only during processing
      if (this.isPolling() && this.inhibitGraphUpdates()) {
        await this.apiService.setInhibitGraphUpdates(newValue);
      }
      // Save to persistent when processing ends
      if (!newValue) {
        this.saveMeasurements();
      }
    });

    this.currentSelectedPosition = ko.observable();

    this.importMsoConfigInRew = async REWconfigs => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Importing MSO config...');

        for (const [position, subResponses] of Object.entries(
          this.byPositionsGroupedSubsMeasurements()
        )) {
          if (!subResponses?.length) continue;

          const subResponsesTitles = subResponses.map(response =>
            response.displayMeasurementTitle()
          );
          this.appendStatus(
            `Importing to position: ${position}\n${subResponsesTitles.join('\r\n')}`
          );

          await this.businessTools.importFilterInREW(REWconfigs, subResponses);
          this.appendStatus(`REW import successful for position: ${position}`);
        }

        this.appendStatus(`Importing finished`);
      } catch (error) {
        this.handleError(`REW import failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonDownloadAvr = async () => {
      if (this.isProcessing()) return;
      try {
        // TODO
        if (!this.jsonAvrData()) {
          throw new Error('please load file before');
        }
        if (this.avrIpAddress().trim() === '') {
          throw new Error('please enter AVR IP address');
        }
        if (!RewApi.isValidIpAddress(this.avrIpAddress().trim())) {
          throw new Error('please enter a valid AVR IP address');
        }
        // create new jsonAvrData by copy some jsonAvrData attributes
        const newAvrData = {
          targetModelName: this.jsonAvrData().targetModelName,
          ipAddress: this.avrIpAddress().trim(),
          enMultEQType: this.jsonAvrData().enMultEQType,
          subwooferNum: this.jsonAvrData().subwooferNum,
          ampAssign: ampAssignType.getByIndex(this.jsonAvrData().enAmpAssignType),
          ampAssignInfo: this.jsonAvrData().ampAssignInfo,
          detectedChannels: this.jsonAvrData().detectedChannels.map(channel => ({
            commandId: channel.commandId,
          })),
        };

        // download new file receiver_config.avr with newAvrData content
        const blob = new Blob([JSON.stringify(newAvrData, null, 2)], {
          type: 'application/json',
        });
        saveAs(blob, 'receiver_config.avr');
        this.status('Download successful');
      } catch (error) {
        this.handleError(`.avr file failed: ${error.message}`, error);
      }
    };

    this.refreshTargetCurve = async () => {
      if (this.isProcessing()) return;
      try {
        this.targetCurve(await this.apiService.checkTargetCurve());
      } catch (error) {
        this.handleError(`Refresh target curve failed: ${error.message}`, error);
      }
    };

    this.buttoncheckREWButton = async () => {
      if (this.isProcessing()) return;
      try {
        this.error('');
        this.toggleBackgroundPolling();
      } catch (error) {
        this.handleError(`Pulling failed: ${error.message}`, error);
      }
    };

    this.renameMeasurement = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Renaming started');
        for (const item of this.measurements()) {
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

          const newName = `${item.channelName()}_P${item
            .position()
            .toString()
            .padStart(2, '0')}`;

          item.setTitle(newName);
        }
        this.status('Renaming succeful');
      } catch (error) {
        this.handleError(`Rename failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonresetREWButton = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);

        this.status('Reseting...');

        this.appendStatus('Set Generic EQ');
        await this.apiService.postSafe(
          'eq/default-equaliser',
          MeasurementItem.defaulEqtSettings
        );

        this.appendStatus('Clear commands');
        await this.apiService.clearCommands();

        const firstMeasurementLevel = await this.getMainTargetLevel();
        for (const item of this.measurements()) {
          this.appendStatus(`Reseting ${item.displayMeasurementTitle()}`);
          await item.resetAll(firstMeasurementLevel);
        }

        this.appendStatus('Reset successful');
      } catch (error) {
        this.handleError(`Reset failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonResetApplication = async () => {
      if (this.isProcessing()) return;
      try {
        this.status('Reseting...');

        this.stopBackgroundPolling();

        this.error('');

        store.clear();

        // Reset all application state
        this.measurements([]);
        this.jsonAvrData(null);

        this.targetCurve('');
        this.rewVersion('');
        this.additionalBassGainValue(0);
        this.maxBoostIndividualValue(0);
        this.maxBoostOverallValue(0);
        this.loadedFileName('');

        // Reset selectors to default values
        this.selectedSpeaker('');
        this.selectedLfeFrequency('250');
        this.selectedAverageMethod('');
        this.selectedMeasurementsFilter(true);

        this.appendStatus(`Reset successful`);
      } catch (error) {
        this.handleError(`Reset failed: ${error.message}`, error);
      }
    };

    this.buttoncreatesAverages = async () => {
      if (this.isProcessing()) return;
      try {
        if (!this.isPolling()) {
          throw new Error('Please connect to REW before creating averages');
        }
        this.isProcessing(true);
        this.status('Average calculation started...');

        // Get valid measurements to average
        const filteredMeasurements = this.measurements().filter(
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
        await this.businessTools.processGroupedResponses(
          this.groupedMeasurements(),
          this.selectedAverageMethod(),
          this.DeleteOriginalForAverage()
        );
        const averagePosition = this.measurementsPositionList().find(
          pos => pos.text === 'Average'
        );
        this.currentSelectedPosition(averagePosition.value);
        this.status('Average calculations completed successfully');
      } catch (error) {
        this.handleError(`Averages failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonrevertLfeFilter = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Reverting LFE filter...');

        await this.businessTools.revertLfeFilterProccess(
          this.selectedLfeFrequency(),
          this.DeleteOriginalForLfeRevert(),
          true
        );

        this.status('LFE filter reverted successfully');
      } catch (error) {
        this.handleError(`Reverting LFE filter failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonAlignPeaks = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Align peaks...');

        for (const measurement of this.uniqueSpeakersMeasurements()) {
          await measurement.setZeroAtIrPeak();
          // apply SPLoffset to other measurement positions
          await measurement.copyCumulativeIRShiftToOther();
        }

        if (this.uniqueSubsMeasurements().length > 0) {
          const sub = this.uniqueSubsMeasurements()[0];
          await sub.setZeroAtIrPeak();
          await this.setSameDelayToAll(this.uniqueSubsMeasurements());
          for (const measurement of this.uniqueSubsMeasurements()) {
            await measurement.copyCumulativeIRShiftToOther();
          }
        }

        this.status('Align peaks successful');
      } catch (error) {
        this.handleError(`Sum failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonAlignSPL = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Computing SPL alignment...');
        await this.loadData();
        const workingMeasurements = this.uniqueSpeakersMeasurements();
        if (workingMeasurements.length === 0) {
          throw new Error('No measurements found for SPL alignment');
        } else if (workingMeasurements.length === 1) {
          throw new Error('Only one measurement found for SPL alignment');
        }
        const workingMeasurementsUuids = workingMeasurements.map(m => m.uuid);
        const firstWorkingMeasurement = workingMeasurements[0];

        await firstWorkingMeasurement.resetTargetSettings();
        // working settings must match filter settings
        for (const work of workingMeasurements) {
          await work.resetIrWindows();
          await work.genericCommand('Smooth', { smoothing: '1/1' });
        }

        const alignResult = await this.processCommands(
          'Align SPL',
          [...workingMeasurementsUuids],
          {
            frequencyHz: 2500,
            spanOctaves: 5,
            targetdB: 'average',
          }
        );

        // must be calculated before removing working settings
        await firstWorkingMeasurement.setTargetSettings({
          shape: 'Bass limited',
          bassManagementSlopedBPerOctave: 48,
          bassManagementCutoffHz: 800,
        });
        // TODO check target level calculation sometime is too high
        await firstWorkingMeasurement.eqCommands('Calculate target level');
        await firstWorkingMeasurement.resetTargetSettings();

        // working settings must match filter settings
        for (const work of workingMeasurements) {
          await work.applyWorkingSettings();
        }

        // set target level to all measurements including subs
        await firstWorkingMeasurement.copyTargetLevelToAll();

        // update attribute for all measurements processed to be able to be used in copySplOffsetDeltadBToOther
        for (const work of workingMeasurements) {
          const alignOffset = MeasurementItem.getAlignSPLOffsetdBByUUID(
            alignResult,
            work.uuid
          );
          work.splOffsetdB(work.splOffsetdBUnaligned() + alignOffset);
          work.alignSPLOffsetdB(alignOffset);
        }

        // copy SPL alignment level to other measurements positions
        for (const measurement of this.uniqueMeasurements()) {
          await measurement.copySplOffsetDeltadBToOther();
        }

        // ajust subwoofer levels
        await this.adjustSubwooferSPLLevels(this.uniqueSubsMeasurements());

        const subsMeasurementsUuids = this.uniqueSubsMeasurements().map(m => m.uuid);

        if (subsMeasurementsUuids.length !== 0) {
          await this.processCommands('Smooth', subsMeasurementsUuids, {
            smoothing: this.selectedSmoothingMethod(),
          });
        }

        this.appendStatus(`SPL alignment successful `);
      } catch (error) {
        this.handleError(`SPL alignment: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonproduceSubSum = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Computing sum...');

        // Ensure accurate predicted measurements with correct target level
        await this.firstMeasurement().copyTargetLevelToAll();

        // Process each position's subwoofer measurements
        const positionGroups = this.byPositionsGroupedSubsMeasurements();
        for (const [position, subResponses] of Object.entries(positionGroups)) {
          this.appendStatus(`Processing position ${position}`);

          // Handle based on number of subwoofers
          if (subResponses.length === 0) continue;

          // Multiple subwoofers case - produce sum
          await this.produceSumProcess(subResponses);
        }
      } catch (error) {
        this.handleError(`Sum failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonproduceAlignedButton = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Searching for alignement...');

        await this.loadData();

        const selectedLfe = this.predictedLfeMeasurement();

        if (!selectedLfe) {
          throw new Error(`No LFE found, please use sum subs button`);
        }
        const speakerItem = this.findMeasurementByUuid(this.selectedSpeaker());

        if (!speakerItem) {
          throw new Error(`Speaker not found`);
        }

        const result = await this.businessTools.produceAligned(
          selectedLfe,
          speakerItem.crossover(),
          speakerItem,
          this.uniqueSubsMeasurements()
        );

        if (!result) {
          throw new Error('Alignement search failed, no result found');
        }

        // copy cumulative IR shift to other positions
        for (const sub of this.uniqueSubsMeasurements()) {
          // copy to other positions
          await sub.copyCumulativeIRShiftToOther();
        }

        for (const predictedLfe of this.allPredictedLfeMeasurement()) {
          // skip selected lfe
          if (predictedLfe.uuid === selectedLfe.uuid) continue;
          await predictedLfe.setcumulativeIRShiftSeconds(
            selectedLfe.cumulativeIRShiftSeconds()
          );
          await predictedLfe.setInverted(selectedLfe.inverted());
        }

        this.lpfForLFE(Math.max(120, speakerItem.crossover()));

        this.status(result);
      } catch (error) {
        this.handleError(`Alignement search failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttongenratesPreview = async () => {
      for (const item of this.uniqueSpeakersMeasurements()) {
        // display progression in the status
        this.appendStatus(`Generating preview for ${item.displayMeasurementTitle()}`);
        await item.previewMeasurement();
      }

      this.appendStatus(`Preview generated successfully`);
    };

    this.buttongeneratesFilters = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);

        for (const item of this.uniqueSpeakersMeasurements()) {
          // display progression in the status
          this.appendStatus(`Generating filter for channel ${item.channelName()}`);
          await item.createStandardFilter();
        }

        this.appendStatus(`Filters generated successfully`);
      } catch (error) {
        this.handleError(`Filter generation failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.softRoll = ko.observable(false);
    this.enableDynamicEq = ko.observable(false);
    this.dynamicEqRefLevel = ko.observable(0);
    this.enableDynamicVolume = ko.observable(false);
    this.dynamicVolumeSetting = ko.observable(0);
    this.enableLowFrequencyContainment = ko.observable(false);
    this.lowFrequencyContainmentLevel = ko.observable(3);
    this.subwooferOutput = ko.observable('LFE');
    this.lpfForLFE = ko.observable(120);

    // Available filter options
    this.subwooferOutputChoice = [
      { value: 'LFE', text: 'LFE' },
      { value: 'L+M', text: 'L+M' },
    ];

    this.buttoncreateOCAButton = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('OCA file generation...');
        const measurementsinError = this.uniqueMeasurements().filter(item =>
          item.hasErrors()
        );

        if (measurementsinError.length > 0) {
          console.warn(
            `There are ${measurementsinError.length} measurements with errors. Please fix them before generating the OCA file.`
          );
        }
        const avrData = this.jsonAvrData();
        if (!avrData?.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        const OCAFile = new OCAFileGenerator(avrData);

        await this.refreshTargetCurve();
        if (!this.targetCurve()) {
          throw new Error(
            `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`
          );
        }
        OCAFile.fileFormat = this.ocaFileFormat();
        OCAFile.tcName = this.tcName();
        OCAFile.softRoll = this.softRoll();
        OCAFile.enableDynamicEq = this.enableDynamicEq();
        OCAFile.dynamicEqRefLevel = this.dynamicEqRefLevel();
        OCAFile.enableDynamicVolume = this.enableDynamicVolume();
        OCAFile.dynamicVolumeSetting = this.dynamicVolumeSetting();
        OCAFile.enableLowFrequencyContainment = this.enableLowFrequencyContainment();
        OCAFile.lowFrequencyContainmentLevel = this.lowFrequencyContainmentLevel();
        OCAFile.subwooferOutput = this.subwooferOutput();
        OCAFile.lpfForLFE = this.lpfForLFE();
        OCAFile.numberOfSubwoofers = this.uniqueSubsMeasurements().length;
        OCAFile.versionEvo = `RCH ${this.currentVersion}`;

        const jsonData = await OCAFile.createOCAFile(this.uniqueMeasurements());

        // Validate input
        if (!jsonData) {
          throw new Error('No data to save');
        }

        const timestamp = new Date()
          .toISOString()
          .slice(0, 16)
          .replace('T', '-')
          .replaceAll(':', '-');
        const model = avrData.targetModelName.replaceAll(' ', '-');
        const filename = `${timestamp}_${this.ocaFileFormat()}_${this.targetCurve()}_${model}.oca`;

        // Create blob
        const blob = new Blob([jsonData], {
          type: 'application/json',
        });

        // Save file
        saveAs(blob, filename);

        this.status('OCA file created successfully');
      } catch (error) {
        this.handleError(`OCA file failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttoncreateSetting = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('text generation...');

        const avrData = this.jsonAvrData();
        if (!avrData?.targetModelName) {
          throw new Error(`Please load avr file first`);
        }
        await this.refreshTargetCurve();
        if (!this.targetCurve()) {
          throw new Error(
            `Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"`
          );
        }
        const selectedSpeaker = this.findMeasurementByUuid(this.selectedSpeaker());
        const selectedSpeakerText = selectedSpeaker?.displayMeasurementTitle() || 'None';
        const selectedSpeakerCrossover = selectedSpeaker?.crossover();
        // find if we have revert LFE frequency
        const subWithFreq = this.uniqueSubsMeasurements().find(
          item => item.revertLfeFrequency !== 0
        );
        const revertLfeFrequency = subWithFreq?.revertLfeFrequency;

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
        textData += `Loaded File:       ${this.loadedFileName()}\n`;
        textData += `Target Curve:      ${this.targetCurve()}\n`;
        textData += `Target Level:      ${this.mainTargetLevel()} dB\n`;
        textData += `Average Method:    ${this.selectedAverageMethod()}\n\n`;

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
        textData += `Smoothing Method:         ${this.selectedSmoothingMethod()}\n`;
        textData += `Windowing:                ${this.selectedIrWindows()}\n`;
        textData += `Individual Max Boost:     ${this.individualMaxBoostValue()} dB\n`;
        textData += `Overall Max Boost:        ${this.overallBoostValue()} dB\n\n`;

        // Subwoofer settings section
        textData += `SUBWOOFER SETTINGS\n`;
        textData += `------------------\n`;
        textData += `Number of Subs:           ${this.uniqueSubsMeasurements().length}\n`;
        textData += `Revert LFE Filter Freq:   ${addHzSuffix(revertLfeFrequency)}\n`;

        textData += `Additional Bass Gain:     ${this.additionalBassGainValue()} dB\n`;
        textData += `Max Boost Individual:     ${this.maxBoostIndividualValue()} dB\n`;
        textData += `Max Boost Overall:        ${this.maxBoostOverallValue()} dB\n`;

        textData += `Align Frequency:          ${addHzSuffix(
          selectedSpeakerCrossover
        )}\n`;
        textData += `Selected Speaker:         ${selectedSpeakerText}\n`;

        textData += `LPF for LFE:              ${this.lpfForLFE()} Hz\n`;
        textData += `Subwoofer Output:         ${this.subwooferOutput()}\n\n`;

        // Dynamic settings section
        textData += `DYNAMIC SETTINGS\n`;
        textData += `----------------\n`;
        textData += `Dynamic EQ:        ${
          this.enableDynamicEq() ? 'Enabled' : 'Disabled'
        }\n`;
        if (this.enableDynamicEq()) {
          textData += `  Reference Level:  ${this.dynamicEqRefLevel()} dB\n`;
        }
        textData += `Dynamic Volume:    ${
          this.enableDynamicVolume() ? 'Enabled' : 'Disabled'
        }\n`;
        if (this.enableDynamicVolume()) {
          textData += `  Volume Setting:   ${this.dynamicVolumeSetting()}\n`;
        }
        textData += `LF Containment:    ${
          this.enableLowFrequencyContainment() ? 'Enabled' : 'Disabled'
        }\n`;
        if (this.enableLowFrequencyContainment()) {
          textData += `  LFC Level:        ${this.lowFrequencyContainmentLevel()}\n`;
        }
        textData += `\n`;

        // Version information
        textData += `VERSION INFORMATION\n`;
        textData += `-------------------\n`;
        textData += `REW Version:       ${this.rewVersion()}\n`;
        textData += `RCH Version:       ${this.currentVersion}\n\n`;

        // Save to persistent store
        const reducedMeasurements = this.uniqueMeasurements().map(item => item.toJSON());

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
        const timestamp = new Date()
          .toISOString()
          .slice(0, 16)
          .replace('T', '-')
          .replaceAll(':', '-');
        const model = avrData.targetModelName.replaceAll(' ', '-');
        const filename = `${timestamp}_${this.targetCurve()}_${model}.txt`;

        // Create blob
        const blob = new Blob([textData], {
          type: 'application/text',
        });

        // Save file
        saveAs(blob, filename);

        this.status('Settings file created successfully');
      } catch (error) {
        this.handleError(`Settings file failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonCreatesMsoExports = async () => {
      if (this.isProcessing()) return;
      try {
        if (!this.isPolling()) {
          throw new Error('Please start connetion first');
        }

        this.isProcessing(true);
        this.status('Exports Subs...');

        const jszip = new JSZip();
        const zipFilename = `MSO-${this.jsonAvrData().model}.zip`;
        const minFreq = 5; // minimum frequency in Hz
        const maxFreq = 400; // maximum frequency in Hz

        // Helper function to process chunks of measurements
        async function processMeasurementChunk(measurements) {
          for (const measurement of measurements) {
            await measurement.resetAll(this.mainTargetLevel());
            const frequencyResponse = await measurement.getFrequencyResponse();
            await measurement.applyWorkingSettings();
            const subName = measurement.channelName().replace('SW', 'SUB');
            const localFilename = `POS${measurement.position()}-${subName}.txt`;

            const filecontent = frequencyResponse.freqs.reduce((acc, freq, i) => {
              if (freq >= minFreq && freq <= maxFreq) {
                const line = `${freq.toFixed(6)} ${frequencyResponse.magnitude[i].toFixed(
                  3
                )} ${frequencyResponse.phase[i].toFixed(4)}`;
                return acc ? `${acc}\n${line}` : line;
              }
              return acc;
            }, '');

            if (!filecontent) {
              throw new Error(`no file content for ${localFilename}`);
            }

            jszip.file(localFilename, filecontent);
          }
        }

        // Process measurements in chunks of 4
        const measurements = this.subsMeasurements();
        const chunkSize = 5;

        for (let i = 0; i < measurements.length; i += chunkSize) {
          const chunk = measurements.slice(i, i + chunkSize);
          await processMeasurementChunk(chunk);
        }

        // Generate the zip file once and save it
        const zipContent = await jszip.generateAsync({ type: 'blob' });
        saveAs(zipContent, zipFilename);
        this.status('Exports Subs successful');
      } catch (error) {
        this.handleError(`Exports Subs failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonEqualizeSub = async () => {
      if (this.uniqueSubsMeasurements().length === 0) {
        this.handleError('No subwoofers found');
        return;
      }
      if (this.uniqueSubsMeasurements().length === 1) {
        this.buttonSingleSubOptimizer(this.uniqueSubsMeasurements()[0]);
      } else if (this.uniqueSubsMeasurements().length > 1) {
        this.buttonMutipleSubOptimizer();
      }
    };

    this.buttonMutipleSubOptimizer = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Equalize multiple subs...');

        const maximisedSum = this.measurements().find(
          item => item.title() === MeasurementViewModel.maximisedSumTitle
        );

        if (!maximisedSum) {
          this.handleError('No maximised sum found');
          return;
        }
        await this.equalizeSub(maximisedSum);

        const filters = await maximisedSum.getFilters();

        this.appendStatus(`Apply calculated filters to each sub`);

        const subsMeasurements = this.uniqueSubsMeasurements();

        for (const sub of subsMeasurements) {
          // do not overwrite the all pass filter if set
          await sub.setFilters(filters, false);
          await sub.copyFiltersToOther();
          // ensure that cumulative IR shift and inversion is copied to other positions
          await sub.copyCumulativeIRShiftToOther();
        }

        this.appendStatus(`Successful`);
      } catch (error) {
        this.handleError(`Equalize Subs failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.buttonSingleSubOptimizer = async subMeasurement => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Equalize single sub...');

        await this.adjustSubwooferSPLLevels([subMeasurement]);
        await this.equalizeSub(subMeasurement);
        await subMeasurement.copyFiltersToOther();

        this.appendStatus(`Successful`);
      } catch (error) {
        this.handleError(`Equalize Subs failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.createOptimizerConfig = (lowFrequency, highFrequency) => {
      if (!this.jsonAvrData()?.avr) {
        throw new Error('Please load AVR data first');
      }
      return {
        frequency: { min: lowFrequency, max: highFrequency },
        gain: { min: 0, max: 0, step: 0.1 },
        delay: {
          min: -0.002,
          max: 0.002,
          step: this.jsonAvrData().avr.minDistAccuracy || 0.00001,
        },
        allPass: {
          enabled: this.useAllPassFiltersForSubs(),
          frequency: { min: 10, max: 500, step: 10 },
          q: { min: 0.1, max: 0.5, step: 0.1 },
        },
      };
    };

    this.applySubPolarity = async (subMeasurement, polarity) => {
      if (polarity === -1) {
        await subMeasurement.setInverted(true);
      } else if (polarity === 1) {
        await subMeasurement.setInverted(false);
      } else {
        throw new Error(
          `Invalid invert value for ${await subMeasurement.displayMeasurementTitle()}`
        );
      }
    };

    this.applySubAllPassFilter = async (subMeasurement, allPassParam) => {
      const allPassFilter = allPassParam.enabled
        ? {
            index: 20,
            enabled: true,
            isAuto: false,
            frequency: allPassParam.frequency,
            q: allPassParam.q,
            type: 'All pass',
          }
        : { index: 20, enabled: true, isAuto: true, type: 'None' };
      await subMeasurement.setSingleFilter(allPassFilter);
    };

    this.applyOptimizedSubSettings = async sub => {
      const subMeasurement = this.findMeasurementByUuid(sub.measurement);
      if (!subMeasurement) {
        throw new Error(`Measurement not found for ${sub.measurement}`);
      }
      await this.applySubPolarity(subMeasurement, sub.param.polarity);
      await subMeasurement.addIROffsetSeconds(sub.param.delay);
      await subMeasurement.copyCumulativeIRShiftToOther();
      await subMeasurement.addSPLOffsetDB(sub.param.gain);
      await subMeasurement.copySplOffsetDeltadBToOther();
      await this.applySubAllPassFilter(subMeasurement, sub.param.allPass);
    };

    this.buttonMultiSubOptimizer = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('MultiSubOptimizer...');

        await this.loadData();

        const subsMeasurements = this.uniqueSubsMeasurements();

        if (subsMeasurements.length === 0) {
          this.handleError('No subwoofers found');
          return;
        }
        if (subsMeasurements.length === 1) {
          this.handleError(
            'Only one subwoofer found, please use single sub optimizer button'
          );
          return;
        }

        const { lowFrequency, highFrequency } = await this.adjustSubwooferSPLLevels(
          subsMeasurements
        );

        // set the same delay for all subwoofers
        await this.setSameDelayToAll(subsMeasurements);

        const optimizerConfig = this.createOptimizerConfig(lowFrequency, highFrequency);
        this.appendStatus(
          `frequency range: ${optimizerConfig.frequency.min}Hz - ${optimizerConfig.frequency.max}Hz`
        );
        this.appendStatus(
          `delay range: ${optimizerConfig.delay.min * 1000}ms - ${
            optimizerConfig.delay.max * 1000
          }ms`
        );

        this.appendStatus(`Deleting previous settings...`);

        const previousMaxSum = this.measurements().filter(item =>
          item.title().startsWith(MeasurementViewModel.maximisedSumTitle)
        );
        for (const item of previousMaxSum) {
          await item.delete();
        }

        const frequencyResponses = [];
        for (const measurement of subsMeasurements) {
          await measurement.setInverted(false);
          await measurement.applyWorkingSettings();
          const frequencyResponse = await measurement.getFrequencyResponse();
          frequencyResponse.measurement = measurement.uuid;
          frequencyResponse.name = measurement.displayMeasurementTitle();
          frequencyResponse.position = measurement.position();
          frequencyResponses.push(frequencyResponse);
        }

        this.appendStatus(`Sarting lookup...`);
        const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig);
        const optimizerResults = optimizer.optimizeSubwoofers();

        for (const sub of optimizerResults.optimizedSubs) {
          await this.applyOptimizedSubSettings(sub);
        }

        this.appendStatus(`${optimizer.logText}`);

        this.appendStatus(`Creates sub sumation`);
        // DEBUG use REW api way to generate the sum for compare
        // const maximisedSum = await this.produceSumProcess(subsMeasurements);

        const optimizedSubsSum = optimizer.getFinalSubSum();

        const maximisedSum = await this.sendToREW(
          optimizedSubsSum,
          MeasurementViewModel.maximisedSumTitle
        );

        await this.sendToREW(
          optimizer.theoreticalMaxResponse,
          MeasurementViewModel.maximisedSumTitle + ' Theo'
        );
        // DEBUG to check if this is the same
        // await this.sendToREW(optimizerResults.bestSum, 'test');

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

        this.appendStatus(`MultiSubOptimizer successfull`);
      } catch (error) {
        this.handleError(`MultiSubOptimizer failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    this.copyParametersToAllPosition = async () => {
      if (this.isProcessing()) return;
      try {
        this.isProcessing(true);
        this.status('Copy started');
        await this.copyMeasurementCommonAttributes();
        this.status('Copy succeful');
      } catch (error) {
        this.handleError(`Copy failed: ${error.message}`, error);
      } finally {
        this.isProcessing(false);
      }
    };

    // Computed for filtered measurements
    this.subsMeasurements = ko.computed(() =>
      this.measurements().filter(item => item.isSub())
    );

    this.validMeasurements = ko.computed(() =>
      this.measurements().filter(item => item.isValid)
    );

    this.groupedMeasurements = ko.computed(() => {
      // group data by channelName attribute and set isSelected to true for the first occurrence
      return this.measurements().reduce((acc, item) => {
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
    this.byPositionsGroupedSubsMeasurements = ko.computed(() => {
      return this.subsMeasurements().reduce((acc, item) => {
        const key = item.position();
        if (!acc[key]) {
          acc[key] = [];
        }
        acc[key].push(item);
        return acc;
      }, {});
    });

    this.measurementsPositionList = ko.computed(() => {
      try {
        const allMeasurementPositions = this.measurements()
          .map(item => item.position())
          .filter(Boolean);

        const uniquePositions = [...new Set(allMeasurementPositions)];

        const positionsSet = uniquePositions
          .map(pos => {
            const item = this.measurements().find(m => m.position() === pos);
            return { value: pos, text: item.displayPositionText() };
          })
          .sort((a, b) => a.text.localeCompare(b.text));

        return positionsSet;
      } catch (error) {
        this.handleError('Error computing measurements position list:', error);
        return [];
      }
    });

    // Filtered measurements
    this.uniqueMeasurements = ko.computed(() => {
      const measurements = this.measurements();
      // Early return for empty collection
      if (!measurements || measurements.length === 0) {
        return [];
      }
      return measurements.filter(item => item.isSelected());
    }, this);

    // Filtered measurements
    this.notUniqueMeasurements = ko.computed(() => {
      const measurements = this.measurements();
      // Early return for empty collection
      if (!measurements || measurements.length === 0) {
        return [];
      }
      return measurements.filter(item => !item.isSelected());
    }, this);

    // Filtered measurements
    this.uniqueMeasurementsView = ko.computed(() => {
      if (this.selectedMeasurementsFilter()) {
        return this.uniqueMeasurements();
      }
      return this.measurements();
    });

    this.mainTargetLevel = ko.observable(MeasurementViewModel.DEFAULT_TARGET_LEVEL);

    this.tcName = ko.pureComputed(() => {
      return `${this.targetCurve()} ${this.mainTargetLevel()}dB`;
    });

    this.firstMeasurement = ko.pureComputed(() => {
      const measurements = this.uniqueSpeakersMeasurements();
      return measurements.length > 0 ? measurements[0] : null;
    });

    this.minDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueMeasurements().map(item => item.distanceInMeters());
      return distances.length ? Math.min(...distances) : 0;
    });

    this.maxDistanceInMeters = ko.pureComputed(() => {
      const distances = this.uniqueMeasurements().map(item => item.distanceInMeters());
      return distances.length ? Math.max(...distances) : 0;
    });

    this.maxDistanceInMetersWarning = ko.pureComputed(
      () => this.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_LIMIT
    );

    this.maxDistanceInMetersError = ko.pureComputed(
      () => this.minDistanceInMeters() + MeasurementItem.MODEL_DISTANCE_CRITICAL_LIMIT
    );

    this.uniqueSubsMeasurements = ko.computed(() => {
      return this.uniqueMeasurements().filter(item => item.isSub());
    });

    this.predictedLfeMeasurementTitle = ko.computed(() => {
      // Get the unique measurements array
      const uniqueSubs = this.uniqueSubsMeasurements();

      // Early return if no measurements
      if (!uniqueSubs?.length) return undefined;

      const position = this.currentSelectedPosition();
      if (!position) return undefined;

      return `${MeasurementItem.DEFAULT_LFE_PREDICTED}${position}`;
    });

    this.allPredictedLfeMeasurement = ko.computed(() => {
      return this.measurements().filter(response =>
        response?.title().startsWith(MeasurementItem.DEFAULT_LFE_PREDICTED)
      );
    });

    this.predictedLfeMeasurement = ko.computed(() => {
      return this.allPredictedLfeMeasurement().find(
        response => response?.title() === this.predictedLfeMeasurementTitle()
      );
    });

    this.uniqueSpeakersMeasurements = ko.computed(() => {
      return this.uniqueMeasurements().filter(item => !item.isSub());
    });
  }

  async updateTargetCurve(referenceMeasurement) {
    if (!referenceMeasurement) {
      throw new Error('Reference measurement is undefined');
    }

    const previousTargetcurveTitle = 'Target';
    // update main target level to update the tcName
    await this.getMainTargetLevel();
    const title = `${previousTargetcurveTitle} ${this.tcName()}`;

    if (this.measurements().some(item => item.title() === title)) {
      this.appendStatus(`Target curve ${title} already exists, skipping creation.`);
      return;
    }

    // delete previous targets curve
    const previousTargetcurves = this.measurements().filter(item =>
      item.title().startsWith(previousTargetcurveTitle)
    );

    await this.removeMeasurements(previousTargetcurves);

    const targetMeasurement = await referenceMeasurement.eqCommands(
      'Generate target measurement'
    );
    await targetMeasurement.setTitle(title, `from ${referenceMeasurement.title()}`);

    this.appendStatus(`Created target curve: ${title}`);
  }

  async equalizeSub(subMeasurement) {
    const firstMeasurementLevel = await this.getMainTargetLevel();
    await subMeasurement.applyWorkingSettings();
    await subMeasurement.setTargetLevel(firstMeasurementLevel);
    await subMeasurement.resetTargetSettings();
    await subMeasurement.detectFallOff(-3);

    const customStartFrequency = Math.max(
      this.lowerFrequencyBound(),
      subMeasurement.dectedFallOffLow
    );
    // do not use min because dectedFallOffHigh can be -1 if not detected
    const customEndFrequency = Math.min(
      this.upperFrequencyBound(),
      subMeasurement.dectedFallOffHigh
    );

    this.appendStatus(
      `Creating EQ filters for sub sumation ${customStartFrequency}Hz - ${customEndFrequency}Hz`
    );

    await this.apiService.postSafe(`eq/match-target-settings`, {
      startFrequency: customStartFrequency,
      endFrequency: customEndFrequency,
      individualMaxBoostdB: this.maxBoostIndividualValue(),
      overallMaxBoostdB: this.maxBoostOverallValue(),
      flatnessTargetdB: 1,
      allowNarrowFiltersBelow200Hz: false,
      varyQAbove200Hz: false,
      allowLowShelf: false,
      allowHighShelf: false,
    });

    await subMeasurement.eqCommands('Match target');

    const isFiltersOk = await subMeasurement.checkFilterGain();
    if (isFiltersOk !== 'OK') {
      throw new Error(isFiltersOk);
    }

    return true;
  }

  async setSameDelayToAll(measurements) {
    if (measurements.length <= 1) {
      return;
    }
    // align the others sub to first measurement delay
    const mainDelay = measurements[0].cumulativeIRShiftSeconds();
    for (const measurement of measurements) {
      await measurement.setcumulativeIRShiftSeconds(mainDelay);
    }
  }

  async adjustSubwooferSPLLevels(subsMeasurements, targetLevelFreq = 40) {
    if (subsMeasurements.length === 0) {
      return;
    }

    const minFrequency = 10;
    const maxFrequency = 10000;

    // Find the level of target curve at 40Hz
    const targetLevelAtFreq = await this.getTargetLevelAtFreq(
      subsMeasurements[0],
      targetLevelFreq
    );

    // adjut target level according to the number of subs
    // Using 20 for voltage addition (coherent/in-phase summation)
    const numbersOfSubs = subsMeasurements.length;
    const overhead = 20 * Math.log10(numbersOfSubs);
    const targetLevel =
      targetLevelAtFreq - overhead + Number(this.additionalBassGainValue());

    let lowFrequency = Infinity;
    let highFrequency = 0;

    for (const measurement of subsMeasurements) {
      await measurement.removeWorkingSettings();
      await measurement.resetTargetSettings();

      const frequencyResponse = await measurement.getFrequencyResponse('SPL', '1/2', 6);
      frequencyResponse.measurement = measurement.uuid;
      frequencyResponse.name = measurement.displayMeasurementTitle();
      frequencyResponse.position = measurement.position();
      await measurement.applyWorkingSettings();

      const detect = this.detectSubwooferCutoff(
        frequencyResponse.freqs,
        frequencyResponse.magnitude,
        -18
      );

      lowFrequency = Math.min(lowFrequency, Math.round(detect.lowCutoff));
      highFrequency = Math.max(highFrequency, Math.round(detect.highCutoff));

      let logMessage = `\nAdjust ${measurement.displayMeasurementTitle()} SPL levels to ${targetLevel.toFixed(
        1
      )}dB`;
      logMessage += `(center: ${detect.centerFrequency}Hz, ${detect.octaves} octaves, ${detect.lowCutoff}Hz - ${detect.highCutoff}Hz)`;

      const alignResult = await this.processCommands('Align SPL', [measurement.uuid], {
        frequencyHz: detect.centerFrequency,
        spanOctaves: detect.octaves,
        targetdB: targetLevel,
      });

      const alignOffset = MeasurementItem.getAlignSPLOffsetdBByUUID(
        alignResult,
        measurement.uuid
      );

      logMessage += ` => ${alignOffset}dB`;
      this.appendStatus(`${logMessage}`);

      measurement.splOffsetdB(measurement.splOffsetdBUnaligned() + alignOffset);
      measurement.alignSPLOffsetdB(alignOffset);
      await measurement.copySplOffsetDeltadBToOther();
    }

    lowFrequency = Math.max(lowFrequency, minFrequency);
    highFrequency = Math.min(highFrequency, maxFrequency);

    return { lowFrequency, highFrequency, targetLevelAtFreq };
  }

  async getTargetLevelAtFreq(measurement, targetFreq = 40) {
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

  async getMainTargetLevel() {
    if (!this.firstMeasurement()) {
      return MeasurementViewModel.DEFAULT_TARGET_LEVEL;
    }
    const targetLevel = await this.firstMeasurement().getTargetLevel();
    this.mainTargetLevel(targetLevel);
    return targetLevel;
  }

  getMaxFromArray(array) {
    if (!Array.isArray(array)) {
      throw new TypeError('Input is not an array');
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
    for (let index = 0; index < fullFrequencies.length; index++) {
      const freq = fullFrequencies[index];
      if (freq >= low && freq <= high) {
        frequencies.push(freq);
        magnitude.push(fullMagnitude[index]);
      }
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

    lowCutoff = Math.round(lowCutoff);
    highCutoff = Math.floor(highCutoff);

    // find the center frequency by octaves bettween lowCutoff and highCutoff
    const centerFrequency = Math.round(Math.sqrt(lowCutoff * highCutoff));

    // count the number of octaves between low and high cutoff from center frequency and round to lowest integer
    const octaves = Math.round(Math.log2(highCutoff / centerFrequency) * 2);

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
        await measurement.removeWorkingSettings();
        const frequencyResponse = await measurement.getFrequencyResponse();
        frequencyResponse.uuid = measurement.uuid;
        frequencyResponses.push(frequencyResponse);
        await measurement.applyWorkingSettings();
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
      ppo: optimizedSubsSum.ppo,
    };
    await this.apiService.postSafe('import/frequency-response-data', options, 2);

    // trick to retreive the imported measurement
    await this.loadData();
    const maximisedSum = this.measurements().find(
      item => item.title() === options.identifier
    );

    if (!maximisedSum) {
      throw new Error('Error creating maximised sum');
    }

    await maximisedSum.applyWorkingSettings();
    await maximisedSum.setTargetLevel(await this.getMainTargetLevel());
    await maximisedSum.resetTargetSettings();

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

  async produceSumProcess(subsList) {
    if (!subsList?.length) {
      throw new Error(`No subs found`);
    }
    if (subsList.length < 1) {
      throw new Error(`Not enough subs found to compute sum`);
    }
    const subResponsesTitles = subsList.map(response =>
      response.displayMeasurementTitle()
    );
    this.appendStatus(`Using: \n${subResponsesTitles.join('\r\n')}`);
    // get first subsList element position
    const position = subsList[0].position();
    const resultTitle = `${MeasurementItem.DEFAULT_LFE_PREDICTED}${position}`;

    const previousSubSum = this.measurements().find(item => item.title() === resultTitle);
    // remove previous
    if (previousSubSum) {
      await this.removeMeasurement(previousSubSum);
    }
    // create sum of all subwoofer measurements
    const newDefaultLfePredicted = await this.businessTools.createsSum(
      subsList,
      resultTitle,
      true
    );

    this.appendStatus(
      `Subwoofer sum created successfully: ${newDefaultLfePredicted.title()}`
    );
    return newDefaultLfePredicted;
  }

  async loadData() {
    try {
      this.isLoading(true);

      const data = await this.apiService.fetchREW();

      const measurementsCount = Object.keys(data).length;
      if (measurementsCount > 0 && !this.jsonAvrData()?.avr) {
        throw new Error(
          `${measurementsCount} Measurements detected in REW but no AVR information. please remove all measurements or load AVR information`
        );
      }

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
    const newKeys = new Set(Object.values(data).map(m => m.uuid));

    // Update existing or create new measurements
    const mergedMeasurements = Object.entries(data).map(([key, item]) => {
      const existing = currentMeasurements.find(m => m.uuid === item.uuid);
      if (existing) return this.updateObservableObject(existing, item);

      console.debug(`Create new measurement: ${key}: ${item.title}`);
      return new MeasurementItem(item, this);
    });

    this.measurements(mergedMeasurements);

    // Log deleted measurements
    for (const m of currentMeasurements) {
      if (!newKeys.has(m.uuid)) {
        console.debug(`removed: ${m.uuid}`);
      }
    }

    // Clear orphaned associated filters
    for (const item of mergedMeasurements) {
      if (item.associatedFilter && !newKeys.has(item.associatedFilter)) {
        item.associatedFilter = null;
        console.debug(`Removing filter: ${item.displayMeasurementTitle()}`);
      }
    }
  }

  // Helper function to handle observable properties
  updateObservableObject(target, source) {
    for (const key of Object.keys(source)) {
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
    }
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
      this.measurements.push(measurementItem);
      console.debug(`measurement ${measurementItem.title()} added`);
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
    const existingItem = this.findMeasurementByUuid(item.uuid);
    if (existingItem) {
      console.warn(
        `measurement ${item.measurementIndex()}: ${item.title()} already exists, not added`
      );
      return;
    }
    this.measurements.push(item);
    console.debug(`measurement ${item.title()} added`);
  }

  async removeMeasurements(items) {
    if (!items || items.length === 0) {
      return false;
    }

    for (const item of items) {
      await this.removeMeasurement(item);
    }
    return true;
  }

  async removeMeasurement(item) {
    if (!item) {
      return false;
    }

    await this.removeMeasurementUuid(item.uuid);
    // remove associatedFilter
    await this.removeMeasurementUuid(item.associatedFilter);

    this.appendStatus(`measurement ${item.displayMeasurementTitle()} removed`);

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

      this.measurements.remove(item => item.uuid === itemUuid);

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
  async doArithmeticOperation(itemA, itemB, operationObject) {
    if (!itemA || !itemB) {
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

    if (!allowedCommands.includes(operationObject.function)) {
      throw new Error(`Command ${operationObject.function} is not allowed`);
    }

    // operation to store IR offset into the result measurement
    const currentCumulativeIRShiftA = itemA.cumulativeIRShiftSeconds();
    const currentCumulativeIRShiftB = itemB.cumulativeIRShiftSeconds();
    const maxCumulativeIRShift = Math.max(
      currentCumulativeIRShiftA,
      currentCumulativeIRShiftB
    );
    // set both to 0 to avoid issues during arithmetic operation
    await itemA.addIROffsetSeconds(-maxCumulativeIRShift);
    await itemB.addIROffsetSeconds(-maxCumulativeIRShift);

    const operationResult = await this.processCommands(
      'Arithmetic',
      [itemA.uuid, itemB.uuid],
      operationObject
    );

    await itemA.addIROffsetSeconds(maxCumulativeIRShift);
    await itemB.addIROffsetSeconds(maxCumulativeIRShift);
    await operationResult.addIROffsetSeconds(maxCumulativeIRShift);

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

    if (!allowedCommands.includes(commandName)) {
      throw new Error(`Command ${commandName} is not allowed`);
    }

    try {
      const operationResult = await this.apiService.postNext(
        commandName,
        uuids,
        commandData,
        0
      );

      if (withoutResultCommands.includes(commandName)) {
        return operationResult;
      }

      if (!operationResult.results) {
        throw new Error(
          `Missing result from API response: ${JSON.stringify(operationResult)}`
        );
      }

      const operationResultUuid = Object.values(operationResult.results)[0]?.UUID;
      return await this.addMeasurementApi(operationResultUuid);
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
    if (!this.jsonAvrData()?.avr) {
      throw new Error('Please load AVR data first');
    }

    try {
      // Use a standard octave range (1 octave = factor of 2)
      const octaveRange = 1; // Number of octaves to span in each direction
      // one octave below frequency
      const lowFrequency = Math.max(frequency / Math.pow(2, octaveRange), 20);

      // one octave above frequency
      const highFrequency = Math.min(frequency * Math.pow(2, octaveRange), 500);

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
          step: this.jsonAvrData().avr.minDistAccuracy || 0.00001, // 0.01ms
        },
        allPass: {
          enabled: false,
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

      const channelAFrequencyResponse = await channelA.getFrequencyResponse();
      channelAFrequencyResponse.measurement = channelA.uuid;
      channelAFrequencyResponse.name = channelA.displayMeasurementTitle();
      const channelBFrequencyResponse = await channelB.getFrequencyResponse();
      channelBFrequencyResponse.measurement = channelB.uuid;
      channelBFrequencyResponse.name = channelB.displayMeasurementTitle();

      const frequencyResponses = [channelAFrequencyResponse, channelBFrequencyResponse];

      const optimizer = new MultiSubOptimizer(frequencyResponses, optimizerConfig);
      const optimizerResults = optimizer.optimizeSubwoofers();

      const optimizedResults = optimizerResults.optimizedSubs[0].param;
      if (!optimizedResults) {
        throw new Error('No results found');
      }

      const isBInverted = optimizedResults.polarity === -1;
      const shiftDelay = -optimizedResults.delay;

      if (createSum) {
        const bestSumFullRange = optimizer.getFinalSubSum();
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
      data.apiBaseUrl && this.apiBaseUrl(data.apiBaseUrl);
      this.selectedSpeaker(data.selectedSpeaker);
      this.targetCurve(data.targetCurve);
      this.rewVersion(data.rewVersion);
      this.selectedLfeFrequency(data.selectedLfeFrequency);
      this.selectedAverageMethod(data.selectedAverageMethod);
      this.additionalBassGainValue(data.additionalBassGainValue || 0);
      this.maxBoostIndividualValue(data.maxBoostIndividualValue || 0);
      this.maxBoostOverallValue(data.maxBoostOverallValue || 0);
      this.loadedFileName(data.loadedFileName || '');
      data.isPolling ? this.startBackgroundPolling() : this.stopBackgroundPolling();
      data.selectedSmoothingMethod &&
        this.selectedSmoothingMethod(data.selectedSmoothingMethod);
      data.selectedIrWindows && this.selectedIrWindows(data.selectedIrWindows);
      data.individualMaxBoostValue &&
        this.individualMaxBoostValue(data.individualMaxBoostValue);
      data.overallBoostValue && this.overallBoostValue(data.overallBoostValue);
      data.upperFrequencyBound && this.upperFrequencyBound(data.upperFrequencyBound);
      data.lowerFrequencyBound && this.lowerFrequencyBound(data.lowerFrequencyBound);
      data.ocaFileFormat && this.ocaFileFormat(data.ocaFileFormat);
      data.avrIpAddress && this.avrIpAddress(data.avrIpAddress);
      if (data.measurementsByGroup) {
        for (const [key, saved] of Object.entries(data.measurementsByGroup)) {
          this.measurementsByGroup()[key]?.crossover(saved.crossover);
        }
      }
    }
  }

  saveMeasurements() {
    // Save to persistent store
    const reducedMeasurements = this.measurements().map(item => item.toJSON());
    const data = {
      measurements: reducedMeasurements,
      selectedSpeaker: this.selectedSpeaker(),
      targetCurve: this.targetCurve(),
      rewVersion: this.rewVersion(),
      selectedLfeFrequency: this.selectedLfeFrequency(),
      selectedAverageMethod: this.selectedAverageMethod(),
      additionalBassGainValue: this.additionalBassGainValue(),
      maxBoostIndividualValue: this.maxBoostIndividualValue(),
      maxBoostOverallValue: this.maxBoostOverallValue(),
      avrFileContent: this.jsonAvrData(),
      loadedFileName: this.loadedFileName(),
      isPolling: this.isPolling(),
      selectedSmoothingMethod: this.selectedSmoothingMethod(),
      selectedIrWindows: this.selectedIrWindows(),
      individualMaxBoostValue: this.individualMaxBoostValue(),
      overallBoostValue: this.overallBoostValue(),
      upperFrequencyBound: this.upperFrequencyBound(),
      lowerFrequencyBound: this.lowerFrequencyBound(),
      apiBaseUrl: this.apiBaseUrl(),
      ocaFileFormat: this.ocaFileFormat(),
      avrIpAddress: this.avrIpAddress(),
      measurementsByGroup: Object.fromEntries(
        Object.entries(this.measurementsByGroup()).map(([key, group]) => [
          key,
          { crossover: group.crossover() },
        ])
      ),
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
      this.apiService = new RewApi(this.apiBaseUrl(), false, this.blocking);
      await this.apiService.initializeAPI();
      this.rewVersion(await this.apiService.checkVersion());
      await this.refreshTargetCurve();
      if (!this.targetCurve()) {
        this.status(
          'Warning: No target curve found in REW. Please set a target curve in REW for optimal performance.'
        );
      }
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
