const NATIVE_LITTLE_ENDIAN = new Uint8Array(new Float32Array([1]).buffer)[0] === 0;
const BASE64_CHUNK_SIZE = 0x8000;

function binaryStringToBytes(binaryString) {
  const bytes = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index++) {
    bytes[index] = binaryString.codePointAt(index) ?? 0;
  }
  return bytes;
}

function bytesToBase64(bytes) {
  const chunkCount = Math.ceil(bytes.length / BASE64_CHUNK_SIZE);
  const chunks = new Array(chunkCount);
  for (
    let chunkIndex = 0, offset = 0;
    offset < bytes.length;
    chunkIndex++, offset += BASE64_CHUNK_SIZE
  ) {
    const end = Math.min(offset + BASE64_CHUNK_SIZE, bytes.length);
    chunks[chunkIndex] = String.fromCodePoint(...bytes.subarray(offset, end));
  }
  return btoa(chunks.join(''));
}

function decodeBase64ToFloat32(base64String, isLittleEndian = false) {
  if (typeof base64String !== 'string') {
    throw new TypeError('Base64 input must be a string');
  }
  try {
    const binaryString = atob(base64String);
    const bytes = binaryStringToBytes(binaryString);
    if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error('Float32 payload byte length must be a multiple of 4');
    }
    if (isLittleEndian === NATIVE_LITTLE_ENDIAN) {
      return new Float32Array(bytes.buffer);
    }
    const view = new DataView(bytes.buffer);
    const sampleCount = view.byteLength / Float32Array.BYTES_PER_ELEMENT;
    const floats = new Float32Array(sampleCount);
    for (let index = 0; index < sampleCount; index++) {
      floats[index] = view.getFloat32(
        index * Float32Array.BYTES_PER_ELEMENT,
        isLittleEndian,
      );
    }
    return floats;
  } catch (error) {
    throw new Error(`Error decoding base64 data: ${error.message}`, { cause: error });
  }
}

function encodeFloat32ToBase64(floatArray, isLittleEndian = false) {
  if (!(floatArray instanceof Float32Array)) {
    throw new TypeError('Input must be a Float32Array');
  }
  try {
    if (isLittleEndian === NATIVE_LITTLE_ENDIAN) {
      const bytes = new Uint8Array(
        floatArray.buffer,
        floatArray.byteOffset,
        floatArray.byteLength,
      );
      return bytesToBase64(bytes);
    }

    const buffer = new ArrayBuffer(floatArray.length * Float32Array.BYTES_PER_ELEMENT);
    const view = new DataView(buffer);
    for (let index = 0; index < floatArray.length; index++) {
      view.setFloat32(
        index * Float32Array.BYTES_PER_ELEMENT,
        floatArray[index],
        isLittleEndian,
      );
    }
    return bytesToBase64(new Uint8Array(buffer));
  } catch (error) {
    throw new Error(`Error encoding data to base64: ${error.message}`, {
      cause: error,
    });
  }
}

export { decodeBase64ToFloat32, encodeFloat32ToBase64 };

export const codecStatics = {
  decodeBase64ToFloat32,
  encodeFloat32ToBase64,
};
