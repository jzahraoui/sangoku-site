import { describe, expect, it, vi } from 'vitest';
import {
  describeFileMismatch,
  modelSplOffset,
  normalizeChannelCode,
  sameAvrIdentity,
  synthesizeAvrData,
} from '../../src/services/avr-data-synthesis.js';

const INFO_XT32 = Object.freeze({
  Ifver: '00.08',
  DType: 'Float',
  EQType: 'MultEQXT32',
  CoefWaitTime: { Init: 0, Final: 0 },
});

function statusFixture(overrides = {}) {
  return {
    HPPlug: false,
    Mic: false,
    AmpAssign: 'Normal',
    AssignBin: '0F04010200',
    ChSetup: [
      { FL: 'S' },
      { C: 'S' },
      { FR: 'S' },
      { SWMIX1: 'E' },
      { SWMIX2: 'E' },
    ],
    BTTXStatus: false,
    SpPreset: '1',
    SWSetup: { SWNum: 2, SWMode: 'Directional', SWLayout: 'FL/FR/RL/RR' },
    ...overrides,
  };
}

describe('normalizeChannelCode', () => {
  it.each([
    ['SWMIX1', 'SW1'],
    ['SWMIX4', 'SW4'],
    ['SWLFE', 'SW1'],
    ['SWMIX', 'SW1'],
    ['LFE', 'SW1'],
    ['SW2', 'SW2'],
    ['SWL', 'SW1'],
    ['SWR', 'SW2'],
    ['SWFL', 'SW1'],
    ['SWBR', 'SW4'],
    ['FL', 'FL'],
    ['SLA', 'SLA'],
    ['TML', 'TML'],
  ])('maps %s to %s', (wire, expected) => {
    expect(normalizeChannelCode(wire)).toBe(expected);
  });
});

describe('modelSplOffset', () => {
  it('returns the file-import convention of the model', () => {
    expect(modelSplOffset('Denon AVC-A1H', 'MultEQXT32')).toBe(80);
    expect(modelSplOffset('Denon AVR-X3600H', 'MultEQXT')).toBe(105);
    expect(modelSplOffset('', 'MultEQXT32')).toBe(80);
    expect(modelSplOffset(undefined, undefined)).toBe(80);
  });
});

