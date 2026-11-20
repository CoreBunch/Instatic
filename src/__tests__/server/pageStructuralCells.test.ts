/**
 * A page's head settings (`seo` cell) are a structural setting like its
 * access rule: the generic row write paths keep the stored value unless the
 * caller holds `site.structure.edit`, and normalise it when they do.
 */
import '@modules/base'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PageSeo } from '@core/page-tree'
import { hookBus } from '@core/plugins/hookBus'
import type { SiteBundle } from '@core/data/bundleSchema'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { mutatePageTree } from '../../../server/ai/content/treeService'
import { applySiteBundle } from '../../../server/handlers/cms/importApply'
import { resetForTests } from '../../../server/publish/renderCache'
import { createDataRow, getDataRow, listDataRows } from '../../../server/repositories/data'
import { listDataTables } from '../../../server/repositories/data/tables'
import { keepPageStructuralCells, newPageStructuralCells } from '../../../server/writePolicy/pageStructuralCells'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

const STORED: PageSeo = { description: 'Stored', robots: 'index, follow' }
const ATTEMPT: PageSeo = { description: 'Attempt', robots: 'noindex' }

const body = {
  rootNodeId: 'root',
  nodes: { root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] } },
}

describe('keepPageStructuralCells', () => {
  const stored = { tableId: 'pages', cells: { title: 'A', seo: STORED } }

  it('puts the stored seo back for a caller without structure rights', () => {
    expect(keepPageStructuralCells(stored, { title: 'B', seo: ATTEMPT }).seo).toEqual(STORED)
    expect(keepPageStructuralCells(stored, { title: 'B' }).seo).toEqual(STORED)
    expect(keepPageStructuralCells({ tableId: 'pages', cells: {} }, { seo: ATTEMPT }).seo).toBeUndefined()
  })

  it('lets a structure editor change it, normalised', () => {
    expect(keepPageStructuralCells(stored, { seo: { description: '  New  ', robots: 7 } }, true).seo)
      .toEqual({ description: 'New' })
    expect('seo' in keepPageStructuralCells(stored, { seo: { robots: '' } }, true)).toBe(false)
  })

  it('a new page keeps head settings only for a structure editor', () => {
    const cells = { title: 'N', seo: ATTEMPT, access: { level: 'members', onDeny: 'login' } }
    expect(newPageStructuralCells('pages', cells)).toEqual({ title: 'N', access: cells.access })
    expect(newPageStructuralCells('pages', cells, true).seo).toEqual(ATTEMPT)
    expect(newPageStructuralCells('posts', cells).seo).toEqual(ATTEMPT)
  })

  it('leaves other tables alone', () => {
    expect(keepPageStructuralCells({ tableId: 'posts', cells: {} }, { seo: 'anything' }).seo).toBe('anything')
  })
})

