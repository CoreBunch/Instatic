/**
 * Integration test for the Layer A static-artefact publish protocol.
 *
 * Uses real SQLite publications and a real tmpdir to exercise:
 *
 *   1. `publishDraftSite` with a mixed fixture site (some fully-static pages,
 *      one page with a request-dependent loop source) → only static pages get
 *      a disk artefact, symlink is flipped, old slot is left intact.
 *
 *   2. The router's disk fast-path: a request whose URL matches a baked
 *      artefact returns the pre-rendered HTML without hitting the DB snapshot
 *      path.
 *
 *   3. A request with a query string falls through to the live renderer (DB
 *      path), not the disk path.
 *
 * The rendering pipeline (publishPage → applyPublishedHtmlPipeline) is
 * exercised for real using the base module registry and a stub plugin hook
 * bus. The stub hookBus is the default in-process bus which has no plugins
 * registered, so `publish.html` is a no-op and `injectFrontendAssets` only
 * adds the default CSP headers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DbResult } from '../../../server/db'
import { cleanupPublishingTestDbs, createPublishingTestDb } from '../helpers/publishingTestDb'
import { getPublishedRouteInventoryForVersion } from '../../../server/publish/publishedRoutes'
import { getPublishVersion, markPublishedArtefactsCurrent } from '../../../server/publish/publishState'

afterEach(cleanupPublishingTestDbs)
import { handleServerRequest } from '../../../server/router'
import {
  getActiveSlot,
  readArtefact,
  readStaticAsset,
} from '../../../server/publish/staticArtefact'
import { createFakeDb } from './dbTestFake'
import { makePage, makeSite } from '../publisher/helpers'
import type { LoopEntitySource } from '../../../src/core/loops/types'
import { loopSourceRegistry } from '../../../src/core/loops/registry'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildPublishedDb(...pages: Array<ReturnType<typeof makePage>>) {
  return createPublishingTestDb(makeSite({ pages }))
}

async function makeRouteDb(slug = 'about') {
  const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Live page' } } })
  page.slug = slug
  return buildPublishedDb(page)
}

/** Warm the authoritative route inventory, then enforce zero further SQL. */
async function makeWarmInventoryDb(slug = 'about') {
  const real = await makeRouteDb(slug)
  let deny = false
  let queried = false
  const db = createFakeDb(async (sql, params) => {
    if (deny) {
      queried = true
      throw new Error(`unexpected DB query after inventory warmup: ${sql.slice(0, 80)}`)
    }
    return real.unsafe(sql, params)
  })
  await getPublishedRouteInventoryForVersion(db, getPublishVersion())
  deny = true
  return { db, wasQueried: () => queried }
}

const REQUEST_DEPENDENT_SOURCE_ID = 'test.requestDependent'

