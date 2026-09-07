import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  applyLocalizationDraftToDoc,
  encodeCollabDocId,
  LOCAL_ORIGIN,
  projectLocalizationDoc,
  projectPageDoc,
  rostersMap,
  seedPageDoc,
  SITE_DOC_ID,
  treeMap,
} from '@core/collab'
import type { ContentLocalizationDraftInput } from '@core/localization-schema'
import { createSqliteClient } from '../../db/sqlite'
import { sqliteMigrations } from '../../db/migrations-sqlite'
import { runMigrations } from '../../db/runMigrations'
import { createDataRow, getDataRow, saveDataRowDraft } from '../../repositories/data'
import { createLocale, getContentLocalization, saveContentLocalizationDraft } from '../../repositories/localization'
import { notifyRowWrite, serializeCollabAwareWrite } from '../../repositories/rowWriteEvents'
import { getCollabDocumentState } from '../../repositories/collabDocuments'
import { createCollabRelay } from '../relay'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const db = createSqliteClient(':memory:')
  cleanups.push(() => db.close())
  await runMigrations(db, sqliteMigrations)
  await db`insert into site (id, name, settings_json) values ('default', 'Languages', ${{}})`
  const locale = await createLocale(db, { code: 'de', name: 'Deutsch', pathPrefix: 'de', direction: 'ltr', enabled: true })
  const body = { rootNodeId: 'root', nodes: {
    root: { id: 'root', moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: ['text'] },
    text: { id: 'text', moduleId: 'base.text', breakpointOverrides: {}, classIds: [], props: { text: 'Source copy', tag: 'p', htmlAttributes: {} }, children: [], parentId: 'root' },
  } }
  const row = await createDataRow(db, { id: 'page', tableId: 'pages', cells: { title: 'Source title', slug: 'index', body }, slug: 'index' })
  const relay = createCollabRelay(db, { persistDebounceMs: 60_000 })
  cleanups.push(() => relay.destroy())
  const localeDocId = encodeCollabDocId({ kind: 'page', rowId: row.id, localeId: locale.id })
  const sourceDocId = encodeCollabDocId({ kind: 'page', rowId: row.id, localeId: 'default' })
  return { db, relay, row, locale, localeDocId, sourceDocId }
}

function change(doc: Y.Doc, next: ContentLocalizationDraftInput): void {
  applyLocalizationDraftToDoc(doc, projectLocalizationDoc(doc), next, LOCAL_ORIGIN)
}

