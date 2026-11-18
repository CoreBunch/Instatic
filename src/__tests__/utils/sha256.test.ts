import { describe, expect, it } from 'bun:test'
import { sha256Hex } from '@core/utils/sha256'

// Reference digest via the platform's native WebCrypto (always available in
// Bun / the test runner), so the pure-JS implementation is checked against the
// real algorithm rather than a hand-copied constant.
async function nativeSha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('sha256Hex', () => {
  it('matches the published empty-string and "abc" vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('always returns 64 lowercase hex chars', () => {
    for (const input of ['', 'a', 'hello world', 'x'.repeat(1000)]) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('agrees with native WebCrypto across sizes and block boundaries', async () => {
    const inputs = [
      '',
      'a',
      'The quick brown fox jumps over the lazy dog',
      // Multi-byte UTF-8 (emoji + accents) — exercises the byte encoding.
      'héllo — 世界 🚀',
      // Exactly 55, 56, 63, 64, 65 bytes: the padding edge cases.
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      'x'.repeat(65),
      // A realistic code-asset payload spanning several blocks.
      `body { color: var(--text); }\n`.repeat(400),
    ]
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(await nativeSha256Hex(input))
    }
  })

  it('is deterministic and sensitive to single-character changes', () => {
    expect(sha256Hex('const x = 1')).toBe(sha256Hex('const x = 1'))
    expect(sha256Hex('const x = 1')).not.toBe(sha256Hex('const x = 2'))
  })
})
