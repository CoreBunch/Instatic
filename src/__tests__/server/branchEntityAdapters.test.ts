/**
 * Every branch entity adapter honours one contract: collect lists what a
 * scope holds, parse refuses malformed content, write puts content on a
 * scope (null removes it) so that collect reads it back, and describe names
 * its own kind. Plan, apply, undo, fork, and delete are built on nothing
 * else, so a kind that passes this is a kind they can carry.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { SITE_SHELL_LOGICAL_ID } from '@core/branches'
import {
  ENTITY_KINDS,
  MergeApplyError,
  adapterFor,
  contentOf,
  entityKey,
  entitySource,
  type BranchEntityKind,
  type WriteContext,
} from '../../../server/branches/entities'
import { MAIN_SCOPE } from '../../../server/branches/scope'
import { createCapabilityTestHarness, type CapabilityTestHarness } from '../helpers/capabilityHarness'

function context(): WriteContext {
  return { actorUserId: null, notices: { rows: [], shell: false } }
}

function ref(kind: BranchEntityKind, logicalId: string, label = logicalId) {
  return { kind, logicalId, key: entityKey(kind, logicalId), label }
}

describe('branch entity adapters', () => {
  let harness: CapabilityTestHarness | null = null

  afterEach(async () => {
    await harness?.cleanup()
    harness = null
  })

  it('registers one adapter per kind, in apply order', () => {
    expect(ENTITY_KINDS).toEqual(['site', 'file', 'table', 'row'])
    for (const kind of ENTITY_KINDS) expect(adapterFor(kind).kind).toBe(kind)
    // A table is created before the rows that need it and deleted after they are gone.
    expect(adapterFor('table').order('create')).toBeLessThan(adapterFor('row').order('create'))
    expect(adapterFor('row').order('delete')).toBeLessThan(adapterFor('table').order('delete'))
  })

  it('refuses malformed content on every kind', () => {
    for (const kind of ENTITY_KINDS) {
      expect(() => adapterFor(kind).parse({ nope: true })).toThrow(/malformed/)
    }
  })

  it('site: collects the shell, writes its name, and never deletes it', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const site = adapterFor('site')
    const [shell] = await site.collect(entitySource(harness.db, MAIN_SCOPE))
    const content = contentOf('site', shell)!
    const ctx = context()
    await site.write(harness.db, MAIN_SCOPE, ref('site', SITE_SHELL_LOGICAL_ID, 'Site settings'), { ...content, name: 'Renamed site' }, ctx)
    expect(ctx.notices.shell).toBe(true)
    const [renamed] = await site.collect(entitySource(harness.db, MAIN_SCOPE))
    expect(contentOf('site', renamed)!.name).toBe('Renamed site')
    await site.write(harness.db, MAIN_SCOPE, ref('site', SITE_SHELL_LOGICAL_ID), null, context())
    expect(await site.collect(entitySource(harness.db, MAIN_SCOPE))).toHaveLength(1)
    const detail = site.describe(content, { ...content, name: 'Renamed site' }, [], null)
    expect(detail.kind).toBe('site')
    expect(detail.fields.map((field) => field.id)).toEqual(['name'])
  })

  it('file: writes into the shell, reports a taken path, and removes on null', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const file = adapterFor('file')
    const a = { path: 'scripts/a.ts', type: 'script' as const, content: 'export const a = 1' }
    await file.write(harness.db, MAIN_SCOPE, ref('file', 'f-a', a.path), a, context())
    const collected = await file.collect(entitySource(harness.db, MAIN_SCOPE))
    expect(collected.map((entity) => entityKey(entity.kind, entity.logicalId))).toContain('file:f-a')
    // A second file on the same path: seen by the plan, refused by the write.
    const into = new Map(collected.map((entity) => [entityKey(entity.kind, entity.logicalId), entity]))
    expect(file.collision?.({ ...a }, 'f-b', into)).toBe('(path)')
    await expect(file.write(harness.db, MAIN_SCOPE, ref('file', 'f-b', a.path), a, context())).rejects.toBeInstanceOf(MergeApplyError)
    await file.write(harness.db, MAIN_SCOPE, ref('file', 'f-a', a.path), null, context())
    expect((await file.collect(entitySource(harness.db, MAIN_SCOPE))).some((entity) => entity.logicalId === 'f-a')).toBe(false)
    expect(file.describe(a, { ...a, content: 'export const a = 2' }, [], null)).toMatchObject({ kind: 'file', path: a.path, binary: false })
  })

  it('table and row: write, read back with a readable label, and remove in order', async () => {
    harness = await createCapabilityTestHarness()
    await harness.setupOwner()
    const table = adapterFor('table')
    const row = adapterFor('row')
    const faq = {
      name: 'FAQ',
      slug: 'faq',
      kind: 'data' as const,
      routeBase: '/faq',
      singularLabel: 'Question',
      pluralLabel: 'Questions',
      primaryFieldId: 'question',
      fields: [{ type: 'text' as const, id: 'question', label: 'Question' }],
    }
    await table.write(harness.db, MAIN_SCOPE, ref('table', 'faq', 'FAQ'), faq, context())
    const tables = await table.collect(entitySource(harness.db, MAIN_SCOPE))
    expect(contentOf('table', tables.find((entity) => entity.logicalId === 'faq'))).toMatchObject({ name: 'FAQ', primaryFieldId: 'question' })

    const created = context()
    await row.write(harness.db, MAIN_SCOPE, ref('row', 'faq-1'), { tableId: 'faq', cells: { question: 'Why?' }, slug: 'why' }, created)
    expect(created.notices.rows).toEqual([{ kind: 'create', tableId: 'faq', rowId: 'faq-1', changedFieldIds: [] }])
    const rows = await row.collect(entitySource(harness.db, MAIN_SCOPE))
    const entity = rows.find((candidate) => candidate.logicalId === 'faq-1')!
    // Named by the table's primary field, never by its id.
    expect(entity.label).toBe('Why?')
    expect(entity.tableName).toBe('Question')

    const updated = context()
    await row.write(harness.db, MAIN_SCOPE, ref('row', 'faq-1'), { tableId: 'faq', cells: { question: 'Why not?' }, slug: 'why' }, updated)
    expect(updated.notices.rows).toEqual([{ kind: 'update', tableId: 'faq', rowId: 'faq-1', changedFieldIds: ['question'] }])

    // A table with rows refuses to go; the row goes first.
    await expect(table.write(harness.db, MAIN_SCOPE, ref('table', 'faq', 'FAQ'), null, context())).rejects.toBeInstanceOf(MergeApplyError)
    const deleted = context()
    await row.write(harness.db, MAIN_SCOPE, ref('row', 'faq-1'), null, deleted)
    expect(deleted.notices.rows).toEqual([{ kind: 'delete', tableId: 'faq', rowId: 'faq-1', changedFieldIds: [] }])
    await table.write(harness.db, MAIN_SCOPE, ref('table', 'faq', 'FAQ'), null, context())
    expect((await table.collect(entitySource(harness.db, MAIN_SCOPE))).some((candidate) => candidate.logicalId === 'faq')).toBe(false)

    expect(row.describe({ tableId: 'faq', cells: { question: 'a' }, slug: 'x' }, { tableId: 'faq', cells: { question: 'b' }, slug: 'x' }, [], 'faq')).toMatchObject({ kind: 'row', tree: null })
    expect(table.describe(faq, { ...faq, name: 'Questions' }, [], null)).toMatchObject({ kind: 'table' })
  })
})
