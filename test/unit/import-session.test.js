import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logs.js', () => ({
  default: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  },
}));

const {
  cleanJSON,
  createImportSession,
  findClosingBrace,
  normalizeChannelMapping,
  parseSessionFile,
  processMqxFile,
  validateFile,
} = await import('../../src/services/import-session.js');

const importSession = createImportSession();

describe('validateFile', () => {
  it('rejects unsupported extensions', () => {
    expect(() => validateFile({ name: 'session.txt', size: 10 })).toThrow(
      'Please select a .avr, .ady, .mqx or .liveproject file',
    );
  });

  it('rejects oversized files', () => {
    expect(() => validateFile({ name: 'session.ady', size: 210_000_000 })).toThrow(
      'File size exceeds 200 MB limit',
    );
  });

  it('accepts a valid file', () => {
    expect(() => validateFile({ name: 'Session.MQX', size: 1024 })).not.toThrow();
  });
});

describe('cleanJSON / findClosingBrace', () => {
  it('truncates garbage after the closing brace', () => {
    expect(cleanJSON('junk{"a":{"b":1}}garbage')).toBe('{"a":{"b":1}}');
  });

  it('ignores braces inside strings and escapes', () => {
    const content = '{"a":"}\\"{","b":2}trailing';
    expect(cleanJSON(content)).toBe('{"a":"}\\"{","b":2}');
  });

  it('reports unmatched braces and invalid input', () => {
    expect(() => cleanJSON('{"a":1')).toThrow('unmatched braces');
    expect(() => cleanJSON('no json here')).toThrow('no JSON object found');
    expect(() => cleanJSON('')).toThrow('non-empty string');
    expect(findClosingBrace('{{}', 0)).toBe(-1);
  });
});

describe('parseSessionFile', () => {
  it('cleans .mqx content before parsing', () => {
    expect(parseSessionFile('{"a":1}\0junk', 'file.mqx')).toEqual({ a: 1 });
  });

  it('parses other files as-is', () => {
    expect(parseSessionFile('{"a":1}', 'file.ady')).toEqual({ a: 1 });
    expect(() => parseSessionFile('{"a":1}junk', 'file.ady')).toThrow();
  });
});