describe('synthesizeAvrData', () => {
  it('builds a jsonAvrData-shaped context from live payloads', () => {
    const data = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture(),
      model: 'Denon AVC-A1H',
    });

    expect(data.source).toBe('bridge-live');
    expect(data.targetModelName).toBe('Denon AVC-A1H');
    expect(data.enMultEQType).toBe(2);
    expect(data.enAmpAssignType).toBe(0);
    expect(data.ampAssignInfo).toBe('0F04010200');
    expect(data.subwooferNum).toBe(2);
    expect(data.subwooferMode).toBe('Directional');
    expect(data.interfaceVersion).toBe('00.08');
    expect(data.dType).toBe('Float');
    expect(data.detectedChannels.map(c => c.commandId)).toEqual([
      'FL',
      'C',
      'FR',
      'SW1',
      'SW2',
    ]);
    expect(data.detectedChannels.map(c => c.wireCode)).toEqual([
      'FL',
      'C',
      'FR',
      'SWMIX1',
      'SWMIX2',
    ]);
    // Generic SWMix channel ids of CHANNEL_TYPES (54/55), FL = 0.
    expect(data.detectedChannels[0].enChannelType).toBe(0);
    expect(data.detectedChannels[3].enChannelType).toBe(54);
    expect(data.detectedChannels[4].enChannelType).toBe(55);
    expect(data.avr.multEQType).toBe('XT32');
    expect(data.avr.isFourSubwooferModel).toBe(true);
  });

  it('maps every EQType generation', () => {
    for (const [name, id] of [
      ['MultEQ', 0],
      ['MultEQXT', 1],
      ['MultEQXT32', 2],
    ]) {
      const data = synthesizeAvrData({
        info: { ...INFO_XT32, EQType: name },
        status: statusFixture(),
        model: 'Denon AVR-X3800H',
      });
      expect(data.enMultEQType).toBe(id);
    }
  });

  it('rejects an unknown EQType', () => {
    expect(() =>
      synthesizeAvrData({
        info: { ...INFO_XT32, EQType: 'MultEQXT64' },
        status: statusFixture(),
        model: 'Denon',
      }),
    ).toThrow('Unsupported AVR EQType');
  });

  it('requires info and status payloads', () => {
    expect(() => synthesizeAvrData({ info: INFO_XT32, status: null })).toThrow(
      'AVR info and status',
    );
  });

  it('rejects an empty channel setup', () => {
    expect(() =>
      synthesizeAvrData({
        info: INFO_XT32,
        status: statusFixture({ ChSetup: [] }),
        model: 'Denon',
      }),
    ).toThrow('no configured channels');
  });

  it('tolerates a missing SWSetup key (Cirrus) and falls back to the channel count', () => {
    const status = statusFixture({ ChSetup: [{ FL: 'S' }, { FR: 'S' }, { SW1: 'E' }] });
    delete status.SWSetup;

    const data = synthesizeAvrData({
      info: { ...INFO_XT32, EQType: 'MultEQXT', DType: 'FixedA' },
      status,
      model: 'Denon AVR-X3600H',
    });

    expect(data.subwooferNum).toBe(1);
    expect(data.subwooferMode).toBeNull();
    expect(data.avr.hasCirrusLogicDsp).toBe(true);
  });

  it.each([['Standard'], ['Na'], ['Directional']])(
    'keeps every subwoofer channel in %s mode',
    swMode => {
      // Decision 2026-07-23 (REGLES-METIER): the AVR exposes its subwoofers
      // and accepts per-sub filters/gains/delays in EVERY mode — Directional
      // is only the measurement mode giving individual sub responses. The
      // synthesis must never collapse SW2..SW4 outside Directional.
      const data = synthesizeAvrData({
        info: INFO_XT32,
        status: statusFixture({
          ChSetup: [
            { FL: 'S' },
            { FR: 'S' },
            { SWMIX1: 'E' },
            { SWMIX2: 'E' },
            { SWMIX3: 'E' },
            { SWMIX4: 'E' },
          ],
          SWSetup: { SWNum: 4, SWMode: swMode, SWLayout: 'N/A' },
        }),
        model: 'Denon AVC-A1H',
      });

      expect(data.detectedChannels.map(c => c.commandId)).toEqual([
        'FL',
        'FR',
        'SW1',
        'SW2',
        'SW3',
        'SW4',
      ]);
      expect(data.subwooferNum).toBe(4);
      expect(data.subwooferMode).toBe(swMode);
    },
  );

  it('warns and keeps a null enAmpAssignType on unknown amp assignment', () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const data = synthesizeAvrData(
      {
        info: INFO_XT32,
        status: statusFixture({ AmpAssign: 'SomethingNew' }),
        model: 'Denon AVC-A1H',
      },
      log,
    );

    expect(data.enAmpAssignType).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('SomethingNew'),
    );
  });

  it('resolves the ambiguous surround/back codes like the official analyzer', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const data = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture({
        ChSetup: [
          { FL: 'S' },
          { SLA: 'S' },
          { SRA: 'S' },
          { SBL: 'S' },
          { SBR: 'S' },
          { SWMIX1: 'E' },
        ],
      }),
      model: 'Denon AVC-A1H',
    });

    const byCommand = Object.fromEntries(
      data.detectedChannels.map(c => [c.commandId, c.enChannelType]),
    );
    // SurrLeftA (13) / SurrRightA (5) / SBackLeft (10), never the ambiguous
    // first-match picks SurrRight (4) or SBackCenter (9).
    expect(byCommand.SLA).toBe(13);
    expect(byCommand.SRA).toBe(5);
    expect(byCommand.SBL).toBe(10);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolves the whole-code channels CH and TS exactly', () => {
    // A prefix-based match (getBestMatchCode style) would see CH as ambiguous
    // with C; the official table is exact-match.
    const data = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture({
        ChSetup: [{ C: 'S' }, { CH: 'S' }, { TS: 'S' }, { SWMIX1: 'E' }],
      }),
      model: 'Denon AVC-A1H',
    });

    const byCommand = Object.fromEntries(
      data.detectedChannels.map(c => [c.commandId, c.enChannelType]),
    );
    expect(byCommand.C).toBe(1);
    expect(byCommand.CH).toBe(16); // FrontHeightCenter
    expect(byCommand.TS).toBe(41); // Overhead
  });

  it('reclassifies a lone connected back-left speaker as back center', () => {
    const data = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture({
        ChSetup: [{ FL: 'S' }, { SBL: 'S' }, { SBR: 'N' }, { SWMIX1: 'E' }],
      }),
      model: 'Denon AVC-A1H',
    });

    const sbl = data.detectedChannels.find(c => c.commandId === 'SBL');
    expect(sbl.enChannelType).toBe(9); // SBackCenter
    expect(sbl.speakerSize).toBe('S');
    expect(sbl.wireCode).toBe('SBL');
  });

  it('keeps a connected back pair as left/right', () => {
    const data = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture({
        ChSetup: [{ SBL: 'L' }, { SBR: 'L' }, { SWMIX1: 'E' }],
      }),
      model: 'Denon AVC-A1H',
    });

    const sbl = data.detectedChannels.find(c => c.commandId === 'SBL');
    expect(sbl.enChannelType).toBe(10); // SBackLeft
    expect(sbl.speakerSize).toBe('L');
  });

  it('skips unknown channel codes with a warning', () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const data = synthesizeAvrData(
      {
        info: INFO_XT32,
        status: statusFixture({
          ChSetup: [{ FL: 'S' }, { WEIRD9: 'S' }, { SW1: 'E' }],
        }),
        model: 'Denon AVC-A1H',
      },
      log,
    );

    expect(data.detectedChannels.map(c => c.commandId)).toEqual(['FL', 'SW1']);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('WEIRD9'));
  });
});