const requestDependentSource: LoopEntitySource = {
  id: REQUEST_DEPENDENT_SOURCE_ID,
  label: 'Live API (request-dependent)',
  filterSchema: {},
  orderByOptions: [],
  fields: [],
  requestDependent: true,
  fetch: async () => ({ items: [], totalItems: 0 }),
  preview: () => [],
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('publishDraftSite — Layer A static artefacts', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'publish-artefact-'))
    loopSourceRegistry.register(requestDependentSource)
  })

  afterEach(async () => {
    loopSourceRegistry.unregister(REQUEST_DEPENDENT_SOURCE_ID)
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('writes a disk artefact for a fully-static page and flips the symlink', async () => {
    const staticPage = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['heading'] },
      heading: { moduleId: 'base.text', props: { text: 'Hello static world', tag: 'h1' }, children: [] },
    })
    staticPage.id = 'static-page'
    staticPage.slug = 'about'
    staticPage.title = 'About'

    const dynamicPage = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        props: { sourceId: REQUEST_DEPENDENT_SOURCE_ID },
        children: [],
      },
    })
    dynamicPage.id = 'dynamic-page'
    dynamicPage.slug = 'news'
    dynamicPage.title = 'News'

    const db = await buildPublishedDb(staticPage, dynamicPage)

    const { publishDraftSite } = await import('../../../server/publish/publishSite')
    const result = await publishDraftSite(db, null, uploadsDir)

    expect(result.publishedPages).toBe(2)

    // Static page artefact exists
    const staticHtml = await readArtefact(uploadsDir, '/about')
    expect(staticHtml).not.toBeNull()
    expect(staticHtml).toContain('Hello static world')

    // Dynamic page is ALSO baked — as a static SHELL with a <instatic-hole>
    // placeholder for the request-dependent loop. Everything except the hole
    // fragment is on disk; the hole runtime hydrates the loop at request time.
    const dynamicHtml = await readArtefact(uploadsDir, '/news')
    expect(dynamicHtml).not.toBeNull()
    expect(dynamicHtml).toContain('<instatic-hole')
    expect(dynamicHtml).toContain('/_instatic/hole-runtime.js')
    // The loop's items are NOT inlined — they come from the hole fetch.

    // Symlink exists and points to a slot
    const activeSlot = await getActiveSlot(uploadsDir)
    expect(['a', 'b']).toContain(activeSlot)

    // Complete static publishing: the CSS bundles the page links must be
    // baked to disk so the page never needs the server to regenerate them.
    const cssHrefs = [...(staticHtml ?? '').matchAll(/href="(\/_instatic\/css\/[^"]+\.css)"/g)].map((m) => m[1])
    expect(cssHrefs.length).toBeGreaterThan(0) // reset + framework at minimum
    for (const href of cssHrefs) {
      const bytes = await readStaticAsset(uploadsDir, href)
      expect(bytes).not.toBeNull()
      expect(bytes!.byteLength).toBeGreaterThan(0)
    }

    // And the router serves that CSS off disk (200, text/css) without ever
    // touching a DB snapshot.
    let snapshotLookupCalled = false
    const diskCssDb = createFakeDb(async (sql: string): Promise<DbResult> => {
      const s = sql.toLowerCase()
      if (s.includes('site_snapshots')) snapshotLookupCalled = true
      return { rows: [], rowCount: 0 }
    })
    const cssRes = await handleServerRequest(
      new Request(`http://localhost${cssHrefs[0]}`),
      { db: diskCssDb, uploadsDir },
    )
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(snapshotLookupCalled).toBe(false)
  })

  it('does NOT write disk artefact when uploadsDir is not provided', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['heading'] },
      heading: { moduleId: 'base.text', props: { text: 'No artefact', tag: 'h1' }, children: [] },
    })
    page.id = 'page-no-uploads'
    page.slug = 'no-uploads'
    page.title = 'No Uploads'

    const dynamicPage = makePage({
      root: { moduleId: 'base.body', props: {}, children: [] },
    })
    dynamicPage.id = 'page-empty'
    dynamicPage.slug = 'empty'
    dynamicPage.title = 'Empty'

    const db = await buildPublishedDb(page, dynamicPage)
    const { publishDraftSite } = await import('../../../server/publish/publishSite')
    const result = await publishDraftSite(db, null)  // no uploadsDir

    expect(result.publishedPages).toBe(2)
    // No symlink should exist
    const artefact = await readArtefact(uploadsDir, '/no-uploads')
    expect(artefact).toBeNull()
  })

  it('leaves the old slot intact after symlink flip', async () => {
    const page = makePage({
      root: { moduleId: 'base.body', props: {}, children: ['h'] },
      h: { moduleId: 'base.text', props: { text: 'First publish', tag: 'h1' }, children: [] },
    })
    page.id = 'page-flip'
    page.slug = 'flip'
    page.title = 'Flip'

    const page2 = makePage({
      root: { moduleId: 'base.body', props: {}, children: [] },
    })
    page2.id = 'page2-flip'
    page2.slug = 'flip2'
    page2.title = 'Flip2'

    const db = await buildPublishedDb(page, page2)
    const { publishDraftSite } = await import('../../../server/publish/publishSite')

    // First publish: writes to inactive slot (b), flips current → b
    await publishDraftSite(db, null, uploadsDir)
    const slotAfterFirst = await getActiveSlot(uploadsDir)

    // The other slot directory should still exist on disk (not wiped until next publish)
    // The inactive slot from the perspective of "before the first publish" is
    // the one the publish just wrote into — the OLD slot is what was active before.
    // On a brand-new uploadsDir there's no old slot, so just verify the active one has content.
    const html = await readArtefact(uploadsDir, '/flip')
    expect(html).toContain('First publish')

    // Second publish: writes to inactive slot (the other one), flips current
    await publishDraftSite(db, null, uploadsDir)
    const slotAfterSecond = await getActiveSlot(uploadsDir)

    // Slots must have rotated
    expect(slotAfterSecond).not.toBe(slotAfterFirst)

    // Content is still readable after the flip
    const htmlAfter = await readArtefact(uploadsDir, '/flip')
    expect(htmlAfter).toContain('First publish')
  })
})

