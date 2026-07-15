import { CHANNEL_TYPES } from './audyssey.js';
import ampAssignType from './amp-type.js';
import {
  buildBiquadCascadeFromRewBank,
  buildCrossoverCascade,
  electricalSpeakerHighPassSetting,
} from './measurement/rew-filter-bank.js';
import {
  computeNormalizedBankImpulseResponse,
  processThroughCascade,
} from './dsp/impulseResponse.js';

export default class OCAFileGenerator {
  static GAIN_ADJUSTMENT_EXP = -0.44999998807907104;
  static GAIN_ADJUSTMENT_EXP_SOFT = -0.35;

  static GAIN_ADJUSTMENT = Math.pow(10, OCAFileGenerator.GAIN_ADJUSTMENT_EXP_SOFT);

  constructor(avrFileContent) {
    if (!avrFileContent) {
      throw new Error(`no avr file content provided`);
    }
    this.fileFormat = 'odd';
    this.avrFileContent = avrFileContent;
    this.versionEvo = 'Sangoku_custom';
    this.tcName = '';
    this.bassFill = 0;
    this.softRoll = false;
    this.ocaTypeId = 'OCAFILE';
    this.ocaVersion = 1;
    this.ifVersionMajor = 10;
    this.ifVersionMinor = 5;
    this.channels = [];
    this.enableDynamicEq = false;
    this.dynamicEqRefLevel = 0;
    this.enableDynamicVolume = false;
    this.dynamicVolumeSetting = 0;
    this.enableLowFrequencyContainment = false;
    this.lowFrequencyContainmentLevel = 3;
    this.numberOfSubwoofers = 1;
    this.subwooferOutput = 'LFE';
    this.lpfForLFE = 250;
    // Canaux dont la FIR a reçu le BW12 électrique lors du dernier
    // createsFilters — source unique pour les logs de l'appelant.
    this.electricalHighPassChannels = [];
  }

  // Method to get data for saving
  toJSON() {
    return {
      model: this.avrFileContent.targetModelName,
      eqType: this.avrFileContent.enMultEQType,
      ...(this.fileFormat === 'odd' && {
        versionEvo: this.versionEvo,
        tcName: this.tcName,
        bassFill: this.bassFill,
        softRoll: this.softRoll,
        ocaTypeId: this.ocaTypeId,
        ocaVersion: this.ocaVersion,
        title: this.avrFileContent.title,
        ifVersionMajor: this.ifVersionMajor,
        ifVersionMinor: this.ifVersionMinor,
        ampAssign: this.avrFileContent.enAmpAssignType,
        ampAssignBin: this.avrFileContent.ampAssignInfo,
        enableDynamicEq: this.enableDynamicEq,
        dynamicEqRefLevel: this.dynamicEqRefLevel,
        enableDynamicVolume: this.enableDynamicVolume,
        dynamicVolumeSetting: this.dynamicVolumeSetting,
        enableLowFrequencyContainment: this.enableLowFrequencyContainment,
        lowFrequencyContainmentLevel: this.lowFrequencyContainmentLevel,
        subwooferOutput: this.subwooferOutput,
      }),
      ...(this.fileFormat === 'a1' && {
        A1EvoAcoustica: '0.0.11',
        hasGriffinLiteDSP: this.avrFileContent.avr.isGriffinLiteAVR,
        isNewModel: !this.avrFileContent.avr.isOldModelForDistanceConversion,
        ampAssign: ampAssignType.getByIndex(this.avrFileContent.enAmpAssignType),
        ampAssignInfo: this.avrFileContent.ampAssignInfo,
        bassMode: this.subwooferOutput,
      }),
      channels: this.channels,
      numberOfSubwoofers: this.numberOfSubwoofers,
      lpfForLFE: this.lpfForLFE,
    };
  }

  async createOCAFile(allResponses) {
    this.channels = await this.createsFilters(allResponses);
    const jsonData = JSON.stringify(this.toJSON(), null, 2);
    return jsonData;
  }

