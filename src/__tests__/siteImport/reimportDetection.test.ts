/**
 * Detection half of re-import reconciliation: page routes typed in the Review
 * step, site files already present, and media the library already holds.
 * The commit half is driven through the real store in reimport.test.ts.
 */

import { describe, it, expect } from 'bun:test'
import { detectConflicts, detectMediaConflicts, hashImportAssets, withPageSlugs } from '@core/siteImport'
import type { ImportPlan, ImportScript, ImportStylesheet, PagePlan } from '@core/siteImport'
import { sha256HexBytes } from '@core/utils/sha256'
import { makeMockSiteDocument } from './mockSite'

function makePage(slug: string, source = `${slug}.html`): PagePlan {
  return { source, title: slug, slug, linkedCssPaths: [], scripts: [], nodeFragment: { rootIds: [], nodes: {} } }
}

function planOf(pages: PagePlan[], assets: ImportPlan['assets'] = []): ImportPlan {
  return {
    pages,
    styleRules: [],
    styleRuleSources: [],
    fonts: [],
    googleFonts: [],
    conditions: [],
    assets,
    colors: [],
    fontTokens: [],
    scripts: [],
    linkedStylesheets: [],
    stylesheets: [],
    conflicts: { pages: [], rules: [], tokens: [], crossSheetClasses: [], files: [], media: [] },
    warnings: [],
    droppedAtRules: [],
  }
}

const SITE = makeMockSiteDocument()
const EXISTING_SLUG = SITE.pages[0]!.slug

describe('withPageSlugs — routes typed in the Review step', () => {
  it('reports a page renamed onto an existing route as a conflict with that page', () => {
    const plan = withPageSlugs(planOf([makePage('landing')]), SITE, new Map([['landing.html', EXISTING_SLUG]]))
    expect(plan.pages[0]!.slug).toBe(EXISTING_SLUG)
    expect(plan.conflicts.pages).toEqual([
      expect.objectContaining({ source: 'landing.html', desiredSlug: EXISTING_SLUG, existingPageId: SITE.pages[0]!.id }),
    ])
  })

  it('normalises a typed route the way the page store does', () => {
    const plan = withPageSlugs(planOf([makePage('landing')]), SITE, new Map([['landing.html', `/${EXISTING_SLUG.toUpperCase()}/`]]))
    expect(plan.conflicts.pages.map((c) => c.desiredSlug)).toEqual([EXISTING_SLUG])
  })

  it('drops a conflict the typed route resolves', () => {
    const conflicting = withPageSlugs(planOf([makePage(EXISTING_SLUG)]), SITE, new Map())
    expect(conflicting.conflicts.pages).toHaveLength(1)
    const renamed = withPageSlugs(conflicting, SITE, new Map([[`${EXISTING_SLUG}.html`, 'fresh-route']]))
    expect(renamed.conflicts.pages).toEqual([])
  })

  it('catches two imported pages typed onto the same route', () => {
    const plan = withPageSlugs(
      planOf([makePage('a'), makePage('b')]),
      SITE,
      new Map([['a.html', 'same'], ['b.html', 'same']]),
    )
    expect(plan.conflicts.pages).toEqual([expect.objectContaining({ source: 'b.html', existingPageId: '' })])
  })
})

describe('detectConflicts — site files already present', () => {
  const site = {
    ...SITE,
    files: [
      { id: 'f-app', path: 'js/app.js', type: 'script' as const, content: 'x', createdAt: 1, updatedAt: 1 },
      { id: 'f-kit', path: 'css/kit.css', type: 'style' as const, content: 'y', createdAt: 1, updatedAt: 1 },
    ],
  }
  const script = (path: string): ImportScript => ({ path, content: '', format: 'classic', pageSources: [], priority: 100 })
  const sheet = (path: string): ImportStylesheet => ({ path, content: '', pageSources: [], priority: 0 })

  it('flags a script or stylesheet whose path the site already has, defaulting to reuse', () => {
    const { files } = detectConflicts(site, [], [], [], [], [script('js/app.js'), script('js/new.js')], [sheet('css/kit.css')])
    expect(files).toEqual([
      { kind: 'script', path: 'js/app.js', sitePath: 'js/app.js', existingFileId: 'f-app', defaultResolution: { action: 'skip' } },
      { kind: 'style', path: 'css/kit.css', sitePath: 'css/kit.css', existingFileId: 'f-kit', defaultResolution: { action: 'skip' } },
    ])
  })

  it('leaves a path held by a file of the other kind to the unique-path rule', () => {
    const { files } = detectConflicts(site, [], [], [], [], [], [sheet('js/app.js')])
    expect(files).toEqual([])
  })
})

describe('detectMediaConflicts — files the library already holds', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const asset = { sourcePath: 'img/logo.png', mimeType: 'image/png', bytes }

  it('hashes like the server does (SHA-256 hex of the raw bytes), with or without WebCrypto', async () => {
    const serverHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    expect(sha256HexBytes(bytes)).toBe(serverHash)
    expect((await hashImportAssets([asset])).get('img/logo.png')).toBe(serverHash)
  })

  it('turns a hash match into a reuse conflict pointing at the existing asset', async () => {
    const hashBySource = await hashImportAssets([asset])
    const plan = detectMediaConflicts(planOf([], [asset]), hashBySource, [
      { contentHash: hashBySource.get('img/logo.png')!, id: 'a1', publicPath: '/uploads/logo.png', filename: 'logo.png' },
      { contentHash: hashBySource.get('img/logo.png')!, id: 'a2', publicPath: '/uploads/logo-2.png', filename: 'logo.png' },
    ])
    expect(plan.conflicts.media).toEqual([
      {
        sourcePath: 'img/logo.png',
        existingAssetId: 'a1',
        existingUrl: '/uploads/logo.png',
        existingFilename: 'logo.png',
        defaultResolution: { action: 'skip' },
      },
    ])
  })

  it('reports nothing when the library has no match', async () => {
    const plan = detectMediaConflicts(planOf([], [asset]), await hashImportAssets([asset]), [])
    expect(plan.conflicts.media).toEqual([])
  })
})
