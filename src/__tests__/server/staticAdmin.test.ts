import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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

/** Admin shell fixture that includes an inline importmap + module entry script. */
function createAdminShellWithScripts(): string {
  const dir = mkdtempSync(join(tmpdir(), 'instatic-static-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html>
<html>
  <head>
    <style data-initial-loader></style>
    <script type="importmap">{"imports":{}}</script>
  </head>
  <body>
    <div id="root">
      <div class="loading" data-initial-loader-spinner="true"><div></div></div>
    </div>
    <script type="module" src="/src/admin/main.tsx"></script>
  </body>
</html>`,
  )
  return dir
}

describe('admin CSP report-only + shell script nonce', () => {
  it('emits a Content-Security-Policy-Report-Only header and stamps the matching nonce on every shell inline script', async () => {
    const staticDir = createAdminShellWithScripts()
    try {
      const req = new Request('http://localhost/admin/site')
      req.headers.set('cookie', `${SESSION_COOKIE_NAME}=test-session`)
      const res = await serveAdminApp(staticDir, req)
      expect(res?.status).toBe(200)

      const header = res?.headers.get('content-security-policy-report-only') ?? ''
      // Strict script-src (the security target) + realistic rest.
      expect(header).toContain("default-src 'self'")
      expect(header).toContain("object-src 'none'")
      expect(header).toContain("frame-ancestors 'none'")
      expect(header).toContain("style-src 'self' 'unsafe-inline'")
      const match = header.match(/script-src 'self' 'nonce-([^']+)'/)
      expect(match).not.toBeNull()
      const nonce = match![1]!
      expect(nonce.length).toBeGreaterThan(16)

      const html = (await res?.text()) ?? ''
      // The importmap, the boot-API kickoff, the authed flag, and the module
      // entry all carry the same nonce.
      expect(html).toContain(`<script nonce="${nonce}" type="importmap">`)
      expect(html).toContain(`<script nonce="${nonce}" type="module" src="/src/admin/main.tsx">`)
      expect(html).toContain(`window.__instaticAuthed = 1`)
      // Every <script> open tag must carry a nonce (none left unstamped).
      const scriptOpens = html.match(/<script\b[^>]*>/g) ?? []
      expect(scriptOpens.length).toBeGreaterThan(0)
      for (const tag of scriptOpens) expect(tag).toContain(`nonce="${nonce}"`)
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  it('generates a fresh nonce per response (not reused across requests)', async () => {
    const staticDir = createAdminShellWithScripts()
    try {
      const nonceOf = async () => {
        const res = await serveAdminApp(staticDir, new Request('http://localhost/admin'))
        const header = res?.headers.get('content-security-policy-report-only') ?? ''
        return header.match(/'nonce-([^']+)'/)?.[1] ?? ''
      }
      const a = await nonceOf()
      const b = await nonceOf()
      expect(a).not.toBe('')
      expect(a).not.toBe(b)
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })

  it('carries the report-only header through handleServerRequest', async () => {
    const staticDir = createAdminShellWithScripts()
    try {
      const res = await handleServerRequest(new Request('http://localhost/admin'), {
        db: fakeDb,
        staticDir,
      })
      // serveAdminApp sets the report-only header; the enforced clickjacking CSP
      // is layered on separately by applySecurityHeaders in the outer wrapper.
      expect(res.headers.get('content-security-policy-report-only')).toContain('script-src')
    } finally {
      rmSync(staticDir, { recursive: true, force: true })
    }
  })
})

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
})
