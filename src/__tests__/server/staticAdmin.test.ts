import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleServerRequest } from '../../../server/router'
import { SESSION_COOKIE_NAME } from '../../../server/auth/tokens'
import { serveAdminApp } from '../../../server/static'
import { createFakeDb } from './dbTestFake'

// Static file serving tests never touch the database.
const fakeDb = createFakeDb(async (sql) => {
  throw new Error(`Unexpected DB call in static admin test: ${sql}`)
})

function createStaticDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'instatic-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<div id="root">admin app</div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("admin")')
  return dir
}

function createAdminShellFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'instatic-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <style data-initial-loader></style>
  </head>
  <body>
    <div id="root">
      <div class="loading" data-initial-loader-spinner="true"><div></div></div>
    </div>
  </body>
</html>`,
  )
  for (const name of [
    'AuthenticatedAdmin-test.js',
    'SitePage-test.js',
    'ContentPage-test.js',
    'DataPage-test.js',
    'CodeMirrorEditor-test.js',
    'dnd-vendor-test.js',
  ]) {
    writeFileSync(join(dir, 'assets', name), 'export {}')
  }
  return dir
}

describe('self-hosted admin static serving', () => {
  it('serves the built admin SPA at /admin', async () => {
    const staticDir = createStaticDir()
    try {
      const res = await handleServerRequest(new Request('http://localhost/admin'), {
        db: fakeDb,
        staticDir,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('admin app')
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  it('serves built asset files from /assets', async () => {
    const staticDir = createStaticDir()
    try {
      const res = await handleServerRequest(new Request('http://localhost/assets/app.js'), {
        db: fakeDb,
        staticDir,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(await res.text()).toContain('console.log')
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  it('preloads only the authenticated shell chunk in authenticated admin HTML', async () => {
    const staticDir = createAdminShellFixture()
    try {
      const req = new Request('http://localhost/admin/site')
      req.headers.set('cookie', `${SESSION_COOKIE_NAME}=test-session`)
      const res = await serveAdminApp(staticDir, req)

      expect(res?.status).toBe(200)
      const html = (await res?.text()) ?? ''
      expect(html).toContain('window.__instaticAuthed = 1')
      expect(html).toContain('rel="modulepreload" href="/assets/AuthenticatedAdmin-test.js"')
      expect(html).not.toContain('SitePage-test.js')
      expect(html).not.toContain('ContentPage-test.js')
      expect(html).not.toContain('DataPage-test.js')
      expect(html).not.toContain('CodeMirrorEditor-test.js')
      expect(html).not.toContain('dnd-vendor-test.js')
      expect(html).not.toContain('rel="prefetch"')
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  it('does not preload authenticated workspace chunks on the login shell', async () => {
    const staticDir = createAdminShellFixture()
    try {
      const res = await serveAdminApp(staticDir, new Request('http://localhost/admin'))

      expect(res?.status).toBe(200)
      const html = (await res?.text()) ?? ''
      expect(html).toContain('data-initial-login-skeleton="true"')
      expect(html).not.toContain('AuthenticatedAdmin-test.js')
      expect(html).not.toContain('SitePage-test.js')
      expect(html).not.toContain('CodeMirrorEditor-test.js')
      expect(html).not.toContain('rel="prefetch"')
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  it('serves uploaded media files from /uploads', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    try {
      writeFileSync(join(uploadsDir, 'hero.png'), 'image-bytes')

      const res = await handleServerRequest(new Request('http://localhost/uploads/hero.png'), {
        db: fakeDb,
        uploadsDir,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('image/png')
      // Inert image MIMEs are allowed to render inline (no `attachment`).
      expect(res.headers.get('content-disposition')).toBeNull()
      // Defense-in-depth header should be set unconditionally for /uploads/*.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await res.text()).toBe('image-bytes')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('serves AVIF uploads inline with the image/avif content type', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    try {
      writeFileSync(join(uploadsDir, 'hero.avif'), 'image-bytes')

      const res = await handleServerRequest(new Request('http://localhost/uploads/hero.avif'), {
        db: fakeDb,
        uploadsDir,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/avif')
      expect(res.headers.get('content-disposition')).toBeNull()
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  // F-0002 regression: even if a file with an unsafe extension somehow
  // landed in the uploads dir (legacy file from before extension hardening,
  // or a future regression), forcing `Content-Disposition: attachment` on
  // any non-inert MIME prevents top-level navigation from rendering it as
  // HTML on the admin origin.
  it('forces attachment disposition for non-inert MIMEs in /uploads (F-0002)', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    try {
      writeFileSync(join(uploadsDir, 'pwn.html'), '<script>alert(1)</script>')

      const res = await handleServerRequest(new Request('http://localhost/uploads/pwn.html'), {
        db: fakeDb,
        uploadsDir,
      })

      expect(res.status).toBe(200)
      // The static handler still derives Content-Type from the extension —
      // that's OK because the disposition + nosniff together prevent
      // top-level execution on the admin origin.
      expect(res.headers.get('content-disposition')).toBe('attachment')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('forces attachment disposition for SVG in /uploads (XSS gadget)', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    try {
      writeFileSync(
        join(uploadsDir, 'evil.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      )

      const res = await handleServerRequest(new Request('http://localhost/uploads/evil.svg'), {
        db: fakeDb,
        uploadsDir,
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toBe('attachment')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  // `no-cache` uploads must carry a validator, or every editor preview reload
  // re-downloads every image and font in full.
  it('answers conditional /uploads requests with 304 until the file changes', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    const get = (headers: Record<string, string> = {}) =>
      handleServerRequest(new Request('http://localhost/uploads/hero.png', { headers }), {
        db: fakeDb,
        uploadsDir,
      })
    try {
      writeFileSync(join(uploadsDir, 'hero.png'), 'image-bytes')
      utimesSync(join(uploadsDir, 'hero.png'), 1_700_000_000, 1_700_000_000)

      const first = await get()
      expect(first.status).toBe(200)
      expect(first.headers.get('cache-control')).toBe('no-cache')
      const etag = first.headers.get('etag')
      const lastModified = first.headers.get('last-modified')
      expect(etag).toMatch(/^W\/".+"$/)
      expect(lastModified).toBe(new Date(1_700_000_000_000).toUTCString())

      const revalidated = await get({ 'if-none-match': etag! })
      expect(revalidated.status).toBe(304)
      expect(await revalidated.text()).toBe('')
      expect(revalidated.headers.get('etag')).toBe(etag)
      expect(revalidated.headers.get('content-type')).toBe('image/png')
      expect(revalidated.headers.has('content-disposition')).toBe(false)
      expect(revalidated.headers.get('content-security-policy')).toBe("default-src 'none'")
      expect(revalidated.headers.get('x-content-type-options')).toBe('nosniff')

      expect((await get({ 'if-none-match': `"other", ${etag}` })).status).toBe(304)
      expect((await get({ 'if-modified-since': lastModified! })).status).toBe(304)
      expect((await get({ 'if-modified-since': new Date(1_600_000_000_000).toUTCString() })).status).toBe(200)
      // If-None-Match takes precedence over If-Modified-Since.
      expect((await get({ 'if-none-match': '"stale"', 'if-modified-since': lastModified! })).status).toBe(200)

      // A replace that keeps the path changes the validator.
      writeFileSync(join(uploadsDir, 'hero.png'), 'new-image-bytes')
      const changed = await get({ 'if-none-match': etag! })
      expect(changed.status).toBe(200)
      expect(changed.headers.get('etag')).not.toBe(etag)
      expect(await changed.text()).toBe('new-image-bytes')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('keeps attachment and CORS protection when a plugin upload is revalidated', async () => {
    const uploadsDir = mkdtempSync(join(tmpdir(), 'instatic-uploads-'))
    const assetDir = join(uploadsDir, 'plugins', 'review', '1')
    mkdirSync(assetDir, { recursive: true })
    const get = (headers: Record<string, string> = {}) =>
      handleServerRequest(new Request('http://localhost/uploads/plugins/review/1/icon.svg', { headers }), {
        db: fakeDb,
        uploadsDir,
      })
    try {
      writeFileSync(join(assetDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
      const first = await get()
      const revalidated = await get({ 'if-none-match': first.headers.get('etag')! })
      expect(revalidated.status).toBe(304)
      expect(await revalidated.text()).toBe('')
      expect(revalidated.headers.get('content-disposition')).toBe('attachment')
      expect(revalidated.headers.get('x-content-type-options')).toBe('nosniff')
      expect(revalidated.headers.get('content-security-policy')).toBe("default-src 'none'")
      expect(revalidated.headers.get('access-control-allow-origin')).toBe('*')
      expect(revalidated.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    } finally {
      rmSync(uploadsDir, { recursive: true, force: true })
    }
  })

  it('sends validators on immutable admin assets too', async () => {
    const staticDir = createStaticDir()
    try {
      const first = await handleServerRequest(new Request('http://localhost/assets/app.js'), {
        db: fakeDb,
        staticDir,
      })
      expect(first.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      const etag = first.headers.get('etag')
      expect(etag).toBeTruthy()

      const revalidated = await handleServerRequest(
        new Request('http://localhost/assets/app.js', { headers: { 'if-none-match': etag! } }),
        { db: fakeDb, staticDir },
      )
      expect(revalidated.status).toBe(304)
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })
})
