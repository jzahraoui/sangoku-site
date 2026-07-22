import { afterEach, describe, expect, it, vi } from 'vitest';

const generatorSpy = vi.hoisted(() => ({ instances: [] }));

vi.mock('../../src/oca-file.js', () => {
  class FakeOcaFileGenerator {
    constructor(avrFileContent) {
      this.avrFileContent = avrFileContent;
      this.fileFormat = 'odd';
      this.electricalHighPassChannels = [];
      generatorSpy.instances.push(this);
    }

    async createsFilters() {
      const specs = this.avrFileContent.avr.multEQSpecs;
      const makeFilter = samples => new Array(samples).fill(0.001);
      this.electricalHighPassChannels = [{ channelName: 'FL', crossover: 80 }];
      return [
        {
          channelType: 0,
          commandId: 'FL',
          speakerType: 'S',
          distanceInMeters: 3.5,
          trimAdjustmentInDbs: -1.5,
          filter: makeFilter(specs.speakerFilter.samples),
          filterLV: makeFilter(specs.speakerFilter.samples),
          xover: 80,
        },
        {
          channelType: 54,
          commandId: 'SW1',
          speakerType: 'E',
          distanceInMeters: 4.1,
          trimAdjustmentInDbs: 0,
          filter: makeFilter(specs.subFilter.samples),
          filterLV: makeFilter(specs.subFilter.samples),
        },
      ];
    }
  }
  return { default: FakeOcaFileGenerator };
});

const { createCalibrationTransfer, parseInterfaceVersion } = await import(
  '../../src/services/calibration-transfer.js'
);
const { createFilterBanks } = await import('../../src/services/filter-banks.js');
const { decodeBase64ToFloat32 } = await import('../../src/rew/rew-codec.js');

function avrDataFixture(overrides = {}) {
  return {
    source: 'bridge-live',
    targetModelName: 'Denon AVC-A1H',
    title: 'e2e-sample',
    enMultEQType: 2,
    interfaceVersion: '00.08',
    avr: {
      isGriffinLiteAVR: true,
      isOldModelForDistanceConversion: false,
      multEQSpecs: {
        subFilter: { samples: 16055, taps: 704, frequency: 48000 },
        speakerFilter: { samples: 16321, taps: 1024, frequency: 48000 },
      },
    },
    ...overrides,
  };
}

function configFixture(overrides = {}) {
  return {
    targetCurve: 'harman.txt',
    tcName: 'Harman',
    softRoll: false,
    enableDynamicEq: true,
    dynamicEqRefLevel: 0,
    enableDynamicVolume: false,
    dynamicVolumeSetting: 0,
    enableLowFrequencyContainment: false,
    lowFrequencyContainmentLevel: 3,
    subwooferOutput: 'L+M',
    lpfForLFE: 120,
    numberOfSubwoofers: 1,
    ...overrides,
  };
}

function makeBridgeSession(overrides = {}) {
  return {
    assertConnected: vi.fn(),
    api: {
      getAvrStatus: vi
        .fn()
        .mockResolvedValue({ status: { AmpAssign: '2chBiAmp', AssignBin: '0404' } }),
      validateCalibration: vi.fn().mockResolvedValue({ valid: true }),
      startTransfer: vi
        .fn()
        .mockResolvedValue({ transferId: 't1', state: 'in-progress', progress: 0 }),
      getTransfer: vi.fn(),
      cancelTransfer: vi.fn().mockResolvedValue({ cancelled: true }),
      ...overrides,
    },
  };
}

function makeService({ bridgeSession = makeBridgeSession() } = {}) {
  const banks = createFilterBanks();
  const service = createCalibrationTransfer({ bridgeSession, banks });
  return { service, banks, bridgeSession };
}

async function loadBothBanks(service) {
  const context = {
    avrData: avrDataFixture(),
    measurements: [{}],
    config: configFixture(),
  };
  await service.saveCurrentFiltersToBank('reference', context);
  await service.saveCurrentFiltersToBank('flat', {
    ...context,
    config: configFixture({ tcName: 'Flat curve', targetCurve: 'flat.txt' }),
  });
}

