import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, type TestDb } from '../helpers/createTestDb'
import { makeModule, makePage, makeRegistry, makeSite } from '../publisher/helpers'
import { prefetchLoopData, publishedDataRowToLoopItem } from '../../../server/publish/loopPrefetch'
import { prefetchRelationLoopItems } from '../../../server/publish/relationLoopPrefetch'
import { fetchPublishedDataRowItems } from '@core/loops/sources/dataRows'
import { entryFieldContextKey, entryScopeTables, entryScopeRepeater, resolveEntryFieldItems, type LoopItem } from '@core/loops'
import { publishPage } from '@core/publisher'
import { getDataTable } from '../../../server/repositories/data'
import { forkBranch } from '../../../server/branches/fork'
import type { PublishedDataRow } from '@core/data/schemas'
import '@core/loops/sources'

let fixture: TestDb
const offerFields = [
  { id: 'teammembers', label: 'Team members', type: 'relation', targetTableId: 'team', allowMultiple: true },
  { id: 'weeklySlots', label: 'Weekly slots', type: 'repeater', fields: [
    { id: 'weekday', label: 'Weekday', type: 'select', options: [
      { id: 'thursday-id', label: 'Thursday', value: 'thursday' },
      { id: 'friday-id', label: 'Friday', value: 'friday' },
      { id: 'monday-id', label: 'Monday', value: 'monday' },
    ] },
    { id: 'startTime', label: 'Start time', type: 'text' },
    { id: 'endTime', label: 'End time', type: 'text' },
    { id: 'photo', label: 'Photo', type: 'media' },
  ] },
]
const teamFields = [
  { id: 'title', label: 'Name', type: 'text' },
  { id: 'function', label: 'Function', type: 'text' },
  { id: 'photo', label: 'Photo', type: 'media' },
  { id: 'colleagues', label: 'Colleagues', type: 'relation', targetTableId: 'team', allowMultiple: true },
]
const offers: LoopItem[] = [
  { id: 'offer-a', fields: { tableId: 'offers', title: 'Art', teammembers: ['marc', 'niko', 'draft', 'deleted', 'missing'], weeklySlots: [
    { id: 'thu', cells: { weekday: 'thursday-id', startTime: '15:00', endTime: '18:30' } },
    { id: 'fri', cells: { weekday: 'friday-id', startTime: '16:00', endTime: '19:00' } },
  ] } },
  { id: 'offer-b', fields: { tableId: 'offers', title: 'Media', teammembers: ['niko'], weeklySlots: [
    { id: 'thu', cells: { weekday: 'monday-id', startTime: '10:00', endTime: '12:00' } },
  ] } },
  { id: 'offer-empty', fields: { tableId: 'offers', title: 'Empty', teammembers: [] } },
]

beforeAll(async () => {
  fixture = await createTestDb()
  const db = fixture.db
  for (const [id, kind, fields] of [['offers', 'data', offerFields], ['team', 'postType', teamFields]] as const) {
    await db`insert into data_tables (id, name, slug, kind, fields_json, singular_label, plural_label)
      values (${id}, ${id}, ${id}, ${kind}, ${JSON.stringify(fields)}, ${id}, ${id})`
  }
  await db`insert into media_assets (id, filename, mime_type, size_bytes, storage_path, public_path, storage_adapter_id, externally_hosted)
    values ('photo', 'team.png', 'image/png', 100, 'team.png', '/uploads/team.png', '', 0)`
  for (const id of ['marc', 'niko', 'draft', 'deleted']) {
    const cells = { title: id.toUpperCase(), function: `${id} role`, photo: 'photo', colleagues: ['niko'] }
    const version = `${id}-v1`
    await db`insert into data_rows (id, table_id, cells_json, slug, status)
      values (${id}, 'team', ${JSON.stringify({ ...cells, title: 'UNPUBLISHED EDIT' })}, ${id}, ${id === 'draft' ? 'draft' : 'published'})`
    await db`insert into data_row_versions (id, row_id, version_number, cells_json, slug)
      values (${version}, ${id}, 1, ${JSON.stringify(cells)}, ${id})`
    await db`update data_rows set active_version_id = ${version} where id = ${id}`
  }
  await db`update data_rows set deleted_at = '2026-01-01' where id = 'deleted'`
  for (const offer of offers) {
    await db`insert into data_rows (id, table_id, cells_json, slug)
      values (${offer.id}, 'offers', ${JSON.stringify(offer.fields)}, ${offer.id})`
  }
})
afterAll(async () => { await fixture.cleanup() })

