import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/oca-file.js', () => ({
  default: class FakeOcaFileGenerator {
    static lastInstance = null;

    // Canaux que le faux générateur déclarera avoir traités (BW12 cuit) au
    // prochain createOCAFile — même contrat que le vrai générateur.
    static bakedChannels = [];

    constructor(avrData) {
      this.avrData = avrData;
      this.electricalHighPassChannels = [];
      FakeOcaFileGenerator.lastInstance = this;
    }

    async createOCAFile(measurements) {
      this.measurements = measurements;
      this.electricalHighPassChannels = FakeOcaFileGenerator.bakedChannels;
      return JSON.stringify({ ok: true });
    }
  },
}));

const { createExportsService } = await import('../../src/services/exports.js');
const { default: FakeOcaFileGenerator } = await import('../../src/oca-file.js');

const exportsService = createExportsService();

const TIMESTAMP_PATTERN = String.raw`\d{4}-\d{2}-\d{2}-\d{2}-\d{2}`;

describe('generateOcaExport', () => {
  const config = {
    targetCurve: 'harman',
    fileFormat: 'odd',
    tcName: 'Harman',
    softRoll: false,
    enableDynamicEq: true,
    dynamicEqRefLevel: 0,
    enableDynamicVolume: false,
    dynamicVolumeSetting: 'Off',
    enableLowFrequencyContainment: false,
    lowFrequencyContainmentLevel: 3,
    subwooferOutput: 'LFE',
    lpfForLFE: 120,
    numberOfSubwoofers: 2,
    currentVersion: '1.2.51',
  };

  it('requires the AVR data and the target curve', async () => {
    await expect(
      exportsService.generateOcaExport({ avrData: {}, measurements: [], config }),
    ).rejects.toThrow('Please load avr file first');

    await expect(
      exportsService.generateOcaExport({
        avrData: { targetModelName: 'X' },
        measurements: [],
        config: { ...config, targetCurve: '' },
      }),
    ).rejects.toThrow('Target curve not found');
  });

  it('configures the generator and names the file from the config', async () => {
    const measurements = [{ hasErrors: () => false }];

    const { filename, blob } = await exportsService.generateOcaExport({
      avrData: { targetModelName: 'Denon X3800H' },
      measurements,
      config,
    });

    const generator = FakeOcaFileGenerator.lastInstance;
    expect(generator.fileFormat).toBe('odd');
    expect(generator.tcName).toBe('Harman');
    expect(generator.numberOfSubwoofers).toBe(2);
    expect(generator.versionEvo).toBe('RCH 1.2.51');
    expect(generator.measurements).toBe(measurements);

    expect(filename).toMatch(
      new RegExp(`^${TIMESTAMP_PATTERN}_odd_harman_Denon-X3800H\\.oca$`),
    );
    expect(JSON.parse(await blob.text())).toEqual({ ok: true });
  });

  it('logs the BW12 bake from what the generator actually processed', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const service = createExportsService({ log });
    FakeOcaFileGenerator.bakedChannels = [{ channelName: 'FL', crossover: 40 }];

    try {
      await service.generateOcaExport({
        avrData: {
          targetModelName: 'Denon X3800H',
          // FIR enceinte de 704/48000 ≈ 14.7 ms (< 50 ms) + fc 40 Hz (< 60)
          // → le warn de troncature doit sortir, alimenté par la même liste.
          avr: { multEQSpecs: { speakerFilter: { samples: 704, frequency: 48000 } } },
        },
        measurements: [{ hasErrors: () => false }],
        config,
      });
    } finally {
      FakeOcaFileGenerator.bakedChannels = [];
    }

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('FL@40Hz'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });
});

