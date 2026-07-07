/**
 * Security response headers
 *
 * Tests for `applySecurityHeaders` (server/securityHeaders.ts) and the
 * upload-specific `Content-Security-Policy` added to `hardenUploadResponse`
 * (server/static.ts).
 *
 * Note: `applySecurityHeaders` is called from the Bun.serve fetch handler in
 * server/index.ts (not from handleServerRequest), so the tests here exercise
 * the function directly. The upload CSP tests go through handleServerRequest
 * to verify end-to-end behaviour within the router.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applySecurityHeaders } from '../../../server/securityHeaders'
import { hardenUploadResponse } from '../../../server/static'
import { configurePublicOrigins, resetPublicOrigins } from '../../../server/auth/security'
import { handleServerRequest } from '../../../server/router'
import { createFakeDb } from './dbTestFake'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeResponse(body: string | null = null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers })
}

// ─────────────────────────────────────────────────────────────────────────────
// applySecurityHeaders — global headers
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  resetPublicOrigins()
})

describe('applySecurityHeaders — global headers', () => {
  it('sets X-Content-Type-Options: nosniff on every response', () => {
    const res = applySecurityHeaders(makeResponse('hello'), '/some/path')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('sets Referrer-Policy when none is already present', () => {
    const res = applySecurityHeaders(makeResponse(), '/about')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
  })

  it('does NOT overwrite a stricter Referrer-Policy already on the response', () => {
    // The signed-media redirect uses `no-referrer` to prevent the signed URL
    // from leaking via the Referer header to the redirect target.
    const base = makeResponse(null, { 'referrer-policy': 'no-referrer' })
    const res = applySecurityHeaders(base, '/some/path')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('sets HSTS when the canonical public origin is HTTPS', () => {
    configurePublicOrigins(['https://cms.example.com'])
    const res = applySecurityHeaders(makeResponse(), '/about')
    expect(res.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains')
  })

  it('does NOT set HSTS when the canonical public origin is HTTP', () => {
    configurePublicOrigins(['http://localhost:3001'])
    const res = applySecurityHeaders(makeResponse(), '/about')
    expect(res.headers.get('strict-transport-security')).toBeNull()
  })

  it('does NOT set HSTS when no public origin is configured', () => {
    // No configurePublicOrigins() call — default is no configured origin.
    const res = applySecurityHeaders(makeResponse(), '/about')
    expect(res.headers.get('strict-transport-security')).toBeNull()
  })

  it('preserves existing response headers (e.g. Content-Type)', () => {
    const base = makeResponse('{}', { 'content-type': 'application/json' })
    const res = applySecurityHeaders(base, '/api/data')
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('preserves the original status code', () => {
    const base = new Response(null, { status: 404 })
    const res = applySecurityHeaders(base, '/not-found')
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applySecurityHeaders — admin clickjacking protection
// ─────────────────────────────────────────────────────────────────────────────

describe('applySecurityHeaders — admin framing protection', () => {
  it('sets X-Frame-Options: DENY on /admin HTML responses', () => {
    const res = applySecurityHeaders(makeResponse('<html>admin</html>'), '/admin')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('sets the admin CSP (frame-ancestors + base-uri + object-src) on /admin HTML responses', () => {
    const res = applySecurityHeaders(makeResponse('<html>admin</html>'), '/admin')
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    )
  })

  it("locks base-uri to 'self' so a <base href> injection can't rewrite relative URLs", () => {
    const res = applySecurityHeaders(makeResponse('<html>admin</html>'), '/admin')
    expect(res.headers.get('content-security-policy')).toContain("base-uri 'self'")
  })

  it("blocks <object>/<embed> plugin content with object-src 'none'", () => {
    const res = applySecurityHeaders(makeResponse('<html>admin</html>'), '/admin')
    expect(res.headers.get('content-security-policy')).toContain("object-src 'none'")
  })

  it('applies the admin CSP to /admin/* subpaths (admin SPA routes)', () => {
    const res = applySecurityHeaders(makeResponse(), '/admin/site/123')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    )
  })

  it('applies the admin CSP to /admin/api/* (admin API endpoints)', () => {
    const res = applySecurityHeaders(makeResponse('{}'), '/admin/api/cms/login')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    )
  })

  it('does NOT set X-Frame-Options on public page responses', () => {
    const res = applySecurityHeaders(makeResponse('<html>public</html>'), '/about')
    expect(res.headers.get('x-frame-options')).toBeNull()
  })

  it('does NOT set CSP on public page responses', () => {
    const res = applySecurityHeaders(makeResponse('<html>public</html>'), '/about')
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('does NOT set admin framing headers on /uploads/ responses', () => {
    const res = applySecurityHeaders(makeResponse('image-bytes'), '/uploads/photo.png')
    expect(res.headers.get('x-frame-options')).toBeNull()
    // CSP from hardenUploadResponse is separate; applySecurityHeaders doesn't
    // add one for non-admin paths.
    expect(res.headers.get('content-security-policy')).toBeNull()
  })

  it('does NOT set admin framing headers on root path', () => {
    const res = applySecurityHeaders(makeResponse('<html>home</html>'), '/')
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hardenUploadResponse — upload CSP
// ─────────────────────────────────────────────────────────────────────────────

describe('hardenUploadResponse — upload Content-Security-Policy', () => {
  it("adds default-src 'none' CSP to upload responses", () => {
    const base = new Response('data', { headers: { 'content-type': 'image/png' } })
    const res = hardenUploadResponse(base)
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
  })

  it('retains the existing nosniff header alongside the CSP', () => {
    const base = new Response('data', { headers: { 'content-type': 'text/html' } })
    const res = hardenUploadResponse(base)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Integration: /uploads/* responses via handleServerRequest
// ─────────────────────────────────────────────────────────────────────────────

describe('/uploads/* responses via router (integration)', () => {
  const fakeDb = createFakeDb(async (sql) => {
    throw new Error(`Unexpected DB call in security-headers test: ${sql}`)
  })

  it("sets CSP default-src 'none' on inert image uploads", async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-sec-test-'))
    try {
      writeFileSync(join(uploadsDir, 'photo.png'), 'fake-png-bytes')
      const res = await handleServerRequest(
        new Request('http://localhost/uploads/photo.png'),
        { db: fakeDb, uploadsDir },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it("sets CSP default-src 'none' on potentially dangerous upload MIMEs", async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-sec-test-'))
    try {
      writeFileSync(join(uploadsDir, 'data.html'), '<script>evil()</script>')
      const res = await handleServerRequest(
        new Request('http://localhost/uploads/data.html'),
        { db: fakeDb, uploadsDir },
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
      expect(res.headers.get('content-disposition')).toBe('attachment')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })
})