  async createsFilters(allResponses) {
    if (!allResponses || Object.values(allResponses).length === 0) {
      throw new Error('Cannot retreive REW measurements');
    }

    this._validateChannels(allResponses);
    this._validateCrossoverConsistency(allResponses);
    this._validateMeasurementLimits(allResponses);

    this.electricalHighPassChannels = [];
    const channels = [];
    // creates a for loop on dataArray
    for (const item of Object.values(allResponses)) {
      // skip if item is not an object and not have timeOfIRStartSeconds attribute
      if (!item.haveImpulseResponse) {
        throw new Error('rensponses must contains extended values');
      }

      try {
        channels.push(await this._buildChannel(item));
      } catch (error) {
        throw new Error(`Creates filters failed: ${error.message}`, { cause: error });
      }
    }
    return channels;
  }

  async _buildChannel(item) {
    const filterCaracteristics = item.isSub()
      ? this.avrFileContent.avr.multEQSpecs.subFilter
      : this.avrFileContent.avr.multEQSpecs.speakerFilter;

    // Génération interne : les filtres présents dans REW (GET filters)
    // font foi ; l'IR de la cascade de biquads est calculée directement au
    // taux AVR — équivalence au bit près avec l'ancien chemin REW
    // (generateFilterMeasurement → fenêtres → trim → getImpulseResponse),
    // vérifiée contre test/fixtures/oca (test:oca-internal).
    const bank = await item.getFilters();
    const cascade = buildBiquadCascadeFromRewBank(bank, filterCaracteristics.frequency);
    let impulseResponse = computeNormalizedBankImpulseResponse(
      cascade,
      filterCaracteristics.samples
    );
    // Un crossover non numérique (map corrompue, appelant sans repli) est
    // traité comme Large : pas de BW12, pas de champ xover — même tolérance
    // que l'export d'avant le BW12 électrique, où la valeur ne nourrissait
    // que le champ optionnel xover.
    const crossover = Number.isFinite(item.crossover()) ? item.crossover() : 0;
    const bassManaged = !item.isSub() && crossover !== 0;
    if (bassManaged) {
      impulseResponse = this._applyElectricalHighPass(
        item,
        impulseResponse,
        crossover,
        filterCaracteristics.frequency
      );
    }
    const filter = this.transformIR(
      Float32Array.from(impulseResponse),
      filterCaracteristics.samples,
      item.inverted()
    );

    const filterString = Array.from(filter, v => Number(v.toFixed(7)));

    return {
      channelType: item.channelDetails().channelIndex,
      speakerType: item.speakerType(),
      distanceInMeters: item.distanceInMeters(),
      trimAdjustmentInDbs: item.splForAvr(),
      filter: filterString,
      ...(this.fileFormat === 'a1' && {
        filterLV: filterString,
        commandId: item.channelName(),
      }),
      ...(bassManaged && { xover: crossover }),
    };
  }

  /**
   * Passe-haut électrique BW12 au crossover, réalisé dans la FIR de chaque
   * enceinte avec bass management : cascadé au BW12 appliqué par l'AVR, le
   * raccord devient LR24|LR24, symétrique du passe-bas du sub et en phase
   * avec lui — l'EQ ayant aplani la décroissance acoustique que le BW12 seul
   * de l'AVR pariait de trouver. Appliqué APRÈS la normalisation pic=1, sans
   * re-normaliser — le passe-haut est à gain unitaire dans la bande passante,
   * le niveau exporté (calé sur trimAdjustmentInDbs) est donc préservé ;
   * renormaliser remonterait le passband (jusqu'à ~+1.6 dB sur les FIR
   * 6 kHz) et fausserait le niveau réel du canal.
   */
  _applyElectricalHighPass(item, impulseResponse, crossover, sampleRate) {
    const electricalCascade = buildCrossoverCascade(
      electricalSpeakerHighPassSetting(crossover),
      sampleRate
    );
    const processed = processThroughCascade(impulseResponse, electricalCascade);
    // La convolution du BW12 peut en théorie dépasser le pic=1 de la
    // normalisation ; au-delà de 1.0 après GAIN_ADJUSTMENT, le coefficient
    // déborderait le format virgule fixe des AVR — échec net plutôt qu'un
    // filtre corrompu en silence.
    let peak = 0;
    for (const value of processed) {
      peak = Math.max(peak, Math.abs(value));
    }
    if (peak * OCAFileGenerator.GAIN_ADJUSTMENT > 1) {
      throw new Error(
        `FIR peak ${peak.toFixed(3)} after the electrical BW12 exceeds ` +
          `the fixed-point bound for ${item.channelName()}`
      );
    }
    this.electricalHighPassChannels.push({
      channelName: item.channelName(),
      crossover,
    });
    return processed;
  }

