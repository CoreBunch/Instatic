// ---------------------------------------------------------------------------
// QuickJS sandbox global type extensions
// ---------------------------------------------------------------------------

/**
 * The QuickJS sandbox polyfill for `crypto.subtle.digest` accepts a raw
 * `string` as the `data` argument and UTF-8-encodes it internally — which
 * mirrors the most common call pattern (hashing a canonical-request string
 * for AWS Sigv4, JWT, etc.). This augmentation widens the standard DOM type
 * so plugin TypeScript code can pass strings without a cast.
 */
declare global {
  interface SubtleCrypto {
    digest(algorithm: AlgorithmIdentifier, data: BufferSource | string): Promise<ArrayBuffer>
  }

  /**
   * The sandbox `fetch` takes a `timeout` in milliseconds (1 to 300000): how
   * long the whole request may take, redirects and body included, before the
   * host cancels it and the call rejects with a `TimeoutError`. Default 15 s.
   */
  interface RequestInit {
    timeout?: number
  }
}

// Re-export an empty object so this file is treated as a module and the
// `declare global` block is preserved when the barrel re-exports it.
export {}