describe('generateSettingsReport', () => {
  const settings = {
    loadedFileName: 'session.ady',
    targetCurve: 'harman',
    mainTargetLevel: 75,
    selectedAverageMethod: 'Vector average',
    selectedSmoothingMethod: '1/6',
    selectedIrWindows: 'Optimized MTW',
    selectedRoomCurve: 'None',
    individualMaxBoostValue: 3,
    overallBoostValue: 0,
    numberOfSubwoofers: 1,
    revertLfeFrequency: 0,
    maxBoostIndividualValue: 6,
    maxBoostOverallValue: 3,
    selectedSpeakerCrossover: 80,
    selectedSpeakerText: '1: FL_P01',
    lpfForLFE: 120,
    subwooferOutput: 'LFE',
    enableDynamicEq: false,
    dynamicEqRefLevel: 0,
    enableDynamicVolume: false,
    dynamicVolumeSetting: 'Off',
    enableLowFrequencyContainment: false,
    lowFrequencyContainmentLevel: 3,
    rewVersion: '5.40',
    currentVersion: '1.2.51',
  };

  const reducedMeasurements = [
    {
      displayMeasurementTitle: '1: FL_P01',
      channelName: 'FL',
      distance: 3.42,
      splOffset: 0,
      splForAvr: -1.5,
      crossover: 80,
      inverted: false,
    },
  ];

  it('renders the report and names the file from curve and model', async () => {
    const { filename, blob } = exportsService.generateSettingsReport({
      avrData: {
        targetModelName: 'Denon X3800H',
        avr: { multEQType: 'XT32', hasCirrusLogicDsp: false, speedOfSound: 343 },
      },
      settings,
      reducedMeasurements,
    });

    expect(filename).toMatch(new RegExp(`^${TIMESTAMP_PATTERN}_harman_Denon-X3800H\\.txt$`));

    const text = await blob.text();
    expect(text).toContain('Loaded File:       session.ady');
    expect(text).toContain('Revert LFE Filter Freq:   None');
    expect(text).toContain('Align Frequency:          80 Hz');
    expect(text).toContain('| 1: FL_P01              | FL            |     3.42 |');
  });
});

describe('MSO export', () => {
  function fakeSub(channel, position, freqs, magnitude, phase) {
    return {
      channelName: () => channel,
      position: () => position,
      resetAll: vi.fn().mockResolvedValue(undefined),
      applyWorkingSettings: vi.fn().mockResolvedValue(undefined),
      getFrequencyResponse: vi.fn().mockResolvedValue({ freqs, magnitude, phase }),
    };
  }

  it('appendMsoMeasurement writes the in-range response into the zip', async () => {
    const jszip = { file: vi.fn() };
    const sub = fakeSub('SW1', 2, [2, 20, 500], [70, 75, 60], [0.1, 0.2, 0.3]);

    await exportsService.appendMsoMeasurement(jszip, sub, {
      minFreq: 5,
      maxFreq: 400,
      targetLevel: 75,
    });

    expect(sub.resetAll).toHaveBeenCalledWith(75);
    expect(sub.applyWorkingSettings).toHaveBeenCalledOnce();
    expect(jszip.file).toHaveBeenCalledWith('POS2-SUB1.txt', '20.000000 75.000 0.2000');
  });

  it('appendMsoMeasurement rejects an empty frequency range', async () => {
    const jszip = { file: vi.fn() };
    const sub = fakeSub('SW1', 1, [500], [60], [0]);

    await expect(
      exportsService.appendMsoMeasurement(jszip, sub, {
        minFreq: 5,
        maxFreq: 400,
        targetLevel: 75,
      }),
    ).rejects.toThrow('no file content for POS1-SUB1.txt');
  });

  it('buildMsoExportZip bundles every sub into one archive', async () => {
    const subs = [
      fakeSub('SW1', 1, [20], [75], [0]),
      fakeSub('SW2', 1, [20], [74], [0]),
    ];

    const { filename, blob } = await exportsService.buildMsoExportZip(subs, {
      model: 'X3800H',
      targetLevel: 75,
    });

    expect(filename).toBe('MSO-X3800H.zip');
    expect(blob.size).toBeGreaterThan(0);
    for (const sub of subs) {
      expect(sub.getFrequencyResponse).toHaveBeenCalledOnce();
    }
  });
});

describe('importMsoConfig', () => {
  it('imports position groups and notifies each success', async () => {
    const importFilterInREW = vi.fn().mockResolvedValue(undefined);
    const onPositionImported = vi.fn();
    const groupedSubs = {
      1: [{ displayMeasurementTitle: () => 'SW1_P01' }],
      2: [],
      3: [{ displayMeasurementTitle: () => 'SW1_P03' }],
    };

    await exportsService.importMsoConfig({ eq: [] }, groupedSubs, importFilterInREW, {
      onPositionImported,
    });

    expect(importFilterInREW).toHaveBeenCalledTimes(2);
    expect(importFilterInREW).toHaveBeenCalledWith({ eq: [] }, groupedSubs[1]);
    expect(onPositionImported).toHaveBeenCalledWith('1');
    expect(onPositionImported).toHaveBeenCalledWith('3');
    expect(onPositionImported).not.toHaveBeenCalledWith('2');
  });
});