describe('localized relay persistence', () => {
  it('seeds sparse locale docs and persists translations without copying shared trees or touching source', async () => {
    const { db, relay, row, locale, localeDocId, sourceDocId } = await fixture()
    const target = await relay.openDoc(localeDocId)
    const source = await relay.openDoc(sourceDocId)
    const common = await relay.openDoc('page:page')
    expect(projectLocalizationDoc(target.doc)).toEqual({ cells: {}, slug: 'index', translationMeta: {} })
    expect(await getContentLocalization(db, row.id, locale.id)).toBeNull()
    expect(projectPageDoc(common.doc, row.id).title).toBe('')
    const sourceBefore = projectLocalizationDoc(source.doc)
    const sharedBefore = (await getDataRow(db, row.id))!.sharedCells
    change(target.doc, { cells: { title: 'Deutsch', body: { nodes: { text: { props: { text: 'Guten Tag' }, hidden: true } } } }, slug: 'start' })
    await relay.flushAll()
    const variant = await getContentLocalization(db, row.id, locale.id)
    expect(variant?.availability).toBe('offline')
    expect(variant?.cells.body).toEqual({ nodes: { text: { props: { text: 'Guten Tag' }, hidden: true } } })
    expect(projectLocalizationDoc(source.doc)).toEqual(sourceBefore)
    expect((await getDataRow(db, row.id))?.sharedCells).toEqual(sharedBefore)
    const translated = await getDataRow(db, row.id, locale.id)
    expect(translated?.cells.title).toBe('Deutsch')
    expect(translated?.slug).toBe('start')
    expect((await getDataRow(db, row.id))?.cells.title).toBe('Source title')
  })

  it('resets only the edited locale lineage and preserves an unrelated in-flight translation', async () => {
    const { db, relay, row, locale, localeDocId, sourceDocId } = await fixture()
    const target = await relay.retain(localeDocId)
    const source = await relay.retain(sourceDocId)
    const common = await relay.retain('page:page')
    change(source.doc, { cells: { ...projectLocalizationDoc(source.doc).cells, title: 'Typing English' }, slug: 'index' })
    await serializeCollabAwareWrite(async () => {
      await saveContentLocalizationDraft(db, row.id, locale.id, { cells: { title: 'External German' }, slug: 'deutsch' })
      notifyRowWrite({ tableId: 'pages', rowIds: [row.id], kind: 'update', localeId: locale.id, sharedChanged: false })
    })
    await relay.flushAll()
    expect((await relay.openDoc(localeDocId)).generation).not.toBe(target.generation)
    expect((await relay.openDoc(sourceDocId)).generation).toBe(source.generation)
    expect((await relay.openDoc('page:page')).generation).toBe(common.generation)
    expect((await getDataRow(db, row.id))?.cells.title).toBe('Typing English')
    expect((await getDataRow(db, row.id, locale.id))?.cells.title).toBe('External German')
  })

  it('invalidates dormant locale blobs on an authoritative global row write', async () => {
    const { db, relay, row, locale, localeDocId } = await fixture()
    const target = await relay.retain(localeDocId)
    change(target.doc, { cells: { title: 'Old German' }, slug: 'alt' })
    await relay.flushAll()
    relay.release(localeDocId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await getCollabDocumentState(db, localeDocId)).not.toBeNull()
    await serializeCollabAwareWrite(async () => {
      await saveContentLocalizationDraft(db, row.id, locale.id, { cells: { title: 'Imported German' }, slug: 'neu' })
      notifyRowWrite({ tableId: 'pages', rowIds: [row.id], kind: 'update' })
    })
    await relay.flushAll()
    expect(projectLocalizationDoc((await relay.openDoc(localeDocId)).doc).cells.title).toBe('Imported German')
  })

  it('uses open shared structures to validate and persist a newly created locale row', async () => {
    const { db, relay, locale } = await fixture()
    const common = await relay.openDoc('page:new')
    seedPageDoc(common.doc, { id: 'new', title: '', slug: '', rootNodeId: 'new-root', nodes: {
      'new-root': { id: 'new-root', parentId: null, moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] },
    } })
    const localeDocId = encodeCollabDocId({ kind: 'page', rowId: 'new', localeId: locale.id })
    const target = await relay.openDoc(localeDocId)
    const context = await relay.localizationGuardContext(localeDocId)
    expect(context?.sharedCells.body).toEqual({ rootNodeId: 'new-root', nodes: {
      'new-root': { id: 'new-root', parentId: null, moduleId: 'base.body', props: {}, breakpointOverrides: {}, classIds: [], children: [] },
    } })
    expect(context?.fields.find((field) => field.id === 'templateTarget')?.localization).toBe('shared')
    change(target.doc, { cells: { title: 'Neue Seite' }, slug: 'neu' })
    const site = await relay.openDoc(SITE_DOC_ID)
    ;(rostersMap(site.doc).get('pages') as Y.Map<unknown>).set('new', true)
    await relay.flushAll()
    expect((await getDataRow(db, 'new', locale.id))?.cells.title).toBe('Neue Seite')
    expect((await getDataRow(db, 'new'))?.localization).toBeNull()
  })

  it('guards locale persistence with the shared roster and restores translation tombstones on undo', async () => {
    const { db, relay, row, locale, localeDocId } = await fixture()
    const target = await relay.openDoc(localeDocId)
    const site = await relay.openDoc(SITE_DOC_ID)
    const pages = rostersMap(site.doc).get('pages') as Y.Map<unknown>
    pages.delete(row.id)
    await relay.flushAll()
    change(target.doc, { cells: { title: 'Accepted while deleted' }, slug: 'restored' })
    await relay.flushAll()
    expect(await getDataRow(db, row.id, locale.id)).toBeNull()
    pages.set(row.id, true)
    await relay.flushAll()
    expect((await getDataRow(db, row.id, locale.id))?.cells.title).toBe('Accepted while deleted')
  })

  it('keeps translation lineages intact on a shared structural save', async () => {
    const { db, relay, row, localeDocId, sourceDocId } = await fixture()
    const target = await relay.openDoc(localeDocId)
    const source = await relay.openDoc(sourceDocId)
    const common = await relay.openDoc('page:page')
    const nodes = treeMap(common.doc).get('nodes') as Y.Map<unknown>
    ;(nodes.get('root') as Y.Map<unknown>).set('label', 'Structure')
    await relay.flushAll()
    expect((await getDataRow(db, row.id))?.cells.title).toBe('Source title')
    const latest = (await getDataRow(db, row.id))!
    await saveDataRowDraft(db, row.id, { cells: { ...latest.cells, title: 'Source via API' }, slug: latest.slug })
    await relay.flushAll()
    expect((await relay.openDoc(sourceDocId)).generation).not.toBe(source.generation)
    expect((await relay.openDoc(localeDocId)).generation).toBe(target.generation)
    expect((await relay.openDoc('page:page')).generation).toBe(common.generation)
  })
})
