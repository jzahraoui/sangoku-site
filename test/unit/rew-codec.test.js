/**
 * Contrats de conversion float32/Base64 du point central REW (rew-codec.js).
 *
 * Couvre FR-024a (rejet des payloads incohérents) et FR-026b1 (validation sur
 * données de référence connues + non-régression du round-trip float32) de
 * work/docs/spec.md. REW transporte ses tableaux en float32 big-endian.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBase64ToFloat32,
  encodeFloat32ToBase64,
} from '../../src/rew/rew-codec.js';

// [1.0, -2.5, pi(f32)] en IEEE-754 float32
const REFERENCE_VALUES = [1.0, -2.5, 3.1415927410125732];
const REFERENCE_BASE64_BE = 'P4AAAMAgAABASQ/b';
const REFERENCE_BASE64_LE = 'AACAPwAAIMDbD0lA';

describe('rew-codec — contrat float32/Base64', () => {
  it('décode le vecteur de référence big-endian (défaut REW)', () => {
    const decoded = decodeBase64ToFloat32(REFERENCE_BASE64_BE);
    expect(Array.from(decoded)).toEqual(REFERENCE_VALUES);
  });

  it('décode le vecteur de référence little-endian sur demande', () => {
    const decoded = decodeBase64ToFloat32(REFERENCE_BASE64_LE, true);
    expect(Array.from(decoded)).toEqual(REFERENCE_VALUES);
  });

  it('encode le vecteur de référence vers le même Base64 big-endian', () => {
    const encoded = encodeFloat32ToBase64(Float32Array.from(REFERENCE_VALUES));
    expect(encoded).toBe(REFERENCE_BASE64_BE);
  });

  it('round-trip encode→decode préserve exactement le domaine float32', () => {
    const source = new Float32Array(1024);
    for (let i = 0; i < source.length; i++) {
      source[i] = Math.fround(Math.sin(i / 7) * 10 ** ((i % 9) - 4));
    }
    source[0] = 0;
    source[1] = -0;
    source[2] = Number.MAX_VALUE; // → Infinity en float32
    source[3] = 1.401298464324817e-45; // plus petit dénormal float32

    for (const isLittleEndian of [false, true]) {
      const decoded = decodeBase64ToFloat32(
        encodeFloat32ToBase64(source, isLittleEndian),
        isLittleEndian,
      );
      expect(decoded).toHaveLength(source.length);
      // Comparaison bit à bit : le round-trip ne doit altérer aucun octet.
      const sourceBytes = new Uint8Array(source.buffer);
      const decodedBytes = new Uint8Array(decoded.buffer);
      expect(decodedBytes).toEqual(sourceBytes);
    }
  });

  it('rejette un payload dont la longueur n’est pas un multiple de 4 octets', () => {
    // 5 octets encodés
    const invalid = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
    expect(() => decodeBase64ToFloat32(invalid)).toThrow(/multiple of 4/);
  });

  it('rejette un Base64 invalide avec un message explicite', () => {
    expect(() => decodeBase64ToFloat32('%%%invalid%%%')).toThrow(
      /Error decoding base64 data/,
    );
  });

  it('rejette les entrées non-string au décodage et non-Float32Array à l’encodage', () => {
    expect(() => decodeBase64ToFloat32(null)).toThrow(TypeError);
    expect(() => encodeFloat32ToBase64([1, 2, 3])).toThrow(TypeError);
  });

  it('préserve un Float32Array vu à travers un byteOffset non nul', () => {
    const backing = new Float32Array([9, 1.5, -4.25, 8]);
    const view = new Float32Array(backing.buffer, 4, 2); // [1.5, -4.25]
    const decoded = decodeBase64ToFloat32(encodeFloat32ToBase64(view));
    expect(Array.from(decoded)).toEqual([1.5, -4.25]);
  });
});
