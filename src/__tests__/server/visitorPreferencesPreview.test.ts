import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_SITE_VISITOR_PREFERENCES } from '@core/visitor-preferences-schema'
import { VISITOR_PREFERENCES_RUNTIME_JS, VISITOR_PREFERENCES_RUNTIME_PATH } from '@core/visitor-preferences'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { handleServerRequest } from '../../../server/router'
import { listDataRows, upsertDataRowDraft } from '../../../server/repositories/data'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import { buildRuntimePreviewDocument } from '../../../server/publish/runtime/previewRuntime'
import { makeModule, makePage, makeRegistry, makeSite } from '../publisher/helpers'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'

function expectMemoryPreferences(html: string) {
  expect(html).toContain(VISITOR_PREFERENCES_RUNTIME_PATH)
  expect(html).toContain('&quot;storage&quot;:&quot;memory&quot;')
  expect(html).not.toContain('&quot;storage&quot;:&quot;persistent&quot;')
}

describe('visitor preferences in private previews', () => {
  let harness: CapabilityTestHarness | undefined
  afterEach(async () => { await harness?.cleanup(); harness = undefined })

  it('uses document memory for the runtime-script preview', async () => {
    const page = makePage({ root: { moduleId: 'test.body' } })
    const registry = makeRegistry({ 'test.body': makeModule('test.body', { render: () => ({ html: '<main>Preview</main>' }) }) })
    const site = makeSite({ pages: [page], settings: { shortcuts: {}, visitorPreferences: DEFAULT_SITE_VISITOR_PREFERENCES } })
    const result = await buildRuntimePreviewDocument({ site, page, registry, assetBasePath: '/_instatic/preview/runtime/' })
    expect(result.diagnostics).toEqual([])
    expectMemoryPreferences(result.html)
  })

  it('keeps Content Live, shared branch previews and merge review memory-only', async () => {
    harness = await createCapabilityTestHarness()
    const cookie = await harness.setupOwner()
    const assetUrl = 'http://localhost' + VISITOR_PREFERENCES_RUNTIME_PATH
    const asset = await handleServerRequest(new Request(assetUrl), { db: harness.db })
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('application/javascript')
    expect(await asset.text()).toBe(VISITOR_PREFERENCES_RUNTIME_JS)
    const head = await handleServerRequest(new Request(assetUrl, { method: 'HEAD' }), { db: harness.db })
    expect(head.status).toBe(200)
    // The shared dispatcher normalizes HEAD; Bun.serve suppresses its wire body.
    expect(head.headers.get('content-type')).toBe(asset.headers.get('content-type'))
    const shell = (await getDraftSite(harness.db, MAIN_SCOPE))!
    await saveDraftSite(harness.db, MAIN_SCOPE, {
      ...shell,
      settings: { ...shell.settings, visitorPreferences: DEFAULT_SITE_VISITOR_PREFERENCES },
    })
    await upsertDataRowDraft(harness.db, MAIN_SCOPE, {
      id: 'preference-template', tableId: 'pages', slug: 'preference-template',
      cells: {
        title: 'Preview template', slug: 'preference-template', templateEnabled: true,
        templateTarget: { kind: 'postTypes', tableSlugs: ['posts'] }, templatePriority: 0,
        body: { rootNodeId: 'root', nodes: {
          root: { id: 'root', moduleId: 'base.text', props: { text: 'Private preview body' }, children: [], classIds: [], breakpointOverrides: {} },
        } },
      },
    })
    await upsertDataRowDraft(harness.db, MAIN_SCOPE, {
      id: 'preference-post', tableId: 'posts', slug: 'preference-post',
      cells: { title: 'Published entry', slug: 'preference-post' },
    })
    const published = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie })
    expect(published.status).toBe(200)
    const live = await harness.cms('/admin/api/cms/data/rows/preference-post/preview', {
      method: 'POST', cookie, json: { cells: { title: 'Draft entry' } },
    })
    expect(live.status).toBe(200)
    const liveHtml = await live.text()
    expect(liveHtml).toContain('<title>Draft entry')
    expectMemoryPreferences(liveHtml)

    const branches = '/admin/api/cms/branches'
    expect((await harness.cms(branches, { method: 'POST', cookie, json: { name: 'Preferences Preview' } })).status).toBe(201)
    const branchId = 'preferences-preview'
    const issued = await harness.cms(`${branches}/${branchId}/preview`, { method: 'POST', cookie })
    expect(issued.status).toBe(201)
    const { url } = await readJson<{ url: string }>(issued)
    const entry = await handleServerRequest(new Request(url), { db: harness.db })
    expect(entry.status).toBe(302)
    const previewCookie = entry.headers.get('set-cookie')!.split(';')[0]
    const previewRequest = new Request('http://localhost/')
    previewRequest.headers.set('cookie', previewCookie)
    const branchPreview = await handleServerRequest(previewRequest, { db: harness.db })
    expect(branchPreview.status).toBe(200)
    expect(branchPreview.headers.get('cache-control')).toBe('no-store')
    expectMemoryPreferences(await branchPreview.text())

    const home = (await listDataRows(harness.db, { branchId }, 'pages')).find(row => row.slug === 'index')
    const review = await harness.cms(`${branches}/${branchId}/review/render?row=${home!.id}&side=branch`, { cookie })
    expect(review.status).toBe(200)
    expect(review.headers.get('content-security-policy')).toBe('sandbox')
    expectMemoryPreferences(await review.text())
  }, 15_000)
})
