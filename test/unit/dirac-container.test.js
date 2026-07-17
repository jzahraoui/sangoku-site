import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createByteView,
  u32be,
  readFloat64BEArray,
  readUtf16beString,
  utf16beNeedle,
  indexOfBytes,
} from '../../src/dirac/binary-reader.js';
import { readVarint, walkMessage } from '../../src/dirac/protobuf.js';
import { parseLiveproject } from '../../src/dirac/liveproject-container.js';
import { extractRecordings } from '../../src/dirac/protobuf.js';
import { codeForLabel, channelInfoForLabel } from '../../src/dirac/channel-codes.js';

// ---- Self-contained primitives (always run) -------------------------------

describe('binary-reader', () => {
  it('reads big-endian u32 and float64 arrays', () => {
    const buf = new ArrayBuffer(20);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x12345678, false);
    dv.setFloat64(4, 1.5, false);
    dv.setFloat64(12, -2.25, false);
    const { view } = createByteView(buf);
    expect(u32be(view, 0)).toBe(0x12345678);
    expect(Array.from(readFloat64BEArray(view, 4, 2))).toEqual([1.5, -2.25]);
  });

  it('round-trips a prefixed UTF-16BE string built from a needle', () => {
    const text = 'AVC-A1H';
    const body = utf16beNeedle(text);
    const buf = new Uint8Array(4 + body.length);
    new DataView(buf.buffer).setUint32(0, body.length, false);
    buf.set(body, 4);
    const { bytes, view } = createByteView(buf);
    const s = readUtf16beString(view, bytes, 0);
    expect(s.text).toBe(text);
    expect(s.next).toBe(4 + body.length);
  });

  it('rejects odd-length or oversized prefixed strings', () => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, 3, false); // odd byte length
    const { bytes, view } = createByteView(buf);
    expect(readUtf16beString(view, bytes, 0)).toBeNull();
  });

  it('finds a byte subsequence', () => {
    const hay = Uint8Array.of(0, 1, 2, 0x12, 0x34, 0x56, 0x78, 9);
    expect(indexOfBytes(hay, Uint8Array.of(0x12, 0x34, 0x56, 0x78))).toBe(3);
    expect(indexOfBytes(hay, Uint8Array.of(0xff))).toBe(-1);
  });
});

describe('protobuf', () => {
  it('reads single and multi-byte varints', () => {
    expect(readVarint(Uint8Array.of(0x2a), 0)).toEqual({ value: 42, next: 1 });
    expect(readVarint(Uint8Array.of(0xac, 0x02), 0)).toEqual({ value: 300, next: 2 });
  });

  it('walks fields of a hand-built message (varint + length-delimited)', () => {
    // field 3 (varint) = 42 ; field 13 (bytes) = "Ogg"
    const msg = Uint8Array.of(
      0x18, 0x2a, // (3<<3|0), 42
      0x6a, 0x03, 0x4f, 0x67, 0x67, // (13<<3|2), len 3, "Ogg"
    );
    const fields = [...walkMessage(msg, 0, msg.length)];
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ field: 3, wireType: 0, value: 42 });
    expect(fields[1]).toMatchObject({ field: 13, wireType: 2, value: 3 });
    expect(Array.from(msg.subarray(fields[1].payloadStart, fields[1].payloadEnd))).toEqual([0x4f, 0x67, 0x67]);
  });
});

describe('channel-codes', () => {
  it('maps Dirac speaker labels to AVR codes', () => {
    expect(codeForLabel('Front Left')).toBe('FL');
    expect(codeForLabel('Surround Back Right')).toBe('SBR');
    expect(codeForLabel('Surround Left')).toBe('SLA');
    expect(codeForLabel('Subwoofer 1')).toBe('SW1');
    expect(codeForLabel('Subwoofer 4')).toBe('SW4');
  });

  it('resolves a channel index alongside the code', () => {
    expect(channelInfoForLabel('Center')).toMatchObject({ code: 'C' });
    expect(channelInfoForLabel('Center').channelIndex).toBeTypeOf('number');
    expect(channelInfoForLabel('unknown speaker xyz')).toBeNull();
  });
});

// ---- Golden container assertions against the real ART sample --------------
// The .liveproject samples live outside the repo; skip when absent (CI).

const ART_PATH = path.resolve(process.cwd(), '../dirac/samples/AVC-A1H-ART.liveproject');
const hasArt = existsSync(ART_PATH);

describe.skipIf(!hasArt)('parseLiveproject on the ART golden sample', () => {
  const buf = hasArt ? readFileSync(ART_PATH) : null;

  it('extracts device metadata, channels, labels and codes', () => {
    const { meta } = parseLiveproject(buf);
    expect(meta.diracVersion).toBe('3.13.16');
    expect(meta.deviceVendor).toBe('Denon');
    expect(meta.deviceModel).toBe('AVC-A1H');
    expect(meta.positions).toEqual([0]);
    expect(meta.nch).toBe(15);
    expect(meta.channelLabels[0]).toBe('Front Left');
    expect(meta.channelCodes).toEqual([
      'FL', 'C', 'FR', 'SRA', 'SBR', 'SBL', 'SLA', 'FHR', 'RHR', 'RHL', 'FHL', 'SW1', 'SW2', 'SW3', 'SW4',
    ]);
  });

  it('extracts the embedded mic calibration', () => {
    const { meta } = parseLiveproject(buf);
    expect(meta.micCal.freqs).toHaveLength(607);
    expect(meta.micCal.freqs[0]).toBeCloseTo(10.1, 1);
  });

  it('extracts one recording with the SBR/SBL playback trims', () => {
    const recs = extractRecordings(buf);
    expect(recs).toHaveLength(1);
    expect(recs[0].ogg[0]).toBe(0x4f); // 'O' of OggS
    // channels 4 & 5 (SBR/SBL) played at -3 dB, others at 0
    expect(Array.from(recs[0].trims)).toEqual([0, 0, 0, 0, -3, -3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
