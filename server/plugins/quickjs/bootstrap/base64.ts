/**
 * Shared base64 codec evaluated inside every plugin QuickJS VM.
 *
 * Base64 is the wire format for every binary payload crossing the sandbox
 * boundary — crypto bridge inputs/outputs, fetch request/response bodies,
 * route request bodies, multipart file fields, and binary route responses.
 * One implementation, defined before the shims that use it (crypto, fetch)
 * and the bundled runtime (`src/pluginRuntime.ts`, which reaches it via the
 * `__bytesToBase64` / `__base64ToBytes` globals declared in
 * `src/globals.d.ts`).
 */

export const BASE64_SHIM = `// ------- base64 codec — shared by crypto, fetch, and the route runtime ------
const __B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __bytesToBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += __B64_CHARS[(triplet >> 18) & 0x3f]
      + __B64_CHARS[(triplet >> 12) & 0x3f]
      + __B64_CHARS[(triplet >> 6) & 0x3f]
      + __B64_CHARS[triplet & 0x3f];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const a = bytes[i];
    out += __B64_CHARS[a >> 2] + __B64_CHARS[(a << 4) & 0x3f] + '==';
  } else if (rem === 2) {
    const a = bytes[i];
    const b = bytes[i + 1];
    out += __B64_CHARS[a >> 2]
      + __B64_CHARS[((a << 4) | (b >> 4)) & 0x3f]
      + __B64_CHARS[(b << 2) & 0x3f]
      + '=';
  }
  return out;
}

const __B64_DECODE = new Uint8Array(128);
for (let i = 0; i < __B64_CHARS.length; i++) __B64_DECODE[__B64_CHARS.charCodeAt(i)] = i;

function __base64ToBytes(base64) {
  // Strip trailing '=' padding for the length computation but tolerate
  // its presence on input (we just stop at the first '=').
  let padded = base64;
  while (padded.length % 4 !== 0) padded += '=';
  const padCount = (padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0);
  const byteLength = (padded.length * 3) / 4 - padCount;
  const out = new Uint8Array(byteLength);
  let o = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const a = __B64_DECODE[padded.charCodeAt(i)] || 0;
    const b = __B64_DECODE[padded.charCodeAt(i + 1)] || 0;
    const c = padded.charCodeAt(i + 2) === 0x3d ? 0 : (__B64_DECODE[padded.charCodeAt(i + 2)] || 0);
    const d = padded.charCodeAt(i + 3) === 0x3d ? 0 : (__B64_DECODE[padded.charCodeAt(i + 3)] || 0);
    out[o++] = (a << 2) | (b >> 4);
    if (o < byteLength) out[o++] = ((b << 4) & 0xff) | (c >> 2);
    if (o < byteLength) out[o++] = ((c << 6) & 0xff) | d;
  }
  return out;
}

`
