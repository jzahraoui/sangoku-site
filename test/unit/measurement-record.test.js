import { describe, expect, it, vi } from 'vitest';
import MeasurementRecord from '../../src/measurement/measurement-record.js';

function apiItem(overrides = {}) {
  return {
    uuid: 'uuid-1',
    title: 'Front Left',
    notes: '',
    date: '2026-07-04',
    startFreq: 20,
    endFreq: 20000,
    inverted: false,
    rewVersion: '5.40',
    sampleRate: 48000,
    splOffsetdB: 12.5,
    alignSPLOffsetdB: 2.5,
    cumulativeIRShiftSeconds: 0.001,
    clockAdjustmentPPM: 0,
    timeOfIRStartSeconds: -0.1,
    timeOfIRPeakSeconds: 0.002,
    ...overrides,
  };
}

describe('MeasurementRecord constructor', () => {
  it('stores flat fields with the historical defaults', () => {
    const record = new MeasurementRecord(apiItem());

    expect(record.uuid).toBe('uuid-1');
    expect(record.title).toBe('Front Left');
    expect(record.sampleRate).toBe(48000);
    expect(record.haveImpulseResponse).toBe(true);
    expect(record.isFilter).toBe(false);
    expect(record.IRPeakValue).toBe(0);
    expect(record.revertLfeFrequency).toBe(0);
    expect(record.isSubOperationResult).toBe(false);
    expect(record.parentAttr).toBeNull();
    expect(record.shiftDelay).toBe(Infinity);
  });

  it('derives haveImpulseResponse from the presence of cumulativeIRShiftSeconds', () => {
    const withoutIr = { ...apiItem() };
    delete withoutIr.cumulativeIRShiftSeconds;

    expect(new MeasurementRecord(withoutIr).haveImpulseResponse).toBe(false);
    expect(new MeasurementRecord(apiItem()).haveImpulseResponse).toBe(true);
  });

  it('nullifies a non-finite sampleRate', () => {
    expect(new MeasurementRecord(apiItem({ sampleRate: 'x' })).sampleRate).toBeNull();
    expect(new MeasurementRecord(apiItem({ sampleRate: undefined })).sampleRate).toBeNull();
  });

  it('computes initialSplOffsetdB from SPL offsets rounded to 2 decimals', () => {
    const record = new MeasurementRecord(
      apiItem({ splOffsetdB: 12.5551, alignSPLOffsetdB: 2.5 }),
    );
    expect(record.initialSplOffsetdB).toBe(10.06);
  });

  it('preserves a saved initialSplOffsetdB of zero', () => {
    const record = new MeasurementRecord(apiItem({ initialSplOffsetdB: 0 }));
    expect(record.initialSplOffsetdB).toBe(0);
  });

  it('reports invalid initialSplOffsetdB inputs through onInvalidNumber', () => {
    const onInvalidNumber = vi.fn();
    const record = new MeasurementRecord(
      apiItem({ splOffsetdB: undefined, alignSPLOffsetdB: undefined }),
      { onInvalidNumber },
    );
    expect(record.initialSplOffsetdB).toBe(0);
    expect(onInvalidNumber).toHaveBeenCalledWith(NaN);
  });
});

