/**
 * Transfert de calibration via le RCH Bridge (RCH 2.0 — remplace l'export
 * OCA). Genere les FIR par canal en reutilisant le generateur OCA
 * ([MOTEUR] oca-file.js : BW12 electrique bake → raccord LR24|LR24, gain,
 * inversion, validations) avec les specs de longueurs du bridge (FR-062)
 * injectees par clonage — puis construit la CalibrationArchive
 * (filterRef = banque Reference, filterFlat = banque Flat) et pilote
 * POST /transfer avec polling de progression.
 *
 * [ORCHESTRATION] : aucun DOM, aucun framework. Dependances injectees :
 * - `bridgeSession` : session bridge connectee (api, probeAvr...).
 * - `banks` : magasin des deux banques (filter-banks.js).
 * - `log`.
 */
import OCAFileGenerator from '../oca-file.js';
import { encodeFloat32ToBase64 } from '../rew/rew-codec.js';
import {
  BRIDGE_FILTER_SPECS,
  TRANSFER_CROSSOVER_DOMAIN,
  cloneAvrDataWithBridgeSpecs,
} from '../bridge/archive-specs.js';
import { computeFingerprint } from './filter-banks.js';

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const TERMINAL_TRANSFER_STATES = new Set(['completed', 'failed', 'cancelled']);