  _validateChannels(allResponses) {
    const expectedChannels = this.avrFileContent.detectedChannels.map(
      ch => ch.enChannelType
    );
    const providedChannels = new Set(
      allResponses.map(item => item.channelDetails()?.channelIndex)
    );
    const missingChannels = expectedChannels.filter(ch => !providedChannels.has(ch));

    if (missingChannels.length) {
      const codesLabels = missingChannels.map(channel => {
        const missingChannel = CHANNEL_TYPES.getByChannelIndex(channel);
        return missingChannel ? missingChannel.code : channel;
      });
      throw new Error(
        `${
          missingChannels.length
        } channel(s) are missing or added, please ensure all AVR detected channels are present in REW, missing are: ${codesLabels.join(
          ', '
        )}`
      );
    }
  }

  _validateCrossoverConsistency(allResponses) {
    const groupedResponses = allResponses.reduce((acc, item) => {
      const group = item.channelDetails().group;
      if (!acc[group]) {
        acc[group] = [];
      }
      acc[group].push(item);
      return acc;
    }, {});

    for (const [group, items] of Object.entries(groupedResponses)) {
      // Skip crossover check for Subwoofer group
      if (group === 'Subwoofer' || !items?.length) continue;

      const crossover = items[0].crossover();
      if (items.some(item => item.crossover() !== crossover)) {
        throw new Error(
          `Crossover value is different for items in group ${group}, please ensure all REW measurements have the same crossover value`
        );
      }
    }
  }

  _validateMeasurementLimits(allResponses) {
    const itemAboveLimit = allResponses.find(item => item.splIsAboveLimit());
    if (itemAboveLimit) {
      throw new Error(
        `${itemAboveLimit.displayMeasurementTitle()} spl ${itemAboveLimit.splForAvr()}dB is above limit`
      );
    }

    const itemExceedsDistance = allResponses.find(
      item => item.exceedsDistance() === 'error'
    );
    if (itemExceedsDistance) {
      throw new Error(
        `${itemExceedsDistance.displayMeasurementTitle()} distance ${itemExceedsDistance.distanceInMeters()}M exceeds limit`
      );
    }

    if (
      allResponses.some(item => item.crossover() === 180) &&
      !this.avrFileContent.avr.hasExtendedFreq
    ) {
      throw new Error('180Hz crossover is not supported by your AVR');
    }
  }

  transformIR(filterImpulseResponse, sampleCount, invert = false) {
    if (
      !(filterImpulseResponse instanceof Float32Array) ||
      !filterImpulseResponse.length
    ) {
      throw new Error('Invalid impulse response data');
    }
    if (!Number.isFinite(sampleCount) || sampleCount !== filterImpulseResponse.length) {
      throw new Error(
        `Sample count mismatch: expected ${sampleCount}, got ${filterImpulseResponse.length}`
      );
    }

    const multiplier = OCAFileGenerator.GAIN_ADJUSTMENT * (invert ? -1 : 1);
    return Float32Array.from(filterImpulseResponse, value => value * multiplier);
  }
}