function a1hContext() {
  return synthesizeAvrData({
    info: INFO_XT32,
    status: statusFixture(),
    model: 'Denon AVC-A1H',
  });
}

describe('sameAvrIdentity', () => {
  const base = a1hContext;

  it('matches a re-synthesis of the same amplifier', () => {
    expect(sameAvrIdentity(base(), base())).toBe(true);
  });

  it('matches regardless of channel order', () => {
    const reordered = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture({
        ChSetup: [
          { SWMIX2: 'E' },
          { FR: 'S' },
          { FL: 'S' },
          { SWMIX1: 'E' },
          { C: 'S' },
        ],
      }),
      model: 'Denon AVC-A1H',
    });
    expect(sameAvrIdentity(base(), reordered)).toBe(true);
  });

  it('rejects a different model, EQ generation or channel set', () => {
    const other = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture(),
      model: 'Denon AVR-X3800H',
    });
    expect(sameAvrIdentity(base(), other)).toBe(false);

    const xt = synthesizeAvrData({
      info: { ...INFO_XT32, EQType: 'MultEQXT' },
      status: statusFixture(),
      model: 'Denon AVC-A1H',
    });
    expect(sameAvrIdentity(base(), xt)).toBe(false);

    const fewer = synthesizeAvrData({
      info: INFO_XT32,
      status: statusFixture({
        ChSetup: [{ FL: 'S' }, { FR: 'S' }, { SWMIX1: 'E' }],
      }),
      model: 'Denon AVC-A1H',
    });
    expect(sameAvrIdentity(base(), fewer)).toBe(false);
  });

  it('is compatible with a restored 1.x .ady context of the same amplifier', () => {
    const restoredFromAdy = {
      targetModelName: 'Denon AVC-A1H',
      enMultEQType: 2,
      detectedChannels: [
        { commandId: 'FL' },
        { commandId: 'C' },
        { commandId: 'FR' },
        { commandId: 'SW1' },
        { commandId: 'SW2' },
      ],
    };
    expect(sameAvrIdentity(restoredFromAdy, base())).toBe(true);
  });
});

describe('describeFileMismatch', () => {
  const live = a1hContext;

  it('is empty for a coherent file', () => {
    const file = { targetModelName: 'Denon AVC-A1H', enMultEQType: 2 };
    expect(describeFileMismatch(file, live())).toEqual([]);
  });

  it('reports model and EQ generation differences', () => {
    const file = { targetModelName: 'Denon AVR-X3600H', enMultEQType: 1 };
    const mismatches = describeFileMismatch(file, live());
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]).toContain('Denon AVR-X3600H');
    expect(mismatches[1]).toContain('MultEQ type 1');
  });
});
