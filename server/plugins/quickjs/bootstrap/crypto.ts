/**
 * WebCrypto-compatible crypto shim evaluated inside every plugin QuickJS VM.
 *
 * Exposed surface: crypto.subtle.digest, crypto.subtle.importKey (raw HMAC),
 * crypto.subtle.sign (HMAC), plus crypto.getRandomValues and
 * crypto.randomUUID. Digest/HMAC bytes cross the host bridge as base64
 * strings via __hostCall('crypto.digest') / __hostCall('crypto.signHmac');
 * entropy uses the synchronous __hostRandomBytes bridge instead, because
 * getRandomValues is synchronous by spec and __hostCall returns a Promise.
 */

/**
 * Per-call entropy ceiling, shared by the VM shim and the host function so
 * both agree on one bound. Matches the WebCrypto quota for
 * `crypto.getRandomValues`, which throws QuotaExceededError above 65536 bytes.
 */
export const CRYPTO_RANDOM_BYTES_MAX = 65536

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

/**
 * CSPRNG shim — `crypto.getRandomValues` and `crypto.randomUUID`.
 *
 * Must be evaluated after BASE64_SHIM (uses `__base64ToBytes`) and it augments
 * whatever `globalThis.crypto` already exists rather than replacing it, so the
 * ordering against CRYPTO_SUBTLE_SHIM does not matter.
 *
 * Without this, `Math.random` and `Date` were the only entropy in the sandbox,
 * so a plugin minting a bearer token, nonce, invitation code or one-time link
 * had no safe way to do it on the server.
 */
export const CRYPTO_RANDOM_SHIM = `// ------- crypto.getRandomValues / crypto.randomUUID -------------------------
// Entropy comes from the host's CSPRNG through the SYNCHRONOUS
// __hostRandomBytes bridge (base64 in, bytes out). getRandomValues is
// synchronous by spec, so it cannot use the Promise-returning __hostCall the
// digest/HMAC paths use.
var __CRYPTO_RANDOM_MAX = ${CRYPTO_RANDOM_BYTES_MAX};

// QuickJS has no DOMException, so carry the spec's error \`name\` on a plain
// Error. Plugins that branch on err.name still behave the same.
function __cryptoNamedError(name, message) {
  var err = new Error(message);
  err.name = name;
  return err;
}

// getRandomValues accepts only integer-typed views. Float and non-typed views
// are a TypeMismatchError per spec. Named rather than instanceof-checked so a
// missing BigInt64Array in the engine degrades to "unsupported", not a crash.
var __CRYPTO_INTEGER_VIEWS = [
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array',
  'BigInt64Array', 'BigUint64Array',
];

function __cryptoRandomBytes(count) {
  if (count <= 0) return new Uint8Array(0);
  return __base64ToBytes(__hostRandomBytes(count));
}

globalThis.crypto = globalThis.crypto || {};

globalThis.crypto.getRandomValues = function getRandomValues(array) {
  if (!array || typeof array !== 'object' || !ArrayBuffer.isView(array)) {
    throw __cryptoNamedError('TypeMismatchError', 'getRandomValues expects an integer-typed TypedArray.');
  }
  var kind = array.constructor && array.constructor.name;
  if (__CRYPTO_INTEGER_VIEWS.indexOf(kind) < 0) {
    throw __cryptoNamedError('TypeMismatchError', 'getRandomValues does not support ' + String(kind) + '.');
  }
  if (array.byteLength > __CRYPTO_RANDOM_MAX) {
    throw __cryptoNamedError(
      'QuotaExceededError',
      'getRandomValues supports at most ' + __CRYPTO_RANDOM_MAX + ' bytes per call.',
    );
  }
  if (array.byteLength === 0) return array;
  // Fill through a byte view so the element width of the caller's array is
  // irrelevant — the spec fills the underlying bytes.
  var bytes = __cryptoRandomBytes(array.byteLength);
  new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
  return array;
};

var __CRYPTO_HEX = '0123456789abcdef';

globalThis.crypto.randomUUID = function randomUUID() {
  var b = __cryptoRandomBytes(16);
  // RFC 9562 §5.4: version 4 in the high nibble of octet 6, variant 10 in the
  // top two bits of octet 8.
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var out = '';
  for (var i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += __CRYPTO_HEX[b[i] >> 4] + __CRYPTO_HEX[b[i] & 0x0f];
  }
  return out;
};

`
