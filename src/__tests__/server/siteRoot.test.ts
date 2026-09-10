/**
 * The site-root text surface (`server/siteRoot.ts`) — issue #425.
 *
 * Two plugin surfaces are covered here:
 *   - `site.robots`    — the host-managed `/robots.txt` document. Plugins
 *     contribute directives; the HOST renders the text, so the tests pin
 *     both the rendering and what happens to a contribution the host will
 *     not accept.
 *   - `site.rootFiles` — root-level `.txt` claims (the IndexNow key case).
 *     The tests pin the claimable path allowlist, the reserved paths, and
 *     the deterministic outcome when two plugins claim one path.
 *
 * The last block goes through `handleServerRequest` to pin the dispatcher
 * ordering: both handlers sit after every host-owned namespace and before
 * slug resolution, and an unclaimed path still falls through.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { hookBus } from '@core/plugins/hookBus'
import { MAX_ROOT_FILE_CLAIMS, type RobotsDocument, type SiteRootFiles } from '@core/plugin-sdk'
import { serveRobotsTxt, serveRootFile } from '../../../server/siteRoot'
import { handleServerRequest } from '../../../server/router'
import { createFakeDb } from './dbTestFake'

afterEach(() => {
  hookBus.reset()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Register a `site.robots` handler for a plugin id. */
function onRobots(pluginId: string, fn: (doc: RobotsDocument) => RobotsDocument): void {
  hookBus.filter(pluginId, 'site.robots', (value) => fn(value as RobotsDocument))
}

/** Register a `site.rootFiles` handler for a plugin id. */
function onRootFiles(pluginId: string, fn: (doc: SiteRootFiles) => SiteRootFiles): void {
  hookBus.filter(pluginId, 'site.rootFiles', (value) => fn(value as SiteRootFiles))
}

/** Claim one root file, the shape a plugin actually writes. */
function claim(pluginId: string, path: string, content: string): void {
  onRootFiles(pluginId, (doc) => {
    doc.files.push({ path, content })
    return doc
  })
}

async function robotsBody(): Promise<string> {
  const res = await serveRobotsTxt('/robots.txt')
  expect(res).not.toBeNull()
  return await res!.text()
}

/** The router needs a db only for the setup memo; nothing here queries. */
function fakeDb() {
  return createFakeDb(async () => ({ rows: [], rowCount: 0 }))
}

// ---------------------------------------------------------------------------
// robots.txt — the host document
// ---------------------------------------------------------------------------