function waitMs(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/** '00.08' → {ifVersionMajor: 0, ifVersionMinor: 8} ; null si inconnu. */
function parseInterfaceVersion(interfaceVersion) {
  const match = /^(\d+)\.(\d+)$/.exec(interfaceVersion ?? '');
  if (!match) return null;
  return {
    ifVersionMajor: Number(match[1]),
    ifVersionMinor: Number(match[2]),
  };
}

/**
 * Mesure mutualisee (mode Standard : un seul sweep pour n subs) : l'ampli
 * expose n subs mais les mesures n'en portent qu'un. La calibration du sub
 * mesure s'applique a l'identique a chaque sub (linearite : filtrer chaque
 * sub = filtrer la somme mesuree) — meme etat final que la chaine
 * officielle, rendu explicite par duplication (decision 2026-07-23,
 * REGLES-METIER). L'alignement inter-subs, lui, exige une mesure
 * Directional. Retourne `{measuredId, targets}` ou null quand il n'y a
 * rien a dupliquer (plusieurs subs mesures, un seul sub detecte, sub
 * mesure inconnu de l'ampli).
 */
function mutualisedSubExpansion(avrData, measurements) {
  const detectedSubs = (avrData?.detectedChannels ?? []).filter(channel =>
    channel.commandId?.startsWith('SW'),
  );
  if (detectedSubs.length <= 1) return null;
  const measuredIds = new Set(
    measurements
      .filter(item => typeof item?.isSub === 'function' && item.isSub())
      .map(item => item.channelName()),
  );
  if (measuredIds.size !== 1) return null;
  const [measuredId] = measuredIds;
  if (!detectedSubs.some(channel => channel.commandId === measuredId)) return null;
  return {
    measuredId,
    targets: detectedSubs.filter(channel => channel.commandId !== measuredId),
  };
}

function createCalibrationTransfer({ bridgeSession, banks, log = noopLog }) {
  /**
   * Genere les canaux (FIR aux longueurs bridge) depuis les mesures
   * courantes — memes gardes et meme acoustique que l'export OCA. En mesure
   * mutualisee, les subs non mesures sont retires pour la generation (garde
   * de completude du generateur) puis recrees par duplication du sub mesure.
   */
  async function generateChannels({ avrData, measurements, config }) {
    if (!avrData?.targetModelName) {
      throw new Error('AVR data is not available: connect the bridge first');
    }
    if (!config.targetCurve) {
      throw new Error(
        'Target curve not found. Please upload your preferred target curve under "REW/EQ/Target settings/House curve"',
      );
    }
    const expansion = mutualisedSubExpansion(avrData, measurements);
    const generationAvrData = expansion
      ? {
          ...avrData,
          detectedChannels: avrData.detectedChannels.filter(
            channel => !expansion.targets.includes(channel),
          ),
        }
      : avrData;
    const generator = new OCAFileGenerator(cloneAvrDataWithBridgeSpecs(generationAvrData));
    // Le format a1 fait porter commandId a chaque canal genere.
    generator.fileFormat = 'a1';
    const channels = await generator.createsFilters(measurements);

    const baked = generator.electricalHighPassChannels;
    if (baked.length) {
      log.info(
        `Electrical BW12 high-pass baked into the bank filters (LR24|LR24 junction): ${baked
          .map(({ channelName, crossover }) => `${channelName}@${crossover}Hz`)
          .join(', ')}`,
      );
    }
    const generated = channels.map(channel => ({
      commandId: channel.commandId,
      channelType: channel.channelType,
      speakerType: channel.speakerType,
      distanceInMeters: channel.distanceInMeters,
      trimAdjustmentInDbs: channel.trimAdjustmentInDbs,
      filter: channel.filter,
      ...(channel.xover !== undefined && { xover: channel.xover }),
    }));

    if (expansion) {
      const source = generated.find(
        channel => channel.commandId === expansion.measuredId,
      );
      if (source) {
        for (const target of expansion.targets) {
          generated.push({
            ...source,
            commandId: target.commandId,
            channelType: target.enChannelType,
          });
        }
        log.info(
          `Mutualised subwoofer measurement: ${expansion.measuredId} calibration ` +
            `(filter, gain, distance) duplicated to ${expansion.targets
              .map(target => target.commandId)
              .join(', ')}`,
        );
      }
    }
    return generated;
  }

  /**
   * Enregistre les filtres courants dans une banque. Le magasin refuse une
   * seconde banque dont les parametres non-filtres (delais/gains/xover)
   * different de la premiere — entre les deux enregistrements, seule la
   * courbe cible doit changer.
   */
  async function saveCurrentFiltersToBank(bank, { avrData, measurements, config }) {
    const channels = await generateChannels({ avrData, measurements, config });
    return banks.save(bank, {
      channels,
      eqType: avrData.enMultEQType,
      targetCurve: config.targetCurve,
      tcName: config.tcName,
      savedAt: config.savedAt ?? null,
    });
  }

  /** Empreinte de l'etat courant SANS generation de FIR (garde anti-perime). */
  function currentFingerprint({ avrData, measurements }) {
    const pseudoChannels = measurements.map(item => {
      const crossover = Number.isFinite(item.crossover()) ? item.crossover() : 0;
      const bassManaged = !item.isSub() && crossover !== 0;
      return {
        commandId: item.channelName(),
        speakerType: item.speakerType(),
        distanceInMeters: item.distanceInMeters(),
        trimAdjustmentInDbs: item.splForAvr(),
        ...(bassManaged && { xover: crossover }),
      };
    });
    // Meme duplication que generateChannels — sinon les banques (n subs)
    // seraient toujours declarees perimees face aux mesures (1 sub).
    const expansion = mutualisedSubExpansion(avrData, measurements);
    if (expansion) {
      const source = pseudoChannels.find(
        channel => channel.commandId === expansion.measuredId,
      );
      if (source) {
        for (const target of expansion.targets) {
          pseudoChannels.push({ ...source, commandId: target.commandId });
        }
      }
    }
    return computeFingerprint(pseudoChannels, avrData.enMultEQType);
  }

  function validateArchiveChannels(channels, eqType) {
    const specs = BRIDGE_FILTER_SPECS[eqType];
    for (const channel of channels) {
      const isSub = channel.commandId.startsWith('SW');
      const expected = isSub ? specs.subFilter.samples : specs.speakerFilter.samples;
      const refLength = channel.filterRefLength;
      const flatLength = channel.filterFlatLength;
      if (refLength !== expected || flatLength !== expected) {
        throw new Error(
          `Filter length mismatch for ${channel.commandId}: expected ${expected} ` +
            `taps (FR-062), got ref=${refLength} flat=${flatLength}`,
        );
      }
      if (
        channel.xover !== undefined &&
        !TRANSFER_CROSSOVER_DOMAIN.includes(channel.xover)
      ) {
        throw new Error(
          `Crossover ${channel.xover} Hz of ${channel.commandId} is outside the ` +
            `AVR domain (${TRANSFER_CROSSOVER_DOMAIN.join(', ')} Hz): pick the ` +
            'closest supported value in the group crossover selector',
        );
      }
    }
  }

  /**
   * Construit la CalibrationArchive depuis les DEUX banques chargees.
   * @returns {{archive: object, warnings: string[]}}
   */
  function buildCalibrationArchive({ avrData, measurements, config, liveStatus }) {
    const reference = banks.get('reference');
    const flat = banks.get('flat');
    if (!reference || !flat) {
      throw new Error(
        'Both filter banks must be loaded before the transfer: save the current ' +
          'filters to the Reference bank, then (optionally after changing only ' +
          'the target curve and recomputing) to the Flat bank — or duplicate.',
      );
    }

    const flatByCommandId = new Map(
      flat.channels.map(channel => [channel.commandId, channel]),
    );
    const warnings = [];
    if (reference.fingerprint !== flat.fingerprint) {
      // Le magasin l'empeche a l'enregistrement ; ceinture au build.
      throw new Error('The two banks no longer share the same channel setup');
    }
    if (measurements?.length) {
      const current = currentFingerprint({ avrData, measurements });
      if (current !== reference.fingerprint) {
        warnings.push(
          'Delays/gains/crossovers changed since the banks were saved: the ' +
            'banks are stale — re-save them (the transfer sends the BANK ' +
            'parameters, not the current ones)',
        );
      }
    }

    const channels = reference.channels.map(refChannel => {
      const flatChannel = flatByCommandId.get(refChannel.commandId);
      if (!flatChannel) {
        throw new Error(
          `Channel ${refChannel.commandId} is missing from the Flat bank`,
        );
      }
      return {
        commandId: refChannel.commandId,
        speakerType: refChannel.speakerType,
        distanceInMeters: refChannel.distanceInMeters,
        trimAdjustmentInDbs: refChannel.trimAdjustmentInDbs,
        filterRef: encodeFloat32ToBase64(Float32Array.from(refChannel.filter), true),
        filterFlat: encodeFloat32ToBase64(Float32Array.from(flatChannel.filter), true),
        ...(refChannel.xover !== undefined && { xover: refChannel.xover }),
        filterRefLength: refChannel.filter.length,
        filterFlatLength: flatChannel.filter.length,
      };
    });

    validateArchiveChannels(channels, reference.eqType);
    // Les longueurs de controle ne font pas partie du contrat d'archive.
    for (const channel of channels) {
      delete channel.filterRefLength;
      delete channel.filterFlatLength;
    }

    const ifVersion = parseInterfaceVersion(avrData.interfaceVersion);
    const swNum = channels.filter(channel =>
      channel.commandId.startsWith('SW'),
    ).length;
    const swMode = config.subwooferMode ?? 'Standard';
    const archive = {
      eqType: reference.eqType,
      title: avrData.title ?? avrData.targetModelName,
      model: avrData.targetModelName,
      ...(ifVersion ?? {}),
      channels,
      // Depuis les entrees de l'archive (et non les mesures) : en mesure
      // mutualisee dupliquee, l'archive porte n subs pour 1 sub mesure.
      numberOfSubwoofers: swNum,
      // Etat subwoofer FINAL vise apres transfert, applique par le bridge
      // (champ racine optionnel du contrat d'archive). Le layout n'a de sens
      // qu'en Directional : il reprend alors celui de l'ampli connecte.
      swSetup: {
        SWNum: swNum,
        SWMode: swMode,
        SWLayout:
          swMode === 'Directional' ? (avrData.subwooferLayout ?? 'N/A') : 'N/A',
      },
      subwooferOutput: config.subwooferOutput === 'L+M' ? 'LFE+MAIN' : 'LFE',
      bassMode: config.subwooferOutput === 'L+M' ? 'L+M' : 'LFE',
      lpfForLFE: config.lpfForLFE,
      isNewModel: !avrData.avr.isOldModelForDistanceConversion,
      isGriffin: Boolean(avrData.avr.isGriffinLiteAVR),
      ...(liveStatus?.AmpAssign && { ampAssign: liveStatus.AmpAssign }),
      // ampAssignBin OMIS deliberement (decision 2026-07-23) : l'ampli
      // regenere son AssignBin en changeant de mode subwoofer (seul l'octet
      // selecteur bouge — 46 sur la famille Griffin, bit 0x04 = Directional).
      // Un blob capture en Directional ferait echouer tout re-validate apres
      // la bascule ; sans le champ, le validateur bridge ne compare pas.
      // MultEQ on/off + courbe d'ecoute vises apres transfert. Portes par
      // l'archive .rch.json ; leur application par le bridge (AudyMultEq /
      // AudyEqSet) est un chantier bridge.
      enableMultEq: config.enableMultEq ?? true,
      multEqMode: config.multEqMode ?? 'Reference',
      enableDynamicEq: config.enableDynamicEq,
      dynamicEqRefLevel: config.dynamicEqRefLevel,
      enableDynamicVolume: config.enableDynamicVolume,
      dynamicVolumeSetting: config.dynamicVolumeSetting,
      enableLowFrequencyContainment: config.enableLowFrequencyContainment,
      lowFrequencyContainmentLevel: config.lowFrequencyContainmentLevel,
      softRoll: config.softRoll,
    };
    return { archive, warnings };
  }

  /** Lecture LIVE d'AmpAssign/AssignBin juste avant le build (verite ampli). */
  async function fetchLiveStatus() {
    bridgeSession.assertConnected();
    const { status } = await bridgeSession.api.getAvrStatus();
    return status;
  }

  async function validateArchive(archive) {
    bridgeSession.assertConnected();
    return bridgeSession.api.validateCalibration(archive);
  }

  /**
   * Demarre le transfert puis polle GET /transfer jusqu'a l'etat terminal.
   * `onStatus(status)` est appele a chaque tick (progress 0-100, phase,
   * currentChannel...). L'annulation pendant FINZ_COEFS est differee : on
   * continue de poller jusqu'au terminal.
   */
  async function runTransfer(archive, { onStatus = () => {}, pollIntervalMs = 1000 } = {}) {
    bridgeSession.assertConnected();
    const accepted = await bridgeSession.api.startTransfer(archive);
    onStatus(accepted);
    let status = accepted;
    while (!TERMINAL_TRANSFER_STATES.has(status.state)) {
      await waitMs(pollIntervalMs);
      status = await bridgeSession.api.getTransfer();
      onStatus(status);
    }
    if (status.state === 'completed') {
      log.info(
        `Transfer completed: ${status.succeededChannels?.length ?? '?'} channel(s) written`,
      );
    } else if (status.state === 'failed') {
      log.error(
        `Transfer failed (${status.error?.code ?? 'unknown'}): ${status.error?.message ?? ''}`,
      );
    }
    return status;
  }

  async function cancelTransfer() {
    bridgeSession.assertConnected();
    return bridgeSession.api.cancelTransfer();
  }

  return {
    buildCalibrationArchive,
    cancelTransfer,
    currentFingerprint,
    fetchLiveStatus,
    generateChannels,
    runTransfer,
    saveCurrentFiltersToBank,
    validateArchive,
  };
}

export { createCalibrationTransfer, parseInterfaceVersion };
