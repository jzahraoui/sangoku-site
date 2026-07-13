import lm from './logs.js';
import {
  AVERAGE_SUFFIX,
  LPF_REVERTED_SUFFIX,
  RESULT_PREFIX,
} from './measurement/measurement-info.js';
import { createMeasurementOperations } from './services/measurement-operations.js';
import { createBusinessTools } from './services/business-tools.js';
import { createAveragingProcessor } from './services/averaging.js';
import { createMsoImporter } from './services/mso-import.js';

/**
 * Thin Knockout adapter over the decontaminated business services (D-04).
 *
 * All the business logic lives in src/services/ (business-tools, averaging,
 * mso-import) driven through createMeasurementOperations — the same code path
 * a record-based UI uses (ADR 002); MeasurementItem instances flow through it
 * thanks to their flat-field accessors and update(). This class only builds
 * the session/context providers from the viewmodel and delegates.
 */
class BusinessTools {
  static LPF_REVERTED_SUFFIX = LPF_REVERTED_SUFFIX;
  static RESULT_PREFIX = RESULT_PREFIX;
  static AVERAGE_SUFFIX = AVERAGE_SUFFIX;

  constructor(parentViewModel) {
    if (!parentViewModel) {
      throw new Error('Parent ViewModel is required');
    }
    this.viewModel = parentViewModel;

    const operations = createMeasurementOperations({ log: lm });

    // Lazy session adapter: rewMeasurements/rewEq only exist once connected,
    // and the alignment service is wired after this constructor runs.
    const session = {
      get rewMeasurements() {
        return parentViewModel.rewMeasurements;
      },
      get rewEq() {
        return parentViewModel.rewEq;
      },
      analyseApiResponse: response => parentViewModel.analyseApiResponse(response),
      removeMeasurements: items => parentViewModel.removeMeasurements(items),
      removeMeasurement: item => parentViewModel.removeMeasurement(item),
      removeMeasurementUuid: uuid => parentViewModel.removeMeasurementUuid(uuid),
      findMeasurementByUuid: uuid => parentViewModel.findMeasurementByUuid(uuid),
    };

    // Per-item context: same derivations the MeasurementItem methods use.
    const workingSettingsConfig = () => ({
      smoothingMethod: parentViewModel.selectedSmoothingMethod(),
      roomCurveSettings: parentViewModel.getRoomCurveConfig(),
      irWindows: parentViewModel.selectedIrWindowsConfig(),
    });
    const irWindowWidthsFor = measurement => ({
      leftWindowWidthms: measurement.leftWindowWidthMilliseconds(),
      rightWindowWidthms: measurement.rightWindowWidthMilliseconds,
    });

    this.tools = createBusinessTools({
      operations,
      session,
      workingSettingsConfig,
      irWindowWidthsFor,
      displayTitleOf: measurement => measurement.displayMeasurementTitle(),
      subDistanceLeftBeforeError: () => parentViewModel.distanceLeftBeforeError(),
      speedOfSound: () => parentViewModel.jsonAvrData()?.avr?.speedOfSound || 343,
      findAligment: (...args) => parentViewModel.findAligment(...args),
      log: lm,
    });
    this.averaging = createAveragingProcessor({ session, operations, log: lm });
    this.msoImporter = createMsoImporter({ session, operations });
  }

  async revertLfeFilterProccess(freq, replaceOriginal = false, deletePrevious = true) {
    try {
      await this.tools.revertLfeFilterProccess(
        this.viewModel.subsMeasurements(),
        freq,
        replaceOriginal,
        deletePrevious,
      );
    } catch (error) {
      throw new Error(`Error: ${error.message}`, { cause: error });
    }
  }

  async revertLfeFilterProccessList(subResponses, freq, replaceOriginal = false) {
    return this.tools.revertLfeFilterProccessList(subResponses, freq, replaceOriginal);
  }

  async createLowPassFilter(measurement, freq) {
    return this.tools.createLowPassFilter(measurement, freq);
  }

  async processGroupedResponses(groupedResponse, avgMethod, deleteOriginal) {
    return this.averaging.processGroupedResponses(
      groupedResponse,
      avgMethod,
      deleteOriginal,
    );
  }

  async importFilterInREW(REWconfigs, subResponses) {
    return this.msoImporter.importFilterInREW(REWconfigs, subResponses);
  }

  async alignmentGapSeconds(speakerItem) {
    return this.tools.alignmentGapSeconds(speakerItem);
  }

  async produceAligned(speakerItem, subResponses) {
    return this.tools.produceAligned(speakerItem, subResponses);
  }

  async crossoverFilteredIrPair(sub, speaker, cutOffFrequency, subResponses = null) {
    return this.tools.crossoverFilteredIrPair(sub, speaker, cutOffFrequency, subResponses);
  }

  async createMeasurementPreview(item) {
    return this.tools.createMeasurementPreview(item);
  }

  async createsSum(itemList, title, deletePredicted = true) {
    return this.tools.createsSum(itemList, title, deletePredicted);
  }
}

export default BusinessTools;