describe('robots.txt', () => {
  it('serves the permissive host default when no plugin contributes', async () => {
    const res = await serveRobotsTxt('/robots.txt')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(await res!.text()).toBe('User-agent: *\nAllow: /\n')
  })

  it('serves it as inert text/plain that is never cached', async () => {
    const res = await serveRobotsTxt('/robots.txt')
    expect(res!.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res!.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res!.headers.get('cache-control')).toBe('no-store')
  })

  it('claims only its own path', async () => {
    expect(await serveRobotsTxt('/robots')).toBeNull()
    expect(await serveRobotsTxt('/about')).toBeNull()
  })

  it('appends a plugin Sitemap line after the groups', async () => {
    onRobots('acme.seo', (doc) => {
      doc.sitemaps.push('https://example.com/sitemap.xml')
      return doc
    })
    expect(await robotsBody()).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n',
    )
  })

  it('chains several plugins in registration order and de-duplicates sitemaps', async () => {
    onRobots('acme.seo', (doc) => {
      doc.sitemaps.push('https://example.com/a.xml')
      return doc
    })
    onRobots('zeta.seo', (doc) => {
      doc.sitemaps.push('https://example.com/b.xml', 'https://example.com/a.xml')
      return doc
    })
    expect(await robotsBody()).toBe(
      'User-agent: *\nAllow: /\n\n' +
        'Sitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml\n',
    )
  })

  it('renders a contributed group as User-agent, then disallow, then allow', async () => {
    onRobots('acme.seo', (doc) => {
      doc.groups.push({ userAgent: 'BadBot', allow: ['/public'], disallow: ['/search'] })
      return doc
    })
    expect(await robotsBody()).toBe(
      'User-agent: *\nAllow: /\n\nUser-agent: BadBot\nDisallow: /search\nAllow: /public\n',
    )
  })

  it('re-inserts the host default group when the filtered document has none', async () => {
    onRobots('acme.seo', () => ({
      groups: [],
      sitemaps: ['https://example.com/sitemap.xml'],
    }))
    expect(await robotsBody()).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n',
    )
  })

  it('drops a group whose directives would forge extra robots.txt lines', async () => {
    onRobots('acme.bad', (doc) => {
      // A newline in either field would open a second directive block.
      doc.groups.push({ userAgent: '*\nDisallow: /', allow: [], disallow: [] })
      doc.groups.push({ userAgent: 'A', allow: [], disallow: ['/x\nDisallow: /'] })
      // A `#` would turn the rest of the line into a robots.txt comment.
      doc.groups.push({ userAgent: 'B', allow: [], disallow: ['/x # comment'] })
      // Paths are anchored at the site root.
      doc.groups.push({ userAgent: 'C', allow: [], disallow: ['no-leading-slash'] })
      doc.groups.push({ userAgent: 'GoodBot', allow: [], disallow: ['/search'] })
      return doc
    })
    // A group is validated as a unit, so one bad directive drops the group
    // it belongs to — never the whole document.
    expect(await robotsBody()).toBe(
      'User-agent: *\nAllow: /\n\nUser-agent: GoodBot\nDisallow: /search\n',
    )
  })

  it('drops individual sitemap values that carry line breaks', async () => {
    onRobots('acme.bad', (doc) => {
      doc.sitemaps.push('https://example.com/ok.xml', 'https://evil\r\nX-Injected: 1')
      return doc
    })
    expect(await robotsBody()).toBe(
      'User-agent: *\nAllow: /\n\nSitemap: https://example.com/ok.xml\n',
    )
  })

  it('drops sitemap values that are not absolute http(s) URLs', async () => {
    onRobots('acme.bad', (doc) => {
      doc.sitemaps.push('/sitemap.xml', 'javascript:alert(1)', 'file:///etc/passwd')
      return doc
    })
    expect(await robotsBody()).toBe('User-agent: *\nAllow: /\n')
  })

  it('keeps the host default when a handler throws', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      onRobots('acme.bad', () => {
        throw new Error('boom')
      })
      expect(await robotsBody()).toBe('User-agent: *\nAllow: /\n')
    } finally {
      errorLog.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Root text files
// ---------------------------------------------------------------------------

describe('root text files', () => {
  it('does nothing when no plugin registers the filter', async () => {
    expect(await serveRootFile('/abc123.txt')).toBeNull()
  })

  it('serves a claimed path as inert text/plain', async () => {
    claim('acme.seo', '/a1b2c3d4.txt', 'a1b2c3d4')
    const res = await serveRootFile('/a1b2c3d4.txt')
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(await res!.text()).toBe('a1b2c3d4')
    expect(res!.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res!.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res!.headers.get('cache-control')).toBe('no-store')
  })

  it('serves HTML-looking content as text, never as a document', async () => {
    claim('acme.seo', '/key.txt', '<script>alert(1)</script>')
    const res = await serveRootFile('/key.txt')
    expect(res!.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res!.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res!.text()).toBe('<script>alert(1)</script>')
  })

  it('returns null for a path nobody claimed', async () => {
    claim('acme.seo', '/key.txt', 'key')
    expect(await serveRootFile('/other.txt')).toBeNull()
  })

  it('matches the claimed path exactly — case-sensitive, no query, no trailing slash', async () => {
    claim('acme.seo', '/AbC.txt', 'AbC')
    expect(await serveRootFile('/abc.txt')).toBeNull()
    expect(await serveRootFile('/AbC.txt/')).toBeNull()
    expect(await serveRootFile('/AbC.txt')).not.toBeNull()
  })

  it('refuses claims outside the single-segment .txt allowlist', async () => {
    for (const path of [
      '/../secret.txt',
      '/a/../b.txt',
      '/nested/key.txt',
      '/.hidden.txt',
      '/-leading.txt',
      '/index.html',
      '/favicon.svg',
      '/sitemap.xml',
      '/key.txt.html',
      '/',
      'key.txt',
    ]) {
      claim('acme.bad', path, 'payload')
      expect(await serveRootFile(path)).toBeNull()
      hookBus.reset()
    }
  })

  it('never resolves a percent-encoded request to a claim', async () => {
    claim('acme.seo', '/key.txt', 'key')
    // Pathnames arrive un-decoded and a claimable path cannot contain `%`,
    // so an encoded traversal fails the allowlist instead of matching.
    expect(await serveRootFile('/%2e%2e%2fkey.txt')).toBeNull()
    expect(await serveRootFile('/%6bey.txt')).toBeNull()
  })

  it('refuses a claim on the host-managed /robots.txt and says so', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      onRootFiles('acme.bad', (doc) => {
        doc.files.push({ path: '/robots.txt', content: 'User-agent: *\nDisallow: /' })
        doc.files.push({ path: '/ok.txt', content: 'ok' })
        return doc
      })
      expect(await serveRootFile('/robots.txt')).toBeNull()
      // Resolving any claimable path surfaces the rejected claim; the
      // plugin's own file is unaffected.
      const own = await serveRootFile('/ok.txt')
      expect(await own!.text()).toBe('ok')
      expect(errorLog).toHaveBeenCalledWith(
        '[siteRoot] root file "/robots.txt" is reserved by the host; ignoring the claim. ' +
          'Registered by one of: acme.bad',
      )
    } finally {
      errorLog.mockRestore()
    }
    // The host document is unaffected by the attempted claim.
    expect(await robotsBody()).toBe('User-agent: *\nAllow: /\n')
  })

  it('refuses a path two plugins claim, naming the candidates', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      claim('acme.seo', '/key.txt', 'acme-key')
      claim('zeta.seo', '/key.txt', 'zeta-key')
      expect(await serveRootFile('/key.txt')).toBeNull()
      expect(errorLog).toHaveBeenCalledWith(
        '[siteRoot] root file "/key.txt" was claimed more than once; refusing to serve it. ' +
          'Registered by one of: acme.seo, zeta.seo',
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  it('keeps the uncontested claims of a plugin that also contests one', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      claim('acme.seo', '/shared.txt', 'acme')
      onRootFiles('zeta.seo', (doc) => {
        doc.files.push({ path: '/shared.txt', content: 'zeta' })
        doc.files.push({ path: '/zeta-only.txt', content: 'zeta-only' })
        return doc
      })
      expect(await serveRootFile('/shared.txt')).toBeNull()
      const own = await serveRootFile('/zeta-only.txt')
      expect(await own!.text()).toBe('zeta-only')
    } finally {
      errorLog.mockRestore()
    }
  })

  it('drops content over the 4 KiB cap and keeps the valid claims', async () => {
    onRootFiles('acme.bad', (doc) => {
      doc.files.push({ path: '/huge.txt', content: 'x'.repeat(4097) })
      doc.files.push({ path: '/small.txt', content: 'x'.repeat(4096) })
      return doc
    })
    expect(await serveRootFile('/huge.txt')).toBeNull()
    expect(await serveRootFile('/small.txt')).not.toBeNull()
  })

  it('drops content carrying control characters but allows tabs and newlines', async () => {
    onRootFiles('acme.bad', (doc) => {
      doc.files.push({ path: '/nul.txt', content: 'key\u0000padding' })
      doc.files.push({ path: '/esc.txt', content: 'key\u001b[2J' })
      doc.files.push({ path: '/lines.txt', content: 'line1\nline2\tcol' })
      return doc
    })
    expect(await serveRootFile('/nul.txt')).toBeNull()
    expect(await serveRootFile('/esc.txt')).toBeNull()
    const ok = await serveRootFile('/lines.txt')
    expect(await ok!.text()).toBe('line1\nline2\tcol')
  })

  it('discards claims past the cap so the accepted set stays bounded', async () => {
    onRootFiles('acme.bad', (doc) => {
      for (let i = 0; i < MAX_ROOT_FILE_CLAIMS + 5; i++) {
        doc.files.push({ path: `/k${i}.txt`, content: `${i}` })
      }
      return doc
    })
    expect(await serveRootFile('/k0.txt')).not.toBeNull()
    expect(await serveRootFile(`/k${MAX_ROOT_FILE_CLAIMS - 1}.txt`)).not.toBeNull()
    expect(await serveRootFile(`/k${MAX_ROOT_FILE_CLAIMS}.txt`)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Dispatcher ordering
// ---------------------------------------------------------------------------

describe('site-root files in the dispatcher', () => {
  it('serves /robots.txt through the router', async () => {
    const res = await handleServerRequest(new Request('http://localhost/robots.txt'), { db: fakeDb() })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toBe('User-agent: *\nAllow: /\n')
  })

  it('serves a claimed root file through the router', async () => {
    claim('acme.seo', '/a1b2c3.txt', 'a1b2c3')
    const res = await handleServerRequest(new Request('http://localhost/a1b2c3.txt'), { db: fakeDb() })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('a1b2c3')
  })

  it('lets an unclaimed .txt path keep falling through', async () => {
    claim('acme.seo', '/a1b2c3.txt', 'a1b2c3')
    const res = await handleServerRequest(new Request('http://localhost/nobody.txt'), { db: fakeDb() })
    expect(res.status).not.toBe(200)
  })

  it('does not answer non-GET requests for the site-root paths', async () => {
    claim('acme.seo', '/a1b2c3.txt', 'a1b2c3')
    for (const method of ['POST', 'DELETE']) {
      const robots = await handleServerRequest(
        new Request('http://localhost/robots.txt', { method }),
        { db: fakeDb() },
      )
      expect(robots.status).toBe(404)
      const file = await handleServerRequest(
        new Request('http://localhost/a1b2c3.txt', { method }),
        { db: fakeDb() },
      )
      expect(file.status).toBe(404)
    }
  })

  it('answers HEAD the same way it answers GET', async () => {
    claim('acme.seo', '/a1b2c3.txt', 'a1b2c3')
    const res = await handleServerRequest(
      new Request('http://localhost/a1b2c3.txt', { method: 'HEAD' }),
      { db: fakeDb() },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('cannot claim a path inside a host-owned namespace', async () => {
    // `/admin/...` and `/uploads/...` are claimed by earlier routes, and the
    // allowlist pattern rejects any path with a second segment anyway.
    claim('acme.bad', '/uploads/evil.txt', 'payload')
    expect(await serveRootFile('/uploads/evil.txt')).toBeNull()
    const res = await handleServerRequest(
      new Request('http://localhost/admin/api/cms/setup/status'),
      { db: fakeDb() },
    )
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})