describe('row write paths', () => {
  let h: CapabilityTestHarness
  let ownerId: string

  beforeEach(async () => {
    resetForTests()
    hookBus.reset()
    h = await createCapabilityTestHarness()
    await h.setupOwner()
    const { rows } = await h.db<{ id: string }>`select id from users limit 1`
    ownerId = rows[0].id
    await createDataRow(h.db, MAIN_SCOPE, { id: 'page_a', tableId: 'pages', cells: { title: 'A', slug: 'a', body, seo: STORED }, slug: 'a' }, ownerId)
  })
  afterEach(async () => {
    hookBus.reset()
    await h.cleanup()
  })

  const storedSeo = async () => (await getDataRow(h.db, MAIN_SCOPE, 'page_a'))?.cells.seo
  const cells = async () => (await getDataRow(h.db, MAIN_SCOPE, 'page_a'))!.cells

  it('a content editor cannot change or drop it through the rows API', async () => {
    const writer = await h.createRoleUser({
      name: 'Writer', slug: 'writer', capabilities: ['content.edit.any', 'content.publish.any', 'data.system.tables.read'],
    })
    const changed = await h.cms('/admin/api/cms/data/rows/page_a', {
      method: 'PATCH', cookie: writer.cookie, json: { cells: { ...(await cells()), seo: ATTEMPT } },
    })
    expect(changed.status).toBe(200)
    expect(await storedSeo()).toEqual(STORED)

    const { seo: _dropped, ...withoutSeo } = await cells()
    await h.cms('/admin/api/cms/data/rows/page_a', { method: 'PATCH', cookie: writer.cookie, json: { cells: withoutSeo } })
    expect(await storedSeo()).toEqual(STORED)
  })

  it('a structure editor can, and the stored value is normalised', async () => {
    const builder = await h.createRoleUser({
      name: 'Builder', slug: 'builder', capabilities: ['content.edit.any', 'data.system.tables.read', 'site.structure.edit'],
    })
    await h.cms('/admin/api/cms/data/rows/page_a', {
      method: 'PATCH', cookie: builder.cookie, json: { cells: { ...(await cells()), seo: { description: ' New ', robots: 42 } } },
    })
    expect(await storedSeo()).toEqual({ description: 'New' })
  })

  it('the AI tree tools keep it even when a cells filter rewrites it', async () => {
    hookBus.filter('plugin.rewriter', 'content.entry.cells', (value) => ({ ...(value as object), seo: ATTEMPT }))
    await mutatePageTree(h.db, MAIN_SCOPE, 'page_a', 'body', [], { kind: 'user', userId: ownerId })
    expect(await storedSeo()).toEqual(STORED)
  })

  it('creating a page through the rows API needs structure rights to carry head settings', async () => {
    // The editor-managed page fields cannot be set here; an extra cell can.
    const create = async (cookie: string) => {
      const res = await h.cms('/admin/api/cms/data/tables/pages/rows', { method: 'POST', cookie, json: { cells: { seo: ATTEMPT } } })
      expect(res.status).toBeLessThan(300)
      const { row } = await res.json() as { row: { id: string } }
      return (await getDataRow(h.db, MAIN_SCOPE, row.id))?.cells.seo
    }
    const writer = await h.createRoleUser({
      name: 'Writer', slug: 'writer', capabilities: ['content.create', 'content.edit.any', 'data.system.tables.read'],
    })
    const builder = await h.createRoleUser({
      name: 'Builder', slug: 'builder', capabilities: ['content.create', 'content.edit.any', 'data.system.tables.read', 'site.structure.edit'],
    })
    expect(await create(writer.cookie)).toBeUndefined()
    expect(await create(builder.cookie)).toEqual(ATTEMPT)
  })

  it('a bundle import of a new page id drops head settings without structure rights', async () => {
    const tables = await listDataTables(h.db, MAIN_SCOPE)
    const [page] = await listDataRows(h.db, MAIN_SCOPE, 'pages')
    const fresh = { ...page!, id: 'page_new', slug: 'new', cells: { ...page!.cells, slug: 'new', seo: ATTEMPT } }
    const bundle: SiteBundle = { schemaVersion: 1, exportedAt: new Date(0).toISOString(), tables, rows: [fresh] }
    await applySiteBundle(h.db, MAIN_SCOPE, { bundle, strategy: 'merge-overwrite', carriesMedia: false, mayChangePageStructure: false })
    expect((await getDataRow(h.db, MAIN_SCOPE, 'page_new'))?.cells.seo).toBeUndefined()
  })

  it('a bundle import keeps it unless the importer may change structure', async () => {
    const tables = await listDataTables(h.db, MAIN_SCOPE)
    const rows = (await listDataRows(h.db, MAIN_SCOPE, 'pages')).map((row) =>
      row.id === 'page_a' ? { ...row, cells: { ...row.cells, seo: ATTEMPT } } : row,
    )
    const bundle: SiteBundle = { schemaVersion: 1, exportedAt: new Date(0).toISOString(), tables, rows }
    await applySiteBundle(h.db, MAIN_SCOPE, { bundle, strategy: 'merge-overwrite', carriesMedia: false, mayChangePageStructure: false })
    expect(await storedSeo()).toEqual(STORED)
    await applySiteBundle(h.db, MAIN_SCOPE, { bundle, strategy: 'merge-overwrite', carriesMedia: false, mayChangePageStructure: true })
    expect(await storedSeo()).toEqual(ATTEMPT)
  })
})
