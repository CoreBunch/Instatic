/**
 * WebCrypto-compatible crypto.subtle shim evaluated inside every plugin
 * QuickJS VM.
 *
 * Exposed surface: crypto.subtle.digest, crypto.subtle.importKey (raw HMAC),
 * and crypto.subtle.sign (HMAC). Bytes cross the host bridge as base64
 * strings via __hostCall('crypto.digest') / __hostCall('crypto.signHmac').
 */

export const CRYPTO_SUBTLE_SHIM = `// ------- crypto.subtle — WebCrypto-compatible shim --------------------------
// Storage / auth plugins need SHA-256 + HMAC-SHA256 (AWS Sigv4, JWT signing,
// OAuth, presigned URLs). Without a host bridge they'd have to vendor a
// pure-JS HMAC implementation — possible but error-prone.
//
// Exposed surface (matches the WebCrypto spec subset every plugin actually
// uses):
//   • crypto.subtle.digest(algorithm, data) → Promise<ArrayBuffer>
//   • crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, extractable, ['sign'])
//       → Promise<CryptoKey>   // opaque handle wrapping raw bytes
//   • crypto.subtle.sign({ name: 'HMAC' }, key, data) → Promise<ArrayBuffer>
//
// Inputs accept any BufferSource (ArrayBuffer, Uint8Array, etc.) OR a
// string (UTF-8 encoded into bytes inside the shim — the most common
// caller shape for AWS canonical-request strings). Outputs are
// ArrayBuffer; callers wrap in Uint8Array as usual.
//
// Bytes cross the host bridge as base64-encoded strings (codec shared with
// fetch + the route runtime — see base64.ts, evaluated before this shim).
// Inputs are size-capped on the host (8 MB after decode); AWS signing
// strings are always < 4 KB so the cap is comfortable.
function __utf8Encode(str) {
  // QuickJS doesn't ship TextEncoder, but we only need UTF-8 of a
  // string we control here. Implementing the encoder inline keeps the
  // surface minimal — and the bytes get base64'd straight away.
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // Surrogate pair — combine with the next code unit.
      const next = str.charCodeAt(++i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (next & 0x3ff));
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

function __cryptoInputToBase64(input) {
  if (typeof input === 'string') return __bytesToBase64(__utf8Encode(input));
  if (input instanceof Uint8Array) return __bytesToBase64(input);
  if (input instanceof ArrayBuffer) return __bytesToBase64(new Uint8Array(input));
  if (input && typeof input === 'object' && input.buffer instanceof ArrayBuffer) {
    // TypedArray view (Int8Array / DataView / etc.). Slice into a
    // fresh Uint8Array so we don't accidentally read past byteLength.
    return __bytesToBase64(new Uint8Array(
      input.buffer.slice(input.byteOffset || 0, (input.byteOffset || 0) + input.byteLength),
    ));
  }
  throw new TypeError('Crypto input must be a string, ArrayBuffer, or BufferSource');
}

function __cryptoNormalizeAlgorithm(algorithm) {
  if (typeof algorithm === 'string') return algorithm;
  if (algorithm && typeof algorithm === 'object' && typeof algorithm.name === 'string') return algorithm.name;
  throw new TypeError('Crypto algorithm must be a string or { name } object');
}

function __cryptoNormalizeHash(hash) {
  if (typeof hash === 'string') return hash;
  if (hash && typeof hash === 'object' && typeof hash.name === 'string') return hash.name;
  throw new TypeError("Hash algorithm must be a string or { name } object");
}

const __CRYPTO_SUPPORTED_HASHES = ['SHA-256', 'SHA-1', 'SHA-512'];

globalThis.crypto = globalThis.crypto || {};
globalThis.crypto.subtle = {
  digest: async function digest(algorithm, data) {
    const name = __cryptoNormalizeAlgorithm(algorithm);
    if (__CRYPTO_SUPPORTED_HASHES.indexOf(name) < 0) {
      throw new Error('Unsupported digest algorithm: ' + name);
    }
    const base64 = __cryptoInputToBase64(data);
    const resultBase64 = await __hostCall('crypto.digest', [{ algorithm: name, data: base64 }]);
    const bytes = __base64ToBytes(String(resultBase64));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  importKey: async function importKey(format, keyData, algorithm, _extractable, keyUsages) {
    if (format !== 'raw') {
      throw new TypeError("Only 'raw' key format is supported in this sandbox.");
    }
    const algoName = __cryptoNormalizeAlgorithm(algorithm);
    if (algoName !== 'HMAC') {
      throw new TypeError("Only HMAC keys are supported in this sandbox.");
    }
    const hashName = __cryptoNormalizeHash(algorithm && algorithm.hash);
    if (__CRYPTO_SUPPORTED_HASHES.indexOf(hashName) < 0) {
      throw new Error('Unsupported HMAC hash: ' + hashName);
    }
    if (!Array.isArray(keyUsages) || keyUsages.indexOf('sign') < 0) {
      throw new TypeError("HMAC importKey requires usages to include 'sign'.");
    }
    return {
      __cryptoKey: true,
      type: 'secret',
      algorithm: { name: 'HMAC', hash: { name: hashName } },
      extractable: false,
      usages: ['sign'],
      __raw: __cryptoInputToBase64(keyData),
    };
  },
  sign: async function sign(algorithm, key, data) {
    if (!key || !key.__cryptoKey) {
      throw new TypeError('Sign requires a CryptoKey returned by importKey.');
    }
    const algoName = __cryptoNormalizeAlgorithm(algorithm);
    if (algoName !== 'HMAC') {
      throw new TypeError('Only HMAC signing is supported in this sandbox.');
    }
    const dataBase64 = __cryptoInputToBase64(data);
    const sigBase64 = await __hostCall('crypto.signHmac', [{
      hash: key.algorithm.hash.name,
      key: key.__raw,
      data: dataBase64,
    }]);
    const bytes = __base64ToBytes(String(sigBase64));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
};

`
