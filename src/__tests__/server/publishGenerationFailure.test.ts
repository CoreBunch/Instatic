import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import { registry } from '@core/module-engine'
import type { Page } from '@core/page-tree'
import { pageToCells } from '@core/data/pageFromRow'
import { makeModule } from '../publisher/helpers'
import { createCapabilityTestHarness, readJson, type CapabilityTestHarness } from '../helpers/capabilityHarness'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { getDraftSiteDocument } from '../../../server/repositories/publish'
import { saveDraftSite } from '../../../server/repositories/site'
import { publishDraftSite } from '../../../server/publish/publishSite'
import { getPublishVersion } from '../../../server/publish/publishState'
import * as staticIO from '../../../server/publish/staticArtefact'

const moduleId = 'test.publication-generation'
const renderFailure = new Error('Injected generation render failure')
let harness: CapabilityTestHarness | undefined
let uploadsDir: string | undefined

afterEach(async () => {
  registry.unregister(moduleId)
  await harness?.cleanup()
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true })
  harness = undefined
  uploadsDir = undefined
})

async function setup() {
  uploadsDir = await mkdtemp(join(tmpdir(), 'publish-generation-'))
  harness = await createCapabilityTestHarness({ uploadsDir })
  const owner = await harness.setupOwner()
  const { rows: [{ id: userId }] } = await harness.db.unsafe<{ id: string }>('SELECT id FROM users')
  const site = (await getDraftSiteDocument(harness.db, MAIN_SCOPE))!
  registry.register(makeModule(moduleId, {
    propsSchema: Type.Object({ fail: Type.Boolean() }),
    schema: { fail: { type: 'toggle', label: 'Fail' } },
    defaults: { fail: false },
    render: (props) => {
      if (props.fail) throw renderFailure
      return { html: '<p>Healthy generation</p>' }
    },
  }))
  return { harness, owner, userId, site }
}

function probePage(source: Page, id: string, slug: string): Page {
  const root = source.nodes[source.rootNodeId]
  return {
    ...source, id, slug,
    nodes: {
      [root.id]: { ...root, children: ['probe'] },
      probe: { id: 'probe', moduleId, props: { fail: false }, children: [], classIds: [], breakpointOverrides: {} },
    },
  }
}

async function publishedState(db: CapabilityTestHarness['db']) {
  return {
    snapshots: await db.unsafe('SELECT * FROM site_snapshots ORDER BY id'),
    versions: await db.unsafe('SELECT * FROM data_row_versions ORDER BY id'),
    active: await db.unsafe('SELECT id, active_version_id FROM data_rows ORDER BY id'),
    version: getPublishVersion(),
  }
}

describe('complete publication generation', () => {
  for (const scope of ['page', 'notFound', 'entry'] as const) {
    it(`preserves the active generation when the ${scope} render fails and publishes a corrected retry`, async () => {
      const { harness, owner, userId, site } = await setup()
      const source = site.pages[0]
      const page = scope === 'page'
        ? probePage(source, source.id, source.slug)
        : probePage(source, `${scope}-template`, `${scope}-template`)
      if (scope === 'notFound') page.template = { enabled: true, target: { kind: 'notFound' }, priority: 10 }
      if (scope === 'entry') page.template = { enabled: true, target: { kind: 'postTypes', tableSlugs: ['posts'] }, priority: 10 }
      if (scope === 'page') {
        await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
      } else {
        await createDataRow(harness.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', cells: pageToCells(page), slug: page.slug }, userId)
      }
      await saveDraftSite(harness.db, MAIN_SCOPE, site)
      await publishDraftSite(harness.db, userId, uploadsDir)
      const path = scope === 'page' ? '/' : scope === 'notFound' ? '/404' : '/posts/published-entry'
      if (scope === 'entry') {
        const response = await harness.cms('/admin/api/cms/data/tables/posts/rows', {
          method: 'POST', cookie: owner, json: { cells: { title: 'Published entry', slug: 'published-entry' } },
        })
        expect(response.status).toBe(201)
        const rowId = (await readJson<{ row: { id: string } }>(response)).row.id
        expect((await harness.cms(`/admin/api/cms/data/rows/${rowId}/publish`, { method: 'POST', cookie: owner })).status).toBe(200)
        await publishDraftSite(harness.db, userId, uploadsDir)
      }
      const before = await publishedState(harness.db)
      const slot = await staticIO.getActiveSlot(uploadsDir!)
      const html = await staticIO.readArtefact(uploadsDir!, path)
      expect(html).toContain('Healthy generation')
      page.nodes.probe.props.fail = true
      await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
      await expect(publishDraftSite(harness.db, userId, uploadsDir)).rejects.toBe(renderFailure)
      expect(await publishedState(harness.db)).toEqual(before)
      expect(await staticIO.getActiveSlot(uploadsDir!)).toBe(slot)
      expect(await staticIO.readArtefact(uploadsDir!, path)).toBe(html)
      page.nodes.probe.props.fail = false
      await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
      await publishDraftSite(harness.db, userId, uploadsDir)
      expect(getPublishVersion()).toBe(before.version + 1)
      expect(await staticIO.readArtefact(uploadsDir!, path)).toContain('Healthy generation')
    }, 15_000)
  }

  it('rejects artefact I/O failures before changing snapshots or activating a partial slot', async () => {
    const { harness, userId } = await setup()
    await publishDraftSite(harness.db, userId, uploadsDir)
    const before = await publishedState(harness.db)
    const slot = await staticIO.getActiveSlot(uploadsDir!)
    const html = await staticIO.readArtefact(uploadsDir!, '/')
    const failure = new Error('Injected HTML write failure')
    const write = spyOn(staticIO, 'writeArtefact').mockRejectedValue(failure)
    try {
      await expect(publishDraftSite(harness.db, userId, uploadsDir)).rejects.toBe(failure)
      expect(await publishedState(harness.db)).toEqual(before)
      expect(await staticIO.getActiveSlot(uploadsDir!)).toBe(slot)
      expect(await staticIO.readArtefact(uploadsDir!, '/')).toBe(html)
    } finally { write.mockRestore() }
  }, 15_000)

  it('validates resolved renders even when no artefact directory is requested', async () => {
    const { harness, userId, site } = await setup()
    const page = probePage(site.pages[0], site.pages[0].id, site.pages[0].slug)
    await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
    await publishDraftSite(harness.db, userId)
    const before = await publishedState(harness.db)
    page.nodes.probe.props.fail = true
    await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug })
    await expect(publishDraftSite(harness.db, userId)).rejects.toBe(renderFailure)
    expect(await publishedState(harness.db)).toEqual(before)
  }, 15_000)
})