describe('MeasurementRecord.update', () => {
  it('applies whitelisted fields and returns the changed ones', () => {
    const record = new MeasurementRecord(apiItem());

    const changed = record.update({
      title: 'Front Left renamed',
      splOffsetdB: 13,
      unknownField: 'ignored',
    });

    expect(changed).toEqual({ title: 'Front Left renamed', splOffsetdB: 13 });
    expect(record.title).toBe('Front Left renamed');
    expect(record.splOffsetdB).toBe(13);
    expect(record).not.toHaveProperty('unknownField');
  });

  it('skips undefined values and unchanged values', () => {
    const record = new MeasurementRecord(apiItem());

    expect(record.update({ title: undefined })).toEqual({});
    expect(record.update({ title: 'Front Left' })).toEqual({});
    expect(record.title).toBe('Front Left');
  });

  it('ignores a non-finite sampleRate', () => {
    const record = new MeasurementRecord(apiItem());
    expect(record.update({ sampleRate: NaN })).toEqual({});
    expect(record.sampleRate).toBe(48000);
  });

  it('promotes haveImpulseResponse when cumulativeIRShiftSeconds arrives', () => {
    const withoutIr = { ...apiItem() };
    delete withoutIr.cumulativeIRShiftSeconds;
    const record = new MeasurementRecord(withoutIr);

    const changed = record.update({ cumulativeIRShiftSeconds: 0.002 });

    expect(changed).toEqual({
      cumulativeIRShiftSeconds: 0.002,
      haveImpulseResponse: true,
    });
    expect(record.haveImpulseResponse).toBe(true);
  });

  it('coerces isFilter to a boolean', () => {
    const record = new MeasurementRecord(apiItem({ isFilter: true }));
    const changed = record.update({ isFilter: undefined });
    expect(changed).toEqual({ isFilter: false });
    expect(record.isFilter).toBe(false);
  });

  it('returns an empty object for a missing partial', () => {
    const record = new MeasurementRecord(apiItem());
    expect(record.update(null)).toEqual({});
  });

  it('absorbs sub-nanosecond float echoes from the polling merge', () => {
    const record = new MeasurementRecord(
      apiItem({ timeOfIRPeakSeconds: 0.003, cumulativeIRShiftSeconds: 0.001 }),
    );
    const handler = vi.fn();
    record.on('change', handler);

    // Poll echo of our own mirrored write: REW recomputes the peak a few µs
    // away after a fractional offsetTZero re-interpolation. Adopted silently.
    expect(
      record.update({
        timeOfIRPeakSeconds: 0.003 + 4.4e-6,
        cumulativeIRShiftSeconds: 0.001 - 5e-14,
      }),
    ).toEqual({});
    expect(handler).not.toHaveBeenCalled();
    expect(record.timeOfIRPeakSeconds).toBe(0.003 + 4.4e-6);

    // A real delta (one sample at 48 kHz ≈ 2e-5 s) is still a change.
    const changed = record.update({ timeOfIRPeakSeconds: 0.003 + 2.5e-5 });
    expect(changed).toEqual({ timeOfIRPeakSeconds: 0.003 + 2.5e-5 });
    expect(handler).toHaveBeenCalledTimes(1);

    // The tight tolerance stays on the other numeric fields.
    expect(record.update({ cumulativeIRShiftSeconds: 0.001 + 4.4e-6 })).toEqual({
      cumulativeIRShiftSeconds: 0.001 + 4.4e-6,
    });
  });
});

describe('MeasurementRecord events', () => {
  it('emits change with the changed fields and the record', () => {
    const record = new MeasurementRecord(apiItem());
    const onChange = vi.fn();
    record.on('change', onChange);

    record.update({ title: 'renamed', inverted: true });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ title: 'renamed', inverted: true }, record);
  });

  it('does not emit when nothing changed', () => {
    const record = new MeasurementRecord(apiItem());
    const onChange = vi.fn();
    record.on('change', onChange);

    record.update({ title: 'Front Left' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('supports off and the unsubscribe function returned by on', () => {
    const record = new MeasurementRecord(apiItem());
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = record.on('change', first);
    record.on('change', second);

    unsubscribeFirst();
    record.off('change', second);
    record.update({ title: 'renamed' });

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('does not emit on direct field assignment', () => {
    const record = new MeasurementRecord(apiItem());
    const onChange = vi.fn();
    record.on('change', onChange);

    record.isSubOperationResult = true;

    expect(onChange).not.toHaveBeenCalled();
    expect(record.isSubOperationResult).toBe(true);
  });
});

describe('MeasurementRecord.toJSON', () => {
  it('serializes the flat fields only', () => {
    const record = new MeasurementRecord(apiItem());
    const json = record.toJSON();

    expect(json).toMatchObject({
      uuid: 'uuid-1',
      title: 'Front Left',
      splOffsetdB: 12.5,
      alignSPLOffsetdB: 2.5,
      initialSplOffsetdB: 10,
      haveImpulseResponse: true,
      shiftDelay: Infinity,
    });
    expect(Object.values(json).some(value => typeof value === 'function')).toBe(false);
  });
});