describe('parseInterfaceVersion', () => {
  it('parses the wire form and rejects garbage', () => {
    expect(parseInterfaceVersion('00.08')).toEqual({
      ifVersionMajor: 0,
      ifVersionMinor: 8,
    });
    expect(parseInterfaceVersion('10.5')).toEqual({
      ifVersionMajor: 10,
      ifVersionMinor: 5,
    });
    expect(parseInterfaceVersion(null)).toBeNull();
    expect(parseInterfaceVersion('v1')).toBeNull();
  });
});

describe('generateChannels', () => {
  afterEach(() => {
    generatorSpy.instances.length = 0;
  });

  it('injects the bridge filter specs and the a1 format into the generator', async () => {
    const { service } = makeService();

    const channels = await service.generateChannels({
      avrData: avrDataFixture({ enMultEQType: 1 }),
      measurements: [{}],
      config: configFixture(),
    });

    const generator = generatorSpy.instances.at(-1);
    expect(generator.fileFormat).toBe('a1');
    // XT : 513/4141 @ 48 kHz (FR-062), pas les specs historiques 512@6k.
    expect(generator.avrFileContent.avr.multEQSpecs.speakerFilter).toEqual({
      samples: 513,
      taps: 513,
      frequency: 48000,
    });
    expect(channels[0].filter).toHaveLength(513);
    expect(channels[1].filter).toHaveLength(4141);
    expect(channels[0].xover).toBe(80);
    expect(channels[1].xover).toBeUndefined();
  });

  it('guards on missing AVR data and target curve', async () => {
    const { service } = makeService();
    await expect(
      service.generateChannels({ avrData: null, measurements: [], config: configFixture() }),
    ).rejects.toThrow('AVR data');
    await expect(
      service.generateChannels({
        avrData: avrDataFixture(),
        measurements: [],
        config: configFixture({ targetCurve: '' }),
      }),
    ).rejects.toThrow('Target curve');
  });
});