describe('publicRouter — Layer A disk fast-path', () => {
  let uploadsDir: string

  beforeEach(async () => {
    uploadsDir = await mkdtemp(join(tmpdir(), 'router-artefact-'))
  })

  afterEach(async () => {
    await rm(uploadsDir, { recursive: true, force: true })
  })

  it('serves a baked artefact after route validation without snapshot hydration', async () => {
    const { db, wasQueried } = await makeWarmInventoryDb()
    // Pre-bake an artefact
    const { prepareInactiveSlot, writeArtefact, swapSlot } = await import('../../../server/publish/staticArtefact')
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html><body><h1>Baked about page</h1></body></html>')
    await swapSlot(uploadsDir, slot)
    markPublishedArtefactsCurrent(getPublishVersion())


    const res = await handleServerRequest(
      new Request('http://localhost/about'),
      { db, uploadsDir },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Baked about page')
    expect(wasQueried()).toBe(false)
  })

  it('serves static HTML, CSS and JS with zero queries after inventory warmup', async () => {
    const { db: throwingDb, wasQueried } = await makeWarmInventoryDb()
    // Pre-bake a full static page: HTML that links a CSS bundle and a JS chunk,
    // plus those two assets baked into the slot — exactly what a full publish
    // produces for a fully-static page.
    const { prepareInactiveSlot, writeArtefact, writeStaticAsset, swapSlot } =
      await import('../../../server/publish/staticArtefact')
    const enc = new TextEncoder()
    const cssPath = '/_instatic/css/reset-abc123abc123.css'
    const jsPath = '/_instatic/assets/v1/entries/app-deadbeefcafe.js'
    const html =
      `<!DOCTYPE html><html><head>` +
      `<link rel="stylesheet" href="${cssPath}">` +
      `</head><body><h1>Static</h1>` +
      `<script type="module" src="${jsPath}"></script>` +
      `</body></html>`

    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', html)
    await writeStaticAsset(slotDir, cssPath, enc.encode('body{margin:0}'))
    await writeStaticAsset(slotDir, jsPath, enc.encode('console.log("hi")'))
    await swapSlot(uploadsDir, slot)
    markPublishedArtefactsCurrent(getPublishVersion())

    // No staticDir → the admin static handler is a no-op; the public/asset
    // handlers own these paths.
    const htmlRes = await handleServerRequest(new Request('http://localhost/about'), { db: throwingDb, uploadsDir })
    expect(htmlRes.status).toBe(200)
    expect(htmlRes.headers.get('content-type')).toContain('text/html')
    expect(await htmlRes.text()).toContain('<h1>Static</h1>')

    const cssRes = await handleServerRequest(new Request(`http://localhost${cssPath}`), { db: throwingDb, uploadsDir })
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(await cssRes.text()).toBe('body{margin:0}')

    const jsRes = await handleServerRequest(new Request(`http://localhost${jsPath}`), { db: throwingDb, uploadsDir })
    expect(jsRes.status).toBe(200)
    expect(jsRes.headers.get('content-type')).toContain('javascript')
    expect(await jsRes.text()).toBe('console.log("hi")')

    // The hard guarantee: not a single DB query was issued for any of the three.
    expect(wasQueried()).toBe(false)
  })

  it('serves a hole shell and CSS with zero queries after inventory warmup', async () => {
    const { db: throwingDb, wasQueried } = await makeWarmInventoryDb('blog')
    // A page with a hole bakes a static shell: real HTML + a <instatic-hole>
    // placeholder + the hole runtime. The shell and its CSS are on disk; only
    // the hole fragment fetch (/_instatic/hole/<id>) touches the server at runtime.
    const { prepareInactiveSlot, writeArtefact, writeStaticAsset, swapSlot } =
      await import('../../../server/publish/staticArtefact')
    const cssPath = '/_instatic/css/style-feedfeedfeed.css'
    const shell =
      `<!DOCTYPE html><html><head>` +
      `<link rel="stylesheet" href="${cssPath}">` +
      `<script type="module" src="/_instatic/hole-runtime.js?v=3" defer></script>` +
      `</head><body><h1>Blog</h1>` +
      `<instatic-hole id="hole-loop1" data-instatic-hole="loop1" data-instatic-version="3" style="display:contents"></instatic-hole>` +
      `</body></html>`

    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/blog', shell)
    await writeStaticAsset(slotDir, cssPath, new TextEncoder().encode('h1{color:#000}'))
    await swapSlot(uploadsDir, slot)
    markPublishedArtefactsCurrent(getPublishVersion())

    const htmlRes = await handleServerRequest(new Request('http://localhost/blog'), { db: throwingDb, uploadsDir })
    expect(htmlRes.status).toBe(200)
    const body = await htmlRes.text()
    expect(body).toContain('<h1>Blog</h1>')
    expect(body).toContain('<instatic-hole') // the dynamic part is deferred to a hole
    expect(body).toContain('/_instatic/hole-runtime.js')

    const cssRes = await handleServerRequest(new Request(`http://localhost${cssPath}`), { db: throwingDb, uploadsDir })
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')

    // The shell + CSS were served entirely from disk — zero DB. (The hole
    // fragment endpoint, exercised in holeRouteHandler.test.ts, is the only
    // request that reads the DB.)
    expect(wasQueried()).toBe(false)
  })

  it('falls through to the live renderer when URL has a render-affecting (loop pagination) query', async () => {
    const db = await makeRouteDb()
    // Pre-bake an artefact for /about
    const { prepareInactiveSlot, writeArtefact, swapSlot } = await import('../../../server/publish/staticArtefact')
    const { slot, slotDir } = await prepareInactiveSlot(uploadsDir)
    await writeArtefact(slotDir, '/about', '<html><body><h1>Baked about page</h1></body></html>')
    await swapSlot(uploadsDir, slot)
    markPublishedArtefactsCurrent(getPublishVersion())

    // A loop-pagination query affects the render, so it must bypass the disk
    // path (junk queries instead serve the baked artefact — ISS-032)

    const res = await handleServerRequest(
      new Request('http://localhost/about?loop_x_page=2'),
      { db, uploadsDir },
    )

    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Live page')
    expect(html).not.toContain('Baked about page')
  })
})