describe('normalizeChannelMapping', () => {
  const normalized = ids => {
    const data = {
      detectedChannels: ids.map((enChannelType, i) => ({
        commandId: `CH${i}`,
        enChannelType,
      })),
    };
    normalizeChannelMapping(data);
    return data.detectedChannels.map(c => c.enChannelType);
  };

  it('converts directional bass channel types to standard ones', () => {
    const data = {
      detectedChannels: [
        { commandId: 'SWMIX1', enChannelType: 59 },
        { commandId: 'FL', enChannelType: 1 },
      ],
    };

    normalizeChannelMapping(data);

    expect(data.detectedChannels.map(c => c.enChannelType)).toEqual([54, 1]);
  });

  it('reproduces the legacy hardcoded table exactly', () => {
    // 2sp Front/Back, 3sp FL/FR/Rear, 4sp FL/FR/BL/BR — the table shipped
    // before the CHANNEL_TYPES derivation.
    const legacyTable = {
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

    const input = Object.keys(legacyTable).map(Number);
    expect(normalized(input)).toEqual(input.map(id => legacyTable[id]));
  });

  it('fills the layouts the legacy table missed', () => {
    // 2sp/3sp Left/Right and 3sp Front/Back directional layouts.
    expect(normalized([43, 44, 45, 46, 48, 50])).toEqual([54, 54, 55, 55, 54, 56]);
  });

  it('keeps speakers, SWLFE, SWMix and unknown types unchanged', () => {
    const untouched = [0, 1, 2, 42, 52, 53, 65, 54, 55, 56, 57, 999];
    expect(normalized(untouched)).toEqual(untouched);
  });

  it('keeps a codeless directional sub unchanged and warns through the injected log', () => {
    const warn = vi.fn();
    const session = createImportSession({
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    const data = {
      // 51 = SWMiddle2sp: directional position but no SW code to map to.
      detectedChannels: [{ commandId: 'SW2', enChannelType: 51 }],
    };

    session.normalizeChannelMapping(data);

    expect(data.detectedChannels[0].enChannelType).toBe(51);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('51'));
  });

  it('preserves the other channel fields', () => {
    const data = {
      detectedChannels: [{ commandId: 'SW1', enChannelType: 59, responseData: { 0: [1] } }],
    };

    normalizeChannelMapping(data);

    expect(data.detectedChannels[0]).toEqual({
      commandId: 'SW1',
      enChannelType: 54,
      responseData: { 0: [1] },
    });
  });
});

describe('processMqxFile', () => {
  it('requires AVR data to be loaded first', async () => {
    await expect(processMqxFile({}, null)).rejects.toThrow(
      'connect the bridge and register your AVR first',
    );
  });
});

describe('importImpulseResponse', () => {
  function fakeSession() {
    return {
      state: { isPolling: true },
      rewImport: { importImpulseResponseData: vi.fn().mockResolvedValue({}) },
      addMeasurementFromRewOperation: vi.fn(async operation => {
        await operation();
        return { uuid: 'created' };
      }),
      setProcessing: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('imports the response and tags the created measurement with its IR peak', async () => {
    const session = fakeSession();
    const processedResponse = { name: 'FL_P01', data: [0.1, -0.8, 0.4] };

    await importSession.importImpulseResponse(session, processedResponse, {
      sampleRate: 48000,
      splOffset: 80,
    });

    expect(session.addMeasurementFromRewOperation).toHaveBeenCalledWith(
      expect.any(Function),
      { expectedTitle: 'FL_P01', operationLabel: 'import FL_P01' },
    );
    expect(session.rewImport.importImpulseResponseData).toHaveBeenCalledWith({
      identifier: 'FL_P01',
      startTime: 0,
      sampleRate: 48000,
      splOffset: 80,
      applyCal: false,
      data: [0.1, -0.8, 0.4],
    });

    const created = await session.addMeasurementFromRewOperation.mock.results[0].value;
    expect(created.IRPeakValue).toBe(0.8);
  });

  it('importAdyImpulses skips the import when not connected', async () => {
    const session = fakeSession();
    session.state.isPolling = false;
    const adyTools = {
      impulses: [{ name: 'a', data: [0] }],
      samplingRate: 48000,
      isDirectionalWhenMultiSubs: vi.fn(),
    };

    await importSession.importAdyImpulses(session, adyTools, {
      filename: 'file.ady',
      splOffset: 80,
    });

    expect(adyTools.isDirectionalWhenMultiSubs).toHaveBeenCalledOnce();
    expect(session.setProcessing).not.toHaveBeenCalled();
    expect(session.addMeasurementFromRewOperation).not.toHaveBeenCalled();
  });

  it('importAdyImpulses sorts impulses and wraps the import in the processing lock', async () => {
    const session = fakeSession();
    const adyTools = {
      impulses: [
        { name: 'SW1_P02', data: [0.1] },
        { name: 'FL_P01', data: [0.2] },
      ],
      samplingRate: 44100,
      isDirectionalWhenMultiSubs: vi.fn(),
    };

    await importSession.importAdyImpulses(session, adyTools, {
      filename: 'file.mqx',
      splOffset: 75,
    });

    // .mqx files do not trigger the directional-subs detection
    expect(adyTools.isDirectionalWhenMultiSubs).not.toHaveBeenCalled();
    expect(adyTools.impulses.map(i => i.name)).toEqual(['FL_P01', 'SW1_P02']);
    expect(session.setProcessing).toHaveBeenNthCalledWith(1, true);
    expect(session.setProcessing).toHaveBeenLastCalledWith(false);
    expect(session.addMeasurementFromRewOperation).toHaveBeenCalledTimes(2);
  });
});