describe('buildCalibrationArchive', () => {
  it('requires both banks', () => {
    const { service } = makeService();
    expect(() =>
      service.buildCalibrationArchive({
        avrData: avrDataFixture(),
        measurements: [],
        config: configFixture(),
      }),
    ).toThrow('Both filter banks');
  });

  it('builds filterRef/filterFlat from the two banks with the root fields', async () => {
    const { service } = makeService();
    await loadBothBanks(service);

    const { archive, warnings } = service.buildCalibrationArchive({
      avrData: avrDataFixture(),
      measurements: [],
      config: configFixture(),
      liveStatus: { AmpAssign: '2chBiAmp', AssignBin: '0404AA' },
    });

    expect(warnings).toEqual([]);
    expect(archive.eqType).toBe(2);
    expect(archive.model).toBe('Denon AVC-A1H');
    expect(archive.title).toBe('e2e-sample');
    expect(archive.ifVersionMajor).toBe(0);
    expect(archive.ifVersionMinor).toBe(8);
    expect(archive.subwooferOutput).toBe('LFE+MAIN');
    expect(archive.bassMode).toBe('L+M');
    expect(archive.lpfForLFE).toBe(120);
    expect(archive.isNewModel).toBe(true);
    expect(archive.isGriffin).toBe(true);
    expect(archive.ampAssign).toBe('2chBiAmp');
    expect(archive.ampAssignBin).toBe('0404AA');
    expect(archive.enableDynamicEq).toBe(true);

    expect(archive.channels).toHaveLength(2);
    const fl = archive.channels[0];
    expect(fl.commandId).toBe('FL');
    expect(fl.xover).toBe(80);
    expect(fl.filterRefLength).toBeUndefined();
    expect(decodeBase64ToFloat32(fl.filterRef, true)).toHaveLength(16321);
    expect(decodeBase64ToFloat32(fl.filterFlat, true)).toHaveLength(16321);
    const sw = archive.channels[1];
    expect(sw.xover).toBeUndefined();
    expect(decodeBase64ToFloat32(sw.filterRef, true)).toHaveLength(16055);
  });

  it('accepts a 70 Hz crossover and rejects out-of-domain values', async () => {
    const { service, banks } = makeService();
    await loadBothBanks(service);

    const patchBanks = xover => {
      for (const bank of ['reference', 'flat']) {
        banks.get(bank).channels[0].xover = xover;
      }
    };

    patchBanks(70);
    expect(() =>
      service.buildCalibrationArchive({
        avrData: avrDataFixture(),
        measurements: [],
        config: configFixture(),
      }),
    ).not.toThrow();

    patchBanks(65);
    expect(() =>
      service.buildCalibrationArchive({
        avrData: avrDataFixture(),
        measurements: [],
        config: configFixture(),
      }),
    ).toThrow(/outside the AVR domain/);
  });

  it('rejects filter lengths that do not match FR-062', async () => {
    const { service, banks } = makeService();
    await loadBothBanks(service);
    banks.get('flat').channels[0].filter = [1, 2, 3];

    expect(() =>
      service.buildCalibrationArchive({
        avrData: avrDataFixture(),
        measurements: [],
        config: configFixture(),
      }),
    ).toThrow(/FR-062/);
  });

  it('warns when the current state drifted from the saved banks', async () => {
    const { service } = makeService();
    await loadBothBanks(service);

    const driftedItem = {
      channelName: () => 'FL',
      speakerType: () => 'S',
      distanceInMeters: () => 3.5,
      trimAdjustmentInDbs: () => -9,
      splForAvr: () => -9,
      crossover: () => 80,
      isSub: () => false,
    };

    const { warnings } = service.buildCalibrationArchive({
      avrData: avrDataFixture(),
      measurements: [driftedItem],
      config: configFixture(),
    });

    expect(warnings.join(' ')).toContain('stale');
  });
});

describe('transfer flow', () => {
  it('polls until the terminal state and forwards statuses', async () => {
    const bridgeSession = makeBridgeSession({
      getTransfer: vi
        .fn()
        .mockResolvedValueOnce({ state: 'in-progress', progress: 40, currentChannel: 'FL' })
        .mockResolvedValueOnce({ state: 'completed', progress: 100, succeededChannels: ['FL', 'SW1'] }),
    });
    const { service } = makeService({ bridgeSession });
    const statuses = [];

    const finalStatus = await service.runTransfer(
      { eqType: 2, channels: [] },
      { onStatus: status => statuses.push(status.state), pollIntervalMs: 1 },
    );

    expect(finalStatus.state).toBe('completed');
    expect(statuses).toEqual(['in-progress', 'in-progress', 'completed']);
    expect(bridgeSession.api.startTransfer).toHaveBeenCalled();
  });

  it('keeps polling through a deferred cancellation', async () => {
    const bridgeSession = makeBridgeSession({
      getTransfer: vi
        .fn()
        .mockResolvedValueOnce({ state: 'in-progress', progress: 90 })
        .mockResolvedValueOnce({ state: 'cancelled', cancelled: true }),
    });
    const { service } = makeService({ bridgeSession });

    const finalStatus = await service.runTransfer(
      { eqType: 2, channels: [] },
      { pollIntervalMs: 1 },
    );

    expect(finalStatus.state).toBe('cancelled');
  });

  it('exposes validate, live status and cancel passthroughs', async () => {
    const { service, bridgeSession } = makeService();

    await expect(service.validateArchive({})).resolves.toEqual({ valid: true });
    await expect(service.fetchLiveStatus()).resolves.toEqual({
      AmpAssign: '2chBiAmp',
      AssignBin: '0404',
    });
    await expect(service.cancelTransfer()).resolves.toEqual({ cancelled: true });
    expect(bridgeSession.assertConnected).toHaveBeenCalled();
  });
});
