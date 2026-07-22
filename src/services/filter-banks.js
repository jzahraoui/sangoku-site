/**
 * Magasin des deux banques de filtres Audyssey (RCH 2.0, decision produit) :
 * l'ampli memorise DEUX jeux de coefficients (Reference / Flat) mais UN seul
 * jeu de delais/gains/distances/crossovers (SET_SETDAT unique). RCH permet
 * donc d'enregistrer les filtres — et uniquement les filtres — dans chaque
 * banque : workflow complet → banque A ; puis changer LA COURBE CIBLE
 * SEULEMENT, recalculer, → banque B. Le transfert exige les deux banques.
 *
 * L'empreinte (`fingerprint`) capture les parametres non-filtres des canaux
 * generes ; l'enregistrement de la seconde banque est refuse si elle differe
 * de la premiere (delais/gains/xover doivent rester identiques), et la
 * construction de l'archive re-verifie contre l'etat courant.
 *
 * [ORCHESTRATION] : aucune donnee de signal sur les records/items (ADR 002) —
 * les FIR vivent ici, dans la couche service.
 */

const BANKS = Object.freeze(['reference', 'flat']);

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/**
 * Empreinte des parametres non-filtres d'un jeu de canaux generes.
 * Distances arrondies a 0,1 mm pour absorber le bruit flottant d'une
 * regeneration a l'identique.
 */
function computeFingerprint(channels, eqType) {
  const perChannel = [...channels]
    .map(channel => ({
      commandId: channel.commandId,
      speakerType: channel.speakerType,
      distance: Number(channel.distanceInMeters.toFixed(4)),
      trim: Number(channel.trimAdjustmentInDbs.toFixed(4)),
      xover: channel.xover ?? 0,
    }))
    .sort((a, b) => a.commandId.localeCompare(b.commandId));
  return JSON.stringify({ eqType, perChannel });
}

/** Differences lisibles entre deux empreintes (pour un refus explicite). */
function describeFingerprintDifferences(leftFingerprint, rightFingerprint) {
  const left = JSON.parse(leftFingerprint);
  const right = JSON.parse(rightFingerprint);
  const differences = [];
  if (left.eqType !== right.eqType) {
    differences.push(`MultEQ type ${left.eqType} vs ${right.eqType}`);
  }
  const rightById = new Map(right.perChannel.map(channel => [channel.commandId, channel]));
  for (const channel of left.perChannel) {
    const other = rightById.get(channel.commandId);
    if (!other) {
      differences.push(`channel ${channel.commandId} missing`);
      continue;
    }
    rightById.delete(channel.commandId);
    for (const field of ['speakerType', 'distance', 'trim', 'xover']) {
      if (channel[field] !== other[field]) {
        differences.push(
          `${channel.commandId} ${field}: ${channel[field]} vs ${other[field]}`,
        );
      }
    }
  }
  for (const commandId of rightById.keys()) {
    differences.push(`channel ${commandId} added`);
  }
  return differences;
}

function assertKnownBank(bank) {
  if (!BANKS.includes(bank)) {
    throw new Error(`Unknown filter bank: ${bank} (expected reference|flat)`);
  }
}

function otherBankOf(bank) {
  return bank === 'reference' ? 'flat' : 'reference';
}

function createFilterBanks({ log = noopLog } = {}) {
  const banks = { reference: null, flat: null };

  function save(bank, { channels, eqType, targetCurve, tcName, savedAt }) {
    assertKnownBank(bank);
    if (!channels?.length) {
      throw new Error('Cannot save an empty filter set to a bank');
    }
    const fingerprint = computeFingerprint(channels, eqType);
    const other = banks[otherBankOf(bank)];
    if (other && other.fingerprint !== fingerprint) {
      const differences = describeFingerprintDifferences(other.fingerprint, fingerprint);
      throw new Error(
        `The two banks must share identical delays/gains/crossovers (the AVR ` +
          `stores a single setup): only the target curve may change between ` +
          `bank saves. Differences: ${differences.join('; ')}`,
      );
    }
    banks[bank] = { channels, eqType, fingerprint, targetCurve, tcName, savedAt };
    log.info(
      `Filters saved to the ${bank} bank (${channels.length} channels, target curve: ${tcName || targetCurve || 'n/a'})`,
    );
    return banks[bank];
  }

  function get(bank) {
    assertKnownBank(bank);
    return banks[bank];
  }

  function clear(bank) {
    assertKnownBank(bank);
    banks[bank] = null;
  }

  function clearAll() {
    banks.reference = null;
    banks.flat = null;
  }

  /** Commodite (comportement 1.x) : memes filtres dans les deux banques. */
  function duplicateToOther(sourceBank) {
    assertKnownBank(sourceBank);
    const source = banks[sourceBank];
    if (!source) {
      throw new Error(`The ${sourceBank} bank is empty: save filters first`);
    }
    banks[otherBankOf(sourceBank)] = { ...source };
    return banks[otherBankOf(sourceBank)];
  }

  function bothLoaded() {
    return Boolean(banks.reference && banks.flat);
  }

  /** Resume leger pour l'UI (sans les FIR). */
  function summary() {
    const describe = bank =>
      bank
        ? {
            loaded: true,
            channelCount: bank.channels.length,
            targetCurve: bank.targetCurve ?? null,
            tcName: bank.tcName ?? null,
            savedAt: bank.savedAt ?? null,
          }
        : { loaded: false };
    return { reference: describe(banks.reference), flat: describe(banks.flat) };
  }

  /** Etat serialisable (session) — channels inclus. */
  function toJSON() {
    return {
      reference: banks.reference,
      flat: banks.flat,
    };
  }

  function restore(data) {
    clearAll();
    for (const bank of BANKS) {
      const entry = data?.[bank];
      if (entry?.channels?.length && entry.fingerprint) {
        banks[bank] = entry;
      }
    }
  }

  return {
    save,
    get,
    clear,
    clearAll,
    duplicateToOther,
    bothLoaded,
    summary,
    toJSON,
    restore,
  };
}

export { computeFingerprint, createFilterBanks, describeFingerprintDifferences };
