import { beforeEach, describe, expect, it } from 'bun:test'
import type { SiteDocument, StyleRule } from '@core/page-tree'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import { registry } from '@core/module-engine'
import { composeTemplateChain, resolveTemplateChain } from '@core/templates'
import type { PublishedPageSnapshot } from '../../../server/repositories/publish'
import { buildSiteCssBundle } from '../../../server/publish/siteCssBundle'
import { renderPublishedSnapshot } from '../../../server/publish/publicRenderer'
import { handleServerRequest } from '../../../server/router'
import { bumpPublishVersion, resetPublishStateForTests } from '../../../server/publish/publishState'
import { createFakeDb } from './dbTestFake'
import { makePage, makeSite } from '../publisher/helpers'

function rule(id: string, color = 'green'): StyleRule {
  return { id, name: id, kind: 'class', selector: `.${id}`, styles: { color }, contextStyles: {}, order: 0, createdAt: 0, updatedAt: 0 }
}
function manifest(fileId: string): PublishedPageRuntimeAssets {
  return { scripts: [{ fileId, src: `/_instatic/assets/${fileId}.js`, format: 'module', placement: 'body-end', timing: 'dom-ready', priority: 100 }] }
}
function makeFixture() {
  const a = { ...makePage({ root: { moduleId: 'base.body', children: ['text'] }, text: { moduleId: 'base.text', props: { text: 'A' }, classIds: ['alpha'] } }), id: 'a', slug: 'index' }
  const b = { ...makePage({ root: { moduleId: 'base.body', children: ['text'] }, text: { moduleId: 'base.text', props: { text: 'B' }, classIds: ['beta'] } }), id: 'b', slug: 'other' }
  const site = makeSite({ pages: [a, b], styleRules: { alpha: rule('alpha'), beta: rule('beta'), 'a-state': rule('a-state'), 'b-state': rule('b-state') }, files: [
    { id: 'script-a', path: 'a.js', type: 'script', content: "document.body.classList.add('a-state')", createdAt: 0, updatedAt: 0 },
    { id: 'script-b', path: 'b.js', type: 'script', content: "document.body.classList.add('b-state')", createdAt: 0, updatedAt: 0 },
  ] })
  const manifests = new Map([['a', manifest('script-a')], ['b', manifest('script-b')]])
  return { site, manifests }
}
function snapshot(site: SiteDocument, pageRowId: string, manifests: Map<string, PublishedPageRuntimeAssets>): PublishedPageSnapshot {
  return { cmsSnapshotVersion: 1, site, pageRowId, runtimeAssets: manifests.get(pageRowId) }
}
function dbFor(
  readSite: () => SiteDocument,
  manifests: Map<string, PublishedPageRuntimeAssets>,
  beforeManifestRead?: () => Promise<void>,
) {
  let manifestReads = 0
  const db = createFakeDb(async (sql, values) => {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized.includes('site_snapshots.site_json')) {
      const site = readSite()
      const candidate = normalized.includes('data_rows.id =')
        ? site.pages.find((p) => p.id === values[0])
        : normalized.includes('data_rows.slug =') ? site.pages.find((p) => p.slug === values[0]) : site.pages[0]
      return { rows: candidate ? [{ row_id: candidate.id, site_json: site, runtime_assets_json: manifests.get(candidate.id) ?? null, importmap_body: null, importmap_sha256: null }] : [], rowCount: candidate ? 1 : 0 }
    }
    if (normalized.startsWith('select data_rows.id as row_id, data_row_versions.runtime_assets_json')) {
      manifestReads += 1
      await beforeManifestRead?.()
      const rows = [...manifests].map(([row_id, runtime_assets_json]) => ({ row_id, runtime_assets_json }))
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  return { db, manifestReads: () => manifestReads }
}
async function requestCss(db: ReturnType<typeof dbFor>['db'], filename: string) {
  return handleServerRequest(new Request(`http://localhost/_instatic/css/${filename}`), { db })
}

describe('page CSS asset fallback', () => {
  beforeEach(resetPublishStateForTests)

  it('serves every page hash with its own emitted runtime classes, then reuses the manifest index', async () => {
    const { site, manifests } = makeFixture()
    const { db, manifestReads } = dbFor(() => site, manifests)
    const rendered = []
    for (const page of site.pages) rendered.push(await renderPublishedSnapshot(snapshot(site, page.id, manifests), { db }))
    expect(rendered[0].cssBundle.style.hash).not.toBe(rendered[1].cssBundle.style.hash)
    for (let i = 0; i < rendered.length; i += 1) {
      const file = rendered[i].cssBundle.style
      const response = await requestCss(db, file.filename)
      expect(response.status).toBe(200)
      expect(response.headers.get('etag')).toBe(`"${file.hash}"`)
      expect(response.headers.get('cache-control')).toContain('immutable')
      const body = await response.text()
      expect(body).toBe(file.content)
      expect(body).toContain(i === 0 ? '.a-state {' : '.b-state {')
      expect(body).not.toContain(i === 0 ? '.b-state {' : '.a-state {')
    }
    expect(manifestReads()).toBe(1)
  })

  it('resolves layout-composed page and entry-template hashes instead of an all-site union', async () => {
    const { site, manifests } = makeFixture()
    const layout = { ...makePage({ root: { moduleId: 'base.body', children: ['chrome', 'outlet'] }, chrome: { moduleId: 'base.text', classIds: ['chrome'] }, outlet: { moduleId: 'base.outlet' } }), id: 'layout', template: { enabled: true, target: { kind: 'everywhere' as const }, priority: 0 } }
    const entry = { ...makePage({ root: { moduleId: 'base.body', children: ['heading', 'outlet'] }, heading: { moduleId: 'base.text', classIds: ['entry'] }, outlet: { moduleId: 'base.outlet' } }), id: 'entry', template: { enabled: true, target: { kind: 'postTypes' as const, tableSlugs: ['posts'] }, priority: 0 } }
    site.pages.push(layout, entry)
    site.styleRules = { ...site.styleRules, chrome: rule('chrome'), entry: rule('entry'), 'entry-state': rule('entry-state') }
    site.files.push({ id: 'entry-script', path: 'entry.js', type: 'script', content: "document.body.classList.add('entry-state')", createdAt: 0, updatedAt: 0 })
    manifests.set('entry', manifest('entry-script'))
    const { db } = dbFor(() => site, manifests)
    const pageRender = await renderPublishedSnapshot(snapshot(site, 'b', manifests), { db })
    const pageResponse = await requestCss(db, pageRender.cssBundle.style.filename)
    expect(pageResponse.status).toBe(200)
    expect(await pageResponse.text()).toBe(pageRender.cssBundle.style.content)
    expect(pageRender.cssBundle.style.content).toContain('.chrome {')
    expect(pageRender.cssBundle.style.content).toContain('.beta {')
    expect(pageRender.cssBundle.style.content).not.toContain('.alpha {')
    const merged = composeTemplateChain(resolveTemplateChain(site, { kind: 'entry', tableSlug: 'posts' }), { kind: 'entry' })
    const entryFile = buildSiteCssBundle(site, registry, merged, { runtimeAssets: manifests.get('entry') }).style
    const entryResponse = await requestCss(db, entryFile.filename)
    expect(entryResponse.status).toBe(200)
    expect(await entryResponse.text()).toBe(entryFile.content)
    expect(entryFile.content).toContain('.entry-state {')
    expect(entryFile.content).toContain('.chrome {')
    expect(entryFile.content).not.toContain('.beta {')
  })

  it('invalidates positive/negative CSS and manifest caches when publishing changes page styles', async () => {
    const { site, manifests } = makeFixture()
    let active = site
    const { db, manifestReads } = dbFor(() => active, manifests)
    const oldFile = buildSiteCssBundle(site, registry, site.pages[1], { runtimeAssets: manifests.get('b') }).style
    expect((await requestCss(db, oldFile.filename)).status).toBe(200)
    active = structuredClone(site)
    active.styleRules!.beta.styles = { color: 'red' }
    const newFile = buildSiteCssBundle(active, registry, active.pages[1], { runtimeAssets: manifests.get('b') }).style
    expect((await requestCss(db, newFile.filename)).status).toBe(404)
    bumpPublishVersion()
    const response = await requestCss(db, newFile.filename)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(newFile.content)
    expect((await requestCss(db, oldFile.filename)).status).toBe(404)
    expect(manifestReads()).toBe(2)
  })

  it('does not let an older in-flight negative result overwrite a newer publish', async () => {
    const { site, manifests } = makeFixture()
    let active = site
    let releaseOld: (() => void) | undefined
    let oldStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { oldStarted = resolve })
    const blocked = new Promise<void>((resolve) => { releaseOld = resolve })
    let readCount = 0
    const { db } = dbFor(() => active, manifests, async () => {
      if (++readCount === 1) { oldStarted!(); await blocked }
    })
    const next = structuredClone(site)
    next.styleRules!.beta.styles = { color: 'red' }
    const target = buildSiteCssBundle(next, registry, next.pages[1], { runtimeAssets: manifests.get('b') }).style
    const oldRequest = requestCss(db, target.filename)
    await started
    active = next
    bumpPublishVersion()
    expect((await requestCss(db, target.filename)).status).toBe(200)
    releaseOld!()
    expect((await oldRequest).status).toBe(404)
    const warm = await requestCss(db, target.filename)
    expect(warm.status).toBe(200)
    expect(await warm.text()).toBe(target.content)
  })
})
