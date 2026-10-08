import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { responseErrorMessage } from '@core/http'
import { createCapabilityTestHarness } from '../helpers/capabilityHarness'
import { makeNode, makePage, makeSite, makeVC, makeVCTree } from '../fixtures'
import { createDataRow, saveDataRowDraft } from '../../../server/repositories/data'
import { saveDraftSite } from '../../../server/repositories/site'
import { pageToCells } from '@core/data/pageFromRow'
import { visualComponentToCells } from '@core/data/componentFromRow'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { getPublishVersion } from '../../../server/publish/publishState'
import { getActiveSlot, readArtefact } from '../../../server/publish/staticArtefact'

describe('infinite-loop configuration publication boundary', () => {
  it('returns 422 before changing the previous generation or artefact for nested and repeated instances', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-loop-scope-'))
    const harness = await createCapabilityTestHarness({ uploadsDir })
    try {
      const cookie = await harness.setupOwner()
      const owner = (await harness.db<{ id: string }>`select id from users limit 1`).rows[0]!
      const page = makePage({ id: 'scope-page', slug: 'scope', title: 'Loop scope', nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.body', children: ['text'] }),
        text: makeNode({ id: 'text', moduleId: 'base.text', props: { text: 'Previous generation' } }),
      } })
      const component = makeVC({ id: 'listing', name: 'Listing', tree: makeVCTree('loop', [
        makeNode({ id: 'loop', moduleId: 'base.loop', props: { sourceId: 'data.rows', filters: { tableId: 'posts' }, pagination: 'infinite', pageSize: 1 }, children: ['card'] }),
        makeNode({ id: 'card', moduleId: 'base.text', props: { text: '{currentEntry.title}' } }),
      ]) })
      await saveDraftSite(harness.db, MAIN_SCOPE, makeSite())
      await createDataRow(harness.db, MAIN_SCOPE, { id: page.id, tableId: 'pages', slug: page.slug, cells: pageToCells(page) }, owner.id)
      await createDataRow(harness.db, MAIN_SCOPE, { id: component.id, tableId: 'components', slug: 'listing', cells: visualComponentToCells(component) }, owner.id)
      const initial = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie })
      expect(initial.status).toBe(200)
      const snapshots = (await harness.db`select id, content_hash from site_snapshots order by id`).rows
      const versions = (await harness.db`select id, row_id, version_number from data_row_versions order by id`).rows
      const activeRows = (await harness.db`select id, active_version_id from data_rows order by id`).rows
      const publishVersion = getPublishVersion()
      const slot = await getActiveSlot(uploadsDir)
      const artefact = await readArtefact(uploadsDir, '/scope')
      expect(artefact).toContain('Previous generation')

      for (const mode of ['nested', 'duplicate'] as const) {
        page.nodes.ref = makeNode({ id: 'ref', moduleId: 'base.visual-component-ref', props: { componentId: 'listing' } })
        if (mode === 'nested') {
          page.nodes.root.children = ['outer']
          page.nodes.outer = makeNode({ id: 'outer', moduleId: 'base.loop', props: { sourceId: 'data.rows', filters: { tableId: 'posts' } }, children: ['ref'] })
        } else {
          page.nodes.root.children = ['ref', 'ref2']
          page.nodes.ref2 = makeNode({ id: 'ref2', moduleId: 'base.visual-component-ref', props: { componentId: 'listing' } })
        }
        await saveDataRowDraft(harness.db, MAIN_SCOPE, page.id, { cells: pageToCells(page), slug: page.slug }, owner.id)
        const response = await harness.cms('/admin/api/cms/publish', { method: 'POST', cookie })
        expect(response.status).toBe(422)
        const error = await responseErrorMessage(response, 'Invalid loop configuration')
        expect(error).toContain('Infinite loop "loop"')
        expect(error).toContain(mode === 'nested' ? 'inside another loop' : 'multiple instances')
        expect((await harness.db`select id, content_hash from site_snapshots order by id`).rows).toEqual(snapshots)
        expect((await harness.db`select id, row_id, version_number from data_row_versions order by id`).rows).toEqual(versions)
        expect((await harness.db`select id, active_version_id from data_rows order by id`).rows).toEqual(activeRows)
        expect(getPublishVersion()).toBe(publishVersion)
        expect(await getActiveSlot(uploadsDir)).toBe(slot)
        expect(await readArtefact(uploadsDir, '/scope')).toBe(artefact)
      }
    } finally {
      await harness.cleanup()
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