const page = () => makePage({
  root: { moduleId: 'base.body', children: ['outer'] },
  outer: { moduleId: 'base.loop', props: { sourceId: 'data.rows', filters: { tableId: 'offers' }, direction: 'asc', orderBy: 'slug', limit: 10 }, children: ['inner'] },
  inner: { moduleId: 'base.loop', props: { sourceId: 'entry.field', filters: { fieldId: 'teammembers' }, direction: 'asc', limit: 10 }, children: ['card'] },
  card: { moduleId: 'test.member', props: {}, dynamicBindings: {
    offer: { source: 'parentEntry', field: 'title' },
    name: { source: 'currentEntry', field: 'title' },
    role: { source: 'currentEntry', field: 'function' },
    photo: { source: 'currentEntry', field: 'photo' },
  } },
})
const registry = makeRegistry({
  'base.body': makeModule('base.body', { canHaveChildren: true, render: (_, children) => ({ html: `<main>${children.join('')}</main>` }) }),
  'base.loop': makeModule('base.loop', { canHaveChildren: true }),
  'test.member': makeModule('test.member', { render: (props) => ({ html: `<p>${props.offer}/${props.name}/${props.role}</p><img src="${props.photo}">` }) }),
})

describe('related entry loops', () => {
  it('resolves nested relations for the supplied load-more slice without loading the first page again', async () => {
    const tree = page()
    const site = makeSite()
    const slice = { items: [offers[1]!], totalItems: 3, pageNumber: 2, hasMore: true }
    const loopData = await prefetchLoopData(tree, site, fixture.db, undefined, {
      rootNodeId: 'outer', resolvedLoops: new Map([['outer', slice]]),
    })
    expect(loopData.get('outer')).toBe(slice)
    const html = publishPage(tree, site, registry, { loopData }).html
    expect(html).toContain('Media/NIKO/niko role')
    expect(html).not.toContain('Art/')
    expect(html).not.toContain('MARC')
  })

  it('projects repeater select labels and media for an individual entry without changing stored cells', async () => {
    const cells = { weeklySlots: [{ id: 'thu', cells: { weekday: 'thursday-id', photo: 'photo' } }] }
    const row: PublishedDataRow = {
      id: 'offer-version', rowId: 'offer-a', tableId: 'offers', tableSlug: 'offers',
      tableKind: 'postType', tableRouteBase: '/offers', versionNumber: 1, cells, slug: 'art',
      featuredMediaId: null, featuredMediaPath: null, authorUserId: null, authorName: null,
      authorRoleSlug: null, authorRoleName: null, publishedByUserId: null, publishedByName: null,
      publishedByRoleSlug: null, publishedByRoleName: null,
      publishedAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
    }
    const entry = await publishedDataRowToLoopItem(fixture.db, row)
    const slots = resolveEntryFieldItems(entry.fields.weeklySlots)
    expect(slots.items[0]?.fields).toMatchObject({ weekday: 'Thursday', photo: '/uploads/team.png' })
    expect(cells.weeklySlots[0]?.cells).toEqual({ weekday: 'thursday-id', photo: 'photo' })
  })

  it('renders repeater cells per offer, including multiple slots and an empty field', async () => {
    const tree = page()
    tree.nodes.inner!.props.filters = { fieldId: 'weeklySlots' }
    tree.nodes.card!.moduleId = 'test.slot'
    tree.nodes.card!.dynamicBindings = {
      offer: { source: 'parentEntry', field: 'title' },
      day: { source: 'currentEntry', field: 'weekday' },
      start: { source: 'currentEntry', field: 'startTime' },
      end: { source: 'currentEntry', field: 'endTime' },
    }
    const modules = makeRegistry({
      'base.body': makeModule('base.body', { canHaveChildren: true, render: (_, children) => ({ html: children.join('') }) }),
      'base.loop': makeModule('base.loop', { canHaveChildren: true }),
      'test.slot': makeModule('test.slot', { render: (p) => ({ html: `<p>${p.offer}/${p.day}/${p.start}/${p.end}</p>` }) }),
    })
    const site = makeSite()
    const loopData = await prefetchLoopData(tree, site, fixture.db)
    const html = publishPage(tree, site, modules, { loopData }).html
    expect(html).toContain('Art/Thursday/15:00/18:30')
    expect(html).toContain('Art/Friday/16:00/19:00')
    expect(html).toContain('Media/Monday/10:00/12:00')
    expect(html).not.toContain('Media/Thursday')
    expect(html).not.toContain('Empty/')
    const tables = [await getDataTable(fixture.db, { branchId: 'main' }, 'offers')].filter((t) => t !== null)
    expect(entryScopeRepeater(tree, 'card', tables)?.fields.map((f) => f.id)).toEqual(['weekday', 'startTime', 'endTime', 'photo'])
    expect(entryScopeTables(tree, 'card', tables)).toEqual([])
  })

  it('preserves repeater identity, ordering and the original value while exposing its cells', () => {
    const value = offers[0]!.fields.weeklySlots
    const result = resolveEntryFieldItems(value, { direction: 'desc', limit: 1 })
    expect(result.totalItems).toBe(2)
    expect(result.items[0]?.id).toBe('fri')
    expect(result.items[0]?.fields).toMatchObject({ weekday: 'friday-id', startTime: '16:00', endTime: '19:00', index: 0 })
    expect(result.items[0]?.fields.value).toEqual((value as unknown[])[1])
  })

  it('renders each offer with its own published team fields and resolved images', async () => {
    const tree = page()
    const site = makeSite()
    const loopData = await prefetchLoopData(tree, site, fixture.db)
    const html = publishPage(tree, site, registry, { loopData }).html
    expect(html).toContain('Art/MARC/marc role')
    expect(html).toContain('Art/NIKO/niko role')
    expect(html).toContain('Media/NIKO/niko role')
    expect(html).not.toContain('Media/MARC')
    expect(html).not.toContain('UNPUBLISHED EDIT')
    expect(html).not.toContain('DRAFT')
    expect(html).not.toContain('DELETED')
    expect(html.match(/src="\/uploads\/team.png"/g)).toHaveLength(3)
    expect(html.indexOf('Art/MARC')).toBeLessThan(html.indexOf('Art/NIKO'))
  })

  it('supports an entry-template seed and reversed slices after missing targets are removed', async () => {
    const tree = page()
    tree.rootNodeId = 'inner'
    tree.nodes.inner!.props.offset = 1
    tree.nodes.inner!.props.limit = 1
    tree.nodes.inner!.props.direction = 'desc'
    const loopData = await prefetchLoopData(tree, makeSite(), fixture.db, undefined, { entryStack: [offers[0]!] })
    const html = publishPage(tree, makeSite(), registry, { loopData, templateContext: { entryStack: [offers[0]!] } }).html
    expect(html).toContain('Art/MARC')
    expect(html).not.toContain('Art/NIKO')
  })

  it('resolves deeper relation loops without recursively expanding cyclic content', async () => {
    const tree = page()
    tree.nodes.card!.moduleId = 'base.loop'
    tree.nodes.card!.props = { sourceId: 'entry.field', filters: { fieldId: 'colleagues' }, direction: 'asc', limit: 10 }
    const loopData = await prefetchLoopData(tree, makeSite(), fixture.db)
    expect(loopData.get('card')?.items.map((item) => item.fields.title)).toEqual(['NIKO', 'NIKO', 'NIKO'])
  })

  it('keeps an empty relation empty and preserves ordinary string collections', async () => {
    const related = await prefetchRelationLoopItems(fixture.db, offers, 'teammembers', { limit: 10, offset: 0, direction: 'asc' })
    expect(related.get(entryFieldContextKey(offers[2]!))).toEqual([])
    const ordinary = await prefetchRelationLoopItems(fixture.db, offers, 'title', { limit: 10, offset: 0, direction: 'asc' })
    expect(ordinary.size).toBe(0)
    expect(resolveEntryFieldItems(['marc']).items[0]?.fields.value).toBe('marc')
  })

  it('offers target table fields inside a relation, including another nested relation', async () => {
    const scope = { branchId: 'main' }
    const tables = (await Promise.all(['offers', 'team'].map((id) => getDataTable(fixture.db, scope, id)))).filter((table) => table !== null)
    const tree = page()
    expect(entryScopeTables(tree, 'inner', tables).map((table) => table.id)).toEqual(['offers'])
    expect(entryScopeTables(tree, 'card', tables)[0]?.fields.map((field) => field.id)).toContain('function')
    tree.nodes.inner!.props.filters = { fieldId: 'not-a-relation' }
    expect(entryScopeTables(tree, 'card', tables)).toEqual([])
  })

  it('uses the same exact-ID projection for preview and excludes unrelated rows', async () => {
    const result = await fetchPublishedDataRowItems(fixture.db, {
      tableId: 'team', rowIds: ['niko', 'missing', 'draft'], limit: 6, offset: 0, direction: 'asc', orderBy: 'slug',
    })
    expect(result.items.map((item) => item.fields.title)).toEqual(['NIKO'])
    expect(result.items[0]?.fields.photo).toBe('/uploads/team.png')
  })

  it('reads target drafts from the selected branch without changing public main output', async () => {
    await forkBranch(fixture.db, { id: 'relation-preview', name: 'Relation preview', fromBranchId: 'main', createdByUserId: null })
    const loopData = await prefetchLoopData(page(), makeSite(), fixture.db, undefined, { branchId: 'relation-preview' })
    const members = loopData.get('inner')!.items
    expect(members.length).toBeGreaterThan(0)
    expect(members.every((member) => member.fields.tableId === 'relation-preview:team')).toBe(true)
    expect(members.every((member) => member.fields.title === 'UNPUBLISHED EDIT')).toBe(true)
    const main = await prefetchLoopData(page(), makeSite(), fixture.db)
    expect(main.get('inner')!.items.map((member) => member.fields.title)).toEqual(['MARC', 'NIKO', 'NIKO'])
  })
})
