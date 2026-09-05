/**
 * Copy a `Uint8Array` (or any view/Buffer) into a freshly allocated,
 * exactly-sized, definite `ArrayBuffer`.
 *
 * Why the copy is necessary — a `Uint8Array` is only a *view*. Handing its
 * `.buffer` straight to a `Response`/`fetch` body or a worker `postMessage`
 * transfer is wrong on two counts:
 *
 *   1. **Oversized / shared backing store.** The view may start at a non-zero
 *      `byteOffset` and cover only part of a larger buffer (a slice, a pooled
 *      Node `Buffer`, a sub-view). The consumer would then see sibling bytes
 *      past the declared range, or take ownership of (and detach) memory that
 *      other views still reference.
 *   2. **Type widening.** `view.buffer` resolves to `ArrayBuffer |
 *      SharedArrayBuffer` under modern lib.dom types; body/transfer slots want
 *      a definite `ArrayBuffer`.
 *
 * Allocating a clean buffer of exactly `byteLength` and copying the logical
 * bytes (via `.set`, which respects the source's offset) sidesteps both. The
 * copy is cheap relative to the I/O it precedes (HTTP response, network upload,
 * cross-thread transfer).
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}

/**
 * Build a `Response` whose body is the bytes copied into a fresh `ArrayBuffer`
 * (see {@link toArrayBuffer} for why the copy is required). Convenience for the
 * common "serve raw bytes" path.
 */
export function binaryResponse(bytes: Uint8Array, init?: ResponseInit): Response {
  return new Response(toArrayBuffer(bytes), init)
}

/** SHA-256 as lowercase hexadecimal for byte identity and upload verification. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
