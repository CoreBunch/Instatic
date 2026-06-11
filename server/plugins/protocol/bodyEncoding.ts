/**
 * Byte-safe body encoding for the host⇄worker⇄VM wire format.
 *
 * Every HTTP body crossing the sandbox boundary — outbound fetch requests
 * and responses, plugin route requests and responses — is carried as a
 * `body` string plus a `bodyEncoding` tag:
 *
 *   - `'utf8'`   — `body` IS the text. The cheap, readable case for the
 *                  all-text payloads that dominate plugin traffic.
 *   - `'base64'` — `body` is the base64 encoding of the raw bytes. Used
 *                  whenever the payload is not valid UTF-8 (images, gzip,
 *                  protobuf, …) or originated as binary on the sending side.
 *
 * `encodeBodyBytes` picks the encoding: if the bytes round-trip through a
 * fatal UTF-8 decode they are sent as text (a fatal decoder rejects overlong
 * encodings and lone surrogates, so decode-success guarantees re-encoding
 * yields the identical bytes); anything else goes base64. `decodeBodyBytes`
 * is the exact inverse. Base64 strings survive every hop losslessly —
 * `postMessage`, `JSON.stringify`, and the QuickJS `ctx.dump`/handle
 * marshalling all carry plain strings byte-exactly.
 *
 * The base64 helpers also back the crypto bridge (`crypto.digest` /
 * `crypto.signHmac`), which moves raw bytes the same way.
 *
 * Both helpers run in the Bun host process / Bun plugin worker, so they use
 * native `Buffer` base64 — an order of magnitude faster than a per-byte JS
 * loop on multi-MB bodies. The QuickJS VM has its own pure-JS shim
 * (`quickjs/bootstrap/base64.ts`, no Buffer in the sandbox); the two
 * produce bit-identical output.
 */

export type BodyEncoding = 'utf8' | 'base64'

export function bytesToBase64(bytes: Uint8Array): string {
  // Buffer.from(buffer, offset, length) wraps the existing bytes without
  // copying; toString('base64') encodes them natively.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * Decode base64 into a fresh, tightly-sized `Uint8Array`. The fresh
 * allocation guarantees `.buffer` has no sibling view past `byteLength`,
 * so callers can hand it to `BufferSource`-typed APIs (Web Crypto,
 * `Response`) without slicing.
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  // Buffer.from(b64, 'base64') decodes natively but may live in Bun's
  // shared Buffer pool (an ArrayBuffer with sibling views) — copy into a
  // fresh ArrayBuffer to uphold the no-sibling-view guarantee above.
  const decoded = Buffer.from(base64, 'base64')
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  bytes.set(decoded)
  return bytes
}

/** Fatal decoder — throws on any byte sequence that is not valid UTF-8. */
const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()

/**
 * Serialize raw bytes for the wire: UTF-8 text passes through readable and
 * cheap, anything else is base64. See the module doc for why a successful
 * fatal decode guarantees a byte-exact round trip.
 */
export function encodeBodyBytes(bytes: Uint8Array): { body: string; bodyEncoding: BodyEncoding } {
  try {
    return { body: strictUtf8Decoder.decode(bytes), bodyEncoding: 'utf8' }
  } catch {
    return { body: bytesToBase64(bytes), bodyEncoding: 'base64' }
  }
}

/** Exact inverse of `encodeBodyBytes`. */
export function decodeBodyBytes(body: string, bodyEncoding: BodyEncoding): Uint8Array<ArrayBuffer> {
  // `TextEncoder.encode` allocates a fresh, tightly-sized buffer (spec'd),
  // so both branches uphold the no-sibling-view guarantee from
  // `base64ToBytes`.
  return bodyEncoding === 'base64' ? base64ToBytes(body) : utf8Encoder.encode(body)
}
