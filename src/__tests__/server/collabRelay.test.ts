/**
 * Collab relay — doc lifecycle, deterministic seeding, persistence (blob +
 * derived JSON), roster-driven deletion, and out-of-relay reset wiring.
 * Runs on a real migrated database via the capability harness (setup seeds
 * the home page row exactly like a live install).
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import * as Y from 'yjs'
import {
  LOCAL_ORIGIN,
  projectPageDoc,
  rostersMap,
  shellMap,
  MAIN_SITE_DOC_ID,
  treeMap,
} from '@core/collab'
import { createCollabRelay, type CollabRelay } from '../../../server/collab/relay'
import type { DbClient } from '../../../server/db'
import { getCollabDocumentState } from '../../../server/repositories/collabDocuments'
import {
  createDataRow,
  createDataTable,
  listDataRows,
  saveDataRowDraft,
  updateDataRowTable,
} from '../../../server/repositories/data'
import { getDraftSite, saveDraftSite } from '../../../server/repositories/site'
import {
  notifyRowWrite,
  notifyShellWrite,
} from '../../../server/repositories/rowWriteEvents'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'
import { MAIN_SCOPE } from '../../../server/branches/scope'

let cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn()
  cleanups = []
})

async function setup(): Promise<{ harness: CapabilityTestHarness; relay: CollabRelay; homeId: string }> {
  const harness = await createCapabilityTestHarness()
  cleanups.push(() => harness.cleanup())
  await harness.setupOwner()
  const relay = createCollabRelay(harness.db, { persistDebounceMs: 10 })
  cleanups.push(() => relay.destroy())
  const { rows } = await harness.db<{ id: string }>`
    select id from data_rows where table_id = ${'pages'}
  `
  return { harness, relay, homeId: rows[0].id }
}

/**
 * Wrap a DbClient so the first collab blob write AFTER `arm()` blocks until
 * released. Arming is explicit because `openDoc` persists the freshly minted
 * generation immediately — the write we want to hold is the later debounced
 * one, not that mint.
 */
function gateCollabBlobWrites(db: DbClient): {
  db: DbClient
  arm: () => void
  blocked: Promise<void>
  release: () => void
} {
  let announceBlocked!: () => void
  const blocked = new Promise<void>((resolve) => {
    announceBlocked = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let armed = false
  let gated = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    if (armed && !gated && strings.join('?').includes('insert into collab_documents')) {
      gated = true
      announceBlocked()
      await gate
    }
    return db<Row>(strings, ...values)
  }) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = ((sql: string, params?: unknown[]) => db.unsafe(sql, params)) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, blocked, release }
}

function gateDerivedRowWrites(db: DbClient, targetRowId: string): {
  db: DbClient
  arm: () => void
  blocked: Promise<void>
  release: () => void
} {
  let announceBlocked!: () => void
  const blocked = new Promise<void>((resolve) => {
    announceBlocked = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let armed = false
  let gated = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (
      armed &&
      !gated &&
      sql.includes('update data_rows') &&
      sql.includes('set cells_json') &&
      values.includes(targetRowId)
    ) {
      gated = true
      announceBlocked()
      await gate
    }
    return db<Row>(strings, ...values)
  }) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = ((sql: string, params?: unknown[]) => db.unsafe(sql, params)) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, blocked, release }
}

function gateRosterSweep(db: DbClient): {
  db: DbClient
  arm: () => void
  blocked: Promise<void>
  release: () => void
} {
  let announceBlocked!: () => void
  const blocked = new Promise<void>((resolve) => {
    announceBlocked = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let armed = false
  let gated = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?')
    if (
      armed &&
      !gated &&
      sql.includes('select logical_id as id, slug from data_rows') &&
      values.includes('pages')
    ) {
      gated = true
      announceBlocked()
      await gate
    }
    return db<Row>(strings, ...values)
  }) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = ((sql: string, params?: unknown[]) => db.unsafe(sql, params)) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, blocked, release }
}

function gateCollabBlobRead(db: DbClient, targetDocId: string): {
  db: DbClient
  blocked: Promise<void>
  release: () => void
} {
  let announceBlocked!: () => void
  const blocked = new Promise<void>((resolve) => {
    announceBlocked = resolve
  })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let gated = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    if (
      !gated &&
      strings.join('?').includes('select state_blob') &&
      values.includes(targetDocId)
    ) {
      gated = true
      announceBlocked()
      await gate
    }
    return db<Row>(strings, ...values)
  }) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = ((sql: string, params?: unknown[]) => db.unsafe(sql, params)) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, blocked, release }
}

function failNextCollabBlobWrite(db: DbClient): {
  db: DbClient
  arm: () => void
  failed: Promise<void>
} {
  let announceFailed!: () => void
  const failed = new Promise<void>((resolve) => {
    announceFailed = resolve
  })
  let armed = false
  let hasFailed = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    if (
      armed &&
      !hasFailed &&
      strings.join('?').includes('insert into collab_documents')
    ) {
      hasFailed = true
      announceFailed()
      throw new Error('simulated transient collab persistence failure')
    }
    return db<Row>(strings, ...values)
  }) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = ((sql: string, params?: unknown[]) => db.unsafe(sql, params)) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, failed }
}

function failNextCollabBlobDelete(db: DbClient): {
  db: DbClient
  arm: () => void
  failed: Promise<void>
} {
  let announceFailed!: () => void
  const failed = new Promise<void>((resolve) => {
    announceFailed = resolve
  })
  let armed = false
  let hasFailed = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) =>
    db<Row>(strings, ...values)) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = (async (sql: string, params?: unknown[]) => {
    if (
      armed &&
      !hasFailed &&
      sql.includes('delete from collab_documents')
    ) {
      hasFailed = true
      announceFailed()
      throw new Error('simulated transient collab reset failure')
    }
    return db.unsafe(sql, params)
  }) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, failed }
}

function gateCollabBlobDelete(db: DbClient, targetDocId: string): {
  db: DbClient
  arm: () => void
  blocked: Promise<void>
  release: () => void
} {
  let announceBlocked!: () => void
  const blocked = new Promise<void>((resolve) => { announceBlocked = resolve })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let armed = false
  let gated = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) =>
    db<Row>(strings, ...values)) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = (async (sql: string, params?: unknown[]) => {
    if (
      armed &&
      !gated &&
      sql.includes('delete from collab_documents') &&
      params?.includes(targetDocId)
    ) {
      gated = true
      announceBlocked()
      await gate
    }
    return db.unsafe(sql, params)
  }) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, blocked, release }
}

function observeRosterSweep(db: DbClient): {
  db: DbClient
  arm: () => void
  completedPass: Promise<void>
} {
  let announceCompleted!: () => void
  const completedPass = new Promise<void>((resolve) => { announceCompleted = resolve })
  let armed = false
  let announced = false

  const wrapped = (async <Row,>(strings: TemplateStringsArray, ...values: unknown[]) => {
    const result = await db<Row>(strings, ...values)
    if (
      armed &&
      !announced &&
      strings.join('?').includes('select logical_id as id, slug from data_rows') &&
      values.includes('layouts')
    ) {
      announced = true
      announceCompleted()
    }
    return result
  }) as DbClient
  Object.defineProperty(wrapped, 'dialect', { get: () => db.dialect })
  wrapped.unsafe = ((sql: string, params?: unknown[]) => db.unsafe(sql, params)) as DbClient['unsafe']
  wrapped.transaction = ((fn: Parameters<DbClient['transaction']>[0]) =>
    db.transaction(fn)) as DbClient['transaction']
  return { db: wrapped, arm: () => { armed = true }, completedPass }
}

function editTitleUpdate(doc: Y.Doc, nodeText: string): void {
  doc.transact(() => {
    const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
    const rootId = treeMap(doc).get('rootNodeId') as string
    const root = nodes.get(rootId) as Y.Map<unknown>
    root.set('label', nodeText)
  }, LOCAL_ORIGIN)
}

function populateFreshPage(doc: Y.Doc, title: string, slug: string): void {
  doc.transact(() => {
    const tree = treeMap(doc)
    tree.set('rootNodeId', 'root')
    const nodes = new Y.Map<unknown>()
    tree.set('nodes', nodes)
    const root = new Y.Map<unknown>()
    root.set('id', 'root')
    root.set('moduleId', 'base.body')
    root.set('props', new Y.Map())
    root.set('breakpointOverrides', new Y.Map())
    root.set('children', new Y.Array())
    nodes.set('root', root)
    const meta = doc.getMap('meta')
    meta.set('title', title)
    meta.set('slug', slug)
  }, LOCAL_ORIGIN)
}

describe('collab relay', () => {
  it('seeds a page doc deterministically from the stored row (identical state on repeat)', async () => {
    const { harness, relay, homeId } = await setup()
    const { doc: doc } = await relay.openDoc(`page:main:${homeId}`)
    const projected = projectPageDoc(doc, homeId)
    expect(projected.slug).toBe('index')
    expect(projected.rootNodeId).not.toBe('')

    // A second relay (fresh registry, no blob persisted yet? force reset) —
    // deterministic seeding must produce an identical state vector.
    const relay2 = createCollabRelay(harness.db, { persistDebounceMs: 10 })
    cleanups.push(() => relay2.destroy())
    const { doc: doc2 } = await relay2.openDoc(`page:main:${homeId}`)
    expect(Y.encodeStateVector(doc2)).toEqual(Y.encodeStateVector(doc))
  })

  it('persists the blob AND the derived JSON after an update', async () => {
    const { harness, relay, homeId } = await setup()
    const docId = `page:main:${homeId}`
    const { doc: doc } = await relay.openDoc(docId)
    editTitleUpdate(doc, 'Hero section')

    await new Promise((resolve) => setTimeout(resolve, 30))
    await relay.flushAll()

    expect((await getCollabDocumentState(harness.db, docId))?.state).toBeDefined()
    const { rows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${homeId}
    `
    const body = rows[0].cells_json.body as { nodes: Record<string, { label?: string }>; rootNodeId: string }
    expect(body.nodes[body.rootNodeId].label).toBe('Hero section')
  })

  it('keeps a dirty doc resident and retries when the final persist fails', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const failing = failNextCollabBlobWrite(harness.db)
    const relay = createCollabRelay(failing.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const homeId = rows[0].id
    const docId = `page:main:${homeId}`
    const { doc } = await relay.retain(docId)

    failing.arm()
    editTitleUpdate(doc, 'Survives a transient failure')
    relay.release(docId)
    await failing.failed

    await new Promise((resolve) => setTimeout(resolve, 30))
    const persisted = await getCollabDocumentState(harness.db, docId)
    expect(persisted?.state).toBeDefined()
    const { rows: pageRows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${homeId}
    `
    const body = pageRows[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(body.nodes[body.rootNodeId].label).toBe('Survives a transient failure')
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('makes an explicit flush fail instead of publishing stale derived JSON', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const failing = failNextCollabBlobWrite(harness.db)
    const relay = createCollabRelay(failing.db, { persistDebounceMs: 1_000 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const docId = `page:main:${rows[0].id}`
    const { doc } = await relay.openDoc(docId)

    failing.arm()
    editTitleUpdate(doc, 'Must not publish yet')
    await expect(relay.flushAll()).rejects.toThrow('collaborative state persistence failed')
    await failing.failed

    // The failed flush schedules a retry; a later explicit flush can safely
    // wait for it and succeeds once the transient database error is gone.
    await relay.flushAll()
    expect(errorLog).toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('roster removal soft-deletes the row on site-doc persist', async () => {
    const { harness, relay, homeId } = await setup()
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    siteDoc.transact(() => {
      const rosters = rostersMap(siteDoc)
      ;(rosters.get('pages') as Y.Map<unknown>).delete(homeId)
    }, LOCAL_ORIGIN)

    await new Promise((resolve) => setTimeout(resolve, 30))
    await relay.flushAll()

    const { rows } = await harness.db<{ deleted_at: string | null }>`
      select deleted_at from data_rows where id = ${homeId}
    `
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('an out-of-relay row write resets the doc and notifies listeners', async () => {
    const { harness, relay, homeId } = await setup()
    const docId = `page:main:${homeId}`
    await relay.openDoc(docId)
    await relay.flushAll()
    expect((await getCollabDocumentState(harness.db, docId))?.state).toBeDefined()

    const resets: string[] = []
    relay.onReset((id) => resets.push(id))

    // Simulate a pack install / data-workspace edit.
    const { rows } = await harness.db<{ cells_json: Record<string, unknown>; slug: string }>`
      select cells_json, slug from data_rows where id = ${homeId}
    `
    await saveDataRowDraft(harness.db, MAIN_SCOPE, homeId, { cells: rows[0].cells_json, slug: rows[0].slug })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resets).toContain(docId)
    expect(await getCollabDocumentState(harness.db, docId)).toBeNull()
  })

  it('a doc with neither blob nor row starts empty (client-created-row flow) and persists a new row', async () => {
    const { harness, relay } = await setup()
    const docId = 'page:main:fresh-row-id'
    const { doc: doc } = await relay.openDoc(docId)
    expect(treeMap(doc).get('rootNodeId')).toBeUndefined()

    // Client update arrives with full content (translator-populated shape).
    doc.transact(() => {
      const tree = treeMap(doc)
      tree.set('rootNodeId', 'root')
      const nodes = new Y.Map<unknown>()
      tree.set('nodes', nodes)
      const root = new Y.Map<unknown>()
      root.set('id', 'root')
      root.set('moduleId', 'base.body')
      root.set('props', new Y.Map())
      root.set('breakpointOverrides', new Y.Map())
      root.set('children', new Y.Array())
      nodes.set('root', root)
      const meta = doc.getMap('meta')
      meta.set('title', 'Fresh')
      meta.set('slug', 'fresh')
    }, LOCAL_ORIGIN)

    await new Promise((resolve) => setTimeout(resolve, 30))
    await relay.flushAll()

    const { rows } = await harness.db<{ id: string; slug: string }>`
      select id, slug from data_rows where id = ${'fresh-row-id'}
    `
    expect(rows[0]?.slug).toBe('fresh')
  })

  it('does not resurrect a dirty deleted page ahead of its same-slug replacement', async () => {
    const { harness, relay, homeId } = await setup()
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const { doc: oldPage } = await relay.openDoc(`page:main:${homeId}`)
    editTitleUpdate(oldPage, 'Dirty page being replaced')

    const replacementId = 'replacement-page'
    const { doc: replacement } = await relay.openDoc(`page:main:${replacementId}`)
    populateFreshPage(replacement, 'Replacement', 'index')

    siteDoc.transact(() => {
      const pages = rostersMap(siteDoc).get('pages') as Y.Map<unknown>
      pages.delete(homeId)
      pages.set(replacementId, true)
    }, LOCAL_ORIGIN)

    await relay.flushAll()

    const { rows } = await harness.db<{ id: string; deleted_at: string | null }>`
      select id, deleted_at from data_rows
      where table_id = ${'pages'} and slug = ${'index'}
      order by id asc
    `
    expect(rows.find((row) => row.id === homeId)?.deleted_at).not.toBeNull()
    expect(rows.find((row) => row.id === replacementId)?.deleted_at).toBeNull()
    expect(rows.filter((row) => row.deleted_at === null).map((row) => row.id))
      .toEqual([replacementId])
  })

  it('keeps blob and derived JSON on the same immutable persist snapshot', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 60_000 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const docId = `page:main:${rows[0].id}`
    const { doc } = await relay.openDoc(docId)
    gated.arm()
    editTitleUpdate(doc, 'Snapshot A')
    const firstFlush = relay.flushAll()
    await gated.blocked
    editTitleUpdate(doc, 'Snapshot B')
    gated.release()
    await firstFlush

    const stored = await getCollabDocumentState(harness.db, docId)
    const storedDoc = new Y.Doc()
    Y.applyUpdate(storedDoc, stored!.state)
    const storedPage = projectPageDoc(storedDoc, rows[0].id)
    const { rows: firstRows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${rows[0].id}
    `
    const firstBody = firstRows[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(storedPage.nodes[storedPage.rootNodeId]?.label).toBe('Snapshot A')
    expect(firstBody.nodes[firstBody.rootNodeId]?.label).toBe('Snapshot A')
    storedDoc.destroy()

    await relay.flushAll()
    const { rows: secondRows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${rows[0].id}
    `
    const secondBody = secondRows[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(secondBody.nodes[secondBody.rootNodeId]?.label).toBe('Snapshot B')
  })

  it('does not insert a client-created page that was removed from the roster before its first flush', async () => {
    const { harness, relay } = await setup()
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const rowId = 'abandoned-page'
    const { doc: pageDoc } = await relay.openDoc(`page:main:${rowId}`)
    populateFreshPage(pageDoc, 'Abandoned', 'abandoned')

    siteDoc.transact(() => {
      ;(rostersMap(siteDoc).get('pages') as Y.Map<unknown>).set(rowId, true)
    }, LOCAL_ORIGIN)
    siteDoc.transact(() => {
      ;(rostersMap(siteDoc).get('pages') as Y.Map<unknown>).delete(rowId)
    }, LOCAL_ORIGIN)

    await relay.flushAll()

    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where id = ${rowId}
    `
    expect(rows).toHaveLength(0)
  })

  it('restores the latest page after deletion, disconnect, eviction, and roster undo', async () => {
    const { harness, relay, homeId } = await setup()
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const retained = await relay.retain(`page:main:${homeId}`)
    editTitleUpdate(retained.doc, 'Latest content survives undo')

    siteDoc.transact(() => {
      ;(rostersMap(siteDoc).get('pages') as Y.Map<unknown>).delete(homeId)
    }, LOCAL_ORIGIN)
    await relay.flushAll()
    expect(await getCollabDocumentState(harness.db, `page:main:${homeId}`)).not.toBeNull()

    const destroyed = new Promise<void>((resolve) => {
      retained.doc.on('destroy', () => resolve())
    })
    relay.release(`page:main:${homeId}`)
    await destroyed
    expect(await getCollabDocumentState(harness.db, `page:main:${homeId}`)).not.toBeNull()

    siteDoc.transact(() => {
      ;(rostersMap(siteDoc).get('pages') as Y.Map<unknown>).set(homeId, true)
    }, LOCAL_ORIGIN)
    await relay.flushAll()

    const { rows } = await harness.db<{ cells_json: Record<string, unknown>; deleted_at: string | null }>`
      select cells_json, deleted_at from data_rows where id = ${homeId}
    `
    const body = rows[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(rows[0].deleted_at).toBeNull()
    expect(body.nodes[body.rootNodeId]?.label).toBe('Latest content survives undo')
  })

  it('does not resurrect a row persist that was already in flight when its roster entry is removed', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const homeId = rows[0].id
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const { doc: pageDoc } = await relay.openDoc(`page:main:${homeId}`)

    gated.arm()
    editTitleUpdate(pageDoc, 'Persist blocked before roster removal')
    await gated.blocked
    siteDoc.transact(() => {
      ;(rostersMap(siteDoc).get('pages') as Y.Map<unknown>).delete(homeId)
    }, LOCAL_ORIGIN)

    let swept = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows: state } = await harness.db<{ deleted_at: string | null }>`
        select deleted_at from data_rows where id = ${homeId}
      `
      if (state[0]?.deleted_at !== null) {
        swept = true
        break
      }
      await Bun.sleep(10)
    }
    expect(swept).toBeTrue()
    gated.release()
    await relay.flushAll()

    const { rows: state } = await harness.db<{ deleted_at: string | null }>`
      select deleted_at from data_rows where id = ${homeId}
    `
    expect(state[0]?.deleted_at).not.toBeNull()
  })

  // ── Lifecycle races ───────────────────────────────────────────────────────
  // The reset seam is how every out-of-relay write (Settings save, Super
  // Import, plugin install, data-workspace edit) reaches connected editors.
  // Both cases below FAIL without the eviction/flush ordering in relay.ts.

  it('coalesces shell and row invalidations so an external batch creation survives reset', async () => {
    const { harness, relay, homeId } = await setup()
    await relay.openDoc(MAIN_SITE_DOC_ID)
    const { rows: sourceRows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${homeId}
    `
    const rowId = 'external-batch-page'
    await createDataRow(
      harness.db,
      MAIN_SCOPE,
      {
        id: rowId,
        tableId: 'pages',
        cells: sourceRows[0].cells_json,
        slug: 'external-batch',
      },
      null,
      null,
      { collabInternal: true },
    )

    const resetIds = new Set<string>()
    let finishReset!: () => void
    const resetDone = new Promise<void>((resolve) => {
      finishReset = resolve
    })
    const unsubscribe = relay.onReset((docId) => {
      resetIds.add(docId)
      if (resetIds.has(MAIN_SITE_DOC_ID) && resetIds.has(`page:main:${rowId}`)) finishReset()
    })
    // siteDocument emits these synchronously after one committed save and
    // reports newly created rows in the changed/update group.
    notifyShellWrite('main')
    notifyRowWrite({ branchId: 'main', tableId: 'pages', rowIds: [rowId], kind: 'update' })
    await resetDone
    unsubscribe()

    const { rows } = await harness.db<{ deleted_at: string | null }>`
      select deleted_at from data_rows where id = ${rowId}
    `
    expect(rows[0]?.deleted_at).toBeNull()
    const { doc: reseededSite } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const pages = rostersMap(reseededSite).get('pages') as Y.Map<unknown>
    expect([...pages.keys()]).toContain(rowId)
  })

  it('an older site reset cannot sweep a creation owned by a later reset batch', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows: sourceRows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where table_id = ${'pages'}
    `
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)

    gated.arm()
    siteDoc.transact(() => {
      shellMap(siteDoc).set('name', 'Older collaborative shell')
    }, LOCAL_ORIGIN)
    await gated.blocked
    notifyShellWrite('main')
    // Let reset A capture its own SITE-only batch and wait on the blocked
    // persist before the external creation emits reset B.
    await Bun.sleep(5)

    const rowId = 'later-reset-page'
    await createDataRow(harness.db, MAIN_SCOPE, {
      id: rowId,
      tableId: 'pages',
      cells: sourceRows[0].cells_json,
      slug: 'later-reset',
    })
    gated.release()
    await relay.flushAll()

    const { rows } = await harness.db<{ deleted_at: string | null }>`
      select deleted_at from data_rows where id = ${rowId}
    `
    expect(rows[0]?.deleted_at).toBeNull()
    const { doc: reseededSite } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const pages = rostersMap(reseededSite).get('pages') as Y.Map<unknown>
    expect([...pages.keys()]).toContain(rowId)
  })

  it('a later roster deletion beats an older row invalidation still resetting', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const page = rows[0]
    const pageDocId = `page:main:${page.id}`
    const deleting = gateCollabBlobDelete(harness.db, pageDocId)
    const sweep = observeRosterSweep(deleting.db)
    const relay = createCollabRelay(sweep.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    await relay.openDoc(pageDocId)

    const externalCells = structuredClone(page.cells_json)
    const externalBody = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    externalBody.nodes[externalBody.rootNodeId].label = 'Older external page write'
    deleting.arm()
    await saveDataRowDraft(sweep.db, MAIN_SCOPE, page.id, {
      cells: externalCells,
      slug: page.slug,
    })
    // The external P-only reset is now active but held before deleting its
    // lineage. A later collaborative roster removal must still delete P.
    await deleting.blocked
    sweep.arm()
    siteDoc.transact(() => {
      ;(rostersMap(siteDoc).get('pages') as Y.Map<unknown>).delete(page.id)
    }, LOCAL_ORIGIN)
    await sweep.completedPass
    await Bun.sleep(5)

    deleting.release()
    await relay.flushAll()

    const { rows: persisted } = await harness.db<{ deleted_at: string | null }>`
      select deleted_at from data_rows where id = ${page.id}
    `
    expect(persisted[0]?.deleted_at).not.toBeNull()
    const currentPages = rostersMap(siteDoc).get('pages') as Y.Map<unknown>
    expect([...currentPages.keys()]).not.toContain(page.id)
  })

  it('a superseded unaffected flush does not abort an older site reset', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateRosterSweep(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 60_000 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const page = rows[0]
    const pageDocId = `page:main:${page.id}`
    await relay.openDoc(MAIN_SITE_DOC_ID)
    const { doc: pageDoc } = await relay.openDoc(pageDocId)
    editTitleUpdate(pageDoc, 'Older dirty collaborative page')

    const resetIds = new Set<string>()
    let finishResets!: () => void
    const resetsDone = new Promise<void>((resolve) => { finishResets = resolve })
    const unsubscribe = relay.onReset((docId) => {
      resetIds.add(docId)
      if (resetIds.has(MAIN_SITE_DOC_ID) && resetIds.has(pageDocId)) finishResets()
    })

    const externalShell = await getDraftSite(harness.db, MAIN_SCOPE)
    expect(externalShell).not.toBeNull()
    gated.arm()
    await saveDraftSite(gated.db, MAIN_SCOPE, {
      ...externalShell!,
      name: 'Authoritative external shell',
    })
    // Reset A now owns SITE and is blocked in its roster sweep. Queue an
    // authoritative page save behind that sweep; its reset B supersedes A's
    // attempt to flush this dirty, non-reset page.
    await gated.blocked
    const externalCells = structuredClone(page.cells_json)
    const body = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    body.nodes[body.rootNodeId].label = 'Authoritative external page'
    const pageWrite = saveDataRowDraft(gated.db, MAIN_SCOPE, page.id, {
      cells: externalCells,
      slug: page.slug,
    })
    gated.release()
    await pageWrite
    await resetsDone
    unsubscribe()

    expect((await getDraftSite(harness.db, MAIN_SCOPE))?.name).toBe('Authoritative external shell')
    const { rows: persisted } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${page.id}
    `
    const persistedBody = persisted[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(persistedBody.nodes[persistedBody.rootNodeId]?.label)
      .toBe('Authoritative external page')
    const { doc: reseededSite } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const { doc: reseededPage } = await relay.openDoc(pageDocId)
    expect(shellMap(reseededSite).get('name')).toBe('Authoritative external shell')
    expect(projectPageDoc(reseededPage, page.id).nodes[body.rootNodeId]?.label)
      .toBe('Authoritative external page')
  })

  it('keeps an external page-to-custom-table move authoritative over a dirty retained page', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const customTable = await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'archive-table',
      name: 'Archive',
      slug: 'archive',
      kind: 'data',
      singularLabel: 'Archive item',
      pluralLabel: 'Archive items',
    })
    const { rows } = await harness.db<{
      id: string
      cells_json: Record<string, unknown>
    }>`
      select id, cells_json from data_rows where table_id = ${'pages'}
    `
    const original = rows[0]
    const docId = `page:main:${original.id}`
    const relay = createCollabRelay(harness.db, { persistDebounceMs: 60_000 })
    cleanups.push(() => relay.destroy())
    const retained = await relay.retain(docId)
    let oldDocDestroyed = false
    retained.doc.on('destroy', () => { oldDocDestroyed = true })
    editTitleUpdate(retained.doc, 'Stale page edit must not undo the move')

    const moved = await updateDataRowTable(harness.db, MAIN_SCOPE, original.id, customTable.id)
    expect(moved.ok).toBeTrue()
    await relay.flushAll()

    const { rows: persisted } = await harness.db<{
      table_id: string
      cells_json: Record<string, unknown>
    }>`
      select table_id, cells_json from data_rows where id = ${original.id}
    `
    expect(persisted[0]?.table_id).toBe(customTable.id)
    expect(persisted[0]?.cells_json).toEqual(original.cells_json)
    expect(oldDocDestroyed).toBeTrue()

    const resetBlob = await getCollabDocumentState(harness.db, docId)
    expect(resetBlob?.generation).not.toBe(retained.generation)
    const rebound = await relay.openDoc(docId)
    expect(rebound.generation).not.toBe(retained.generation)
    const { doc: reseededSite } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const pages = rostersMap(reseededSite).get('pages') as Y.Map<unknown>
    expect([...pages.keys()]).not.toContain(original.id)
    relay.release(docId)
  })

  it('merge-overwrite invalidates the old collab kind when an imported row moves tables', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    const cookie = await harness.setupOwner()
    const targetTable = await createDataTable(harness.db, MAIN_SCOPE, {
      id: 'import-target',
      name: 'Import targets',
      slug: 'import-targets',
      kind: 'data',
      singularLabel: 'Import target',
      pluralLabel: 'Import targets',
    })
    const [page] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const docId = `page:main:${page.id}`
    const relay = createCollabRelay(harness.db, { persistDebounceMs: 60_000 })
    cleanups.push(() => relay.destroy())
    const retained = await relay.retain(docId)
    const oldGeneration = retained.generation
    let oldDocDestroyed = false
    retained.doc.on('destroy', () => { oldDocDestroyed = true })
    editTitleUpdate(retained.doc, 'Stale page-shaped import overwrite')

    const importedCells = { headline: 'Authoritative imported custom row' }
    const response = await harness.cms('/admin/api/cms/import?strategy=merge-overwrite', {
      method: 'POST',
      cookie,
      json: {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: [targetTable],
        rows: [{
          ...page,
          tableId: targetTable.id,
          cells: importedCells,
          slug: 'imported-custom-row',
        }],
      },
    })
    expect(response.status).toBe(200)
    await relay.flushAll()

    const { rows } = await harness.db<{
      table_id: string
      cells_json: Record<string, unknown>
    }>`
      select table_id, cells_json from data_rows where id = ${page.id}
    `
    expect(rows[0]?.table_id).toBe(targetTable.id)
    expect(rows[0]?.cells_json).toEqual(importedCells)
    expect(oldDocDestroyed).toBeTrue()
    const rebound = await relay.openDoc(docId)
    expect(rebound.generation).not.toBe(oldGeneration)
    const { doc: reseededSite } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const pages = rostersMap(reseededSite).get('pages') as Y.Map<unknown>
    expect([...pages.keys()]).not.toContain(page.id)
    relay.release(docId)
  })

  it('a no-op merge-add import does not reset skipped row or shell edits', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    const cookie = await harness.setupOwner()
    const [existingPage] = await listDataRows(harness.db, MAIN_SCOPE, 'pages')
    const storedShell = await getDraftSite(harness.db, MAIN_SCOPE)
    expect(storedShell).not.toBeNull()

    const relay = createCollabRelay(harness.db, { persistDebounceMs: 60_000 })
    cleanups.push(() => relay.destroy())
    const { doc: pageDoc } = await relay.openDoc(`page:main:${existingPage.id}`)
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    editTitleUpdate(pageDoc, 'Dirty row survives skipped import')
    siteDoc.transact(() => {
      shellMap(siteDoc).set('name', 'Dirty shell survives skipped import')
    }, LOCAL_ORIGIN)

    const res = await harness.cms('/admin/api/cms/import?strategy=merge-add', {
      method: 'POST',
      cookie,
      json: {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        site: storedShell,
        tables: [],
        rows: [existingPage],
      },
    })
    expect(res.status).toBe(200)
    expect((await res.json() as { rowsSkipped: number }).rowsSkipped).toBe(1)

    await relay.flushAll()
    const { rows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${existingPage.id}
    `
    const body = rows[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(body.nodes[body.rootNodeId]?.label).toBe('Dirty row survives skipped import')
    expect((await getDraftSite(harness.db, MAIN_SCOPE))?.name)
      .toBe('Dirty shell survives skipped import')
  })

  it('sweeps roster deletions before a site reset flushes a same-slug replacement', async () => {
    const { harness, relay, homeId } = await setup()
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const { doc: oldPage } = await relay.openDoc(`page:main:${homeId}`)
    editTitleUpdate(oldPage, 'Dirty page during site reset')
    const replacementId = 'reset-replacement'
    const { doc: replacement } = await relay.openDoc(`page:main:${replacementId}`)
    populateFreshPage(replacement, 'Reset replacement', 'index')
    siteDoc.transact(() => {
      const pages = rostersMap(siteDoc).get('pages') as Y.Map<unknown>
      pages.delete(homeId)
      pages.set(replacementId, true)
    }, LOCAL_ORIGIN)

    // A settings save resets only site:default. Its stale shell must not be
    // written back, but its current roster still has to release the old slug
    // before non-reset row docs are flushed.
    await relay.resetDocs([MAIN_SITE_DOC_ID])

    const { rows } = await harness.db<{ id: string; deleted_at: string | null }>`
      select id, deleted_at from data_rows
      where table_id = ${'pages'} and slug = ${'index'}
      order by id asc
    `
    expect(rows.find((row) => row.id === homeId)?.deleted_at).not.toBeNull()
    expect(rows.find((row) => row.id === replacementId)?.deleted_at).toBeNull()
    expect(rows.filter((row) => row.deleted_at === null).map((row) => row.id))
      .toEqual([replacementId])
  })

  it('a reset is not undone by a persist that was already in flight', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const docId = `page:main:${rows[0].id}`

    const { doc } = await relay.openDoc(docId)
    // The generation-mint write has landed; arm the gate so the DEBOUNCED
    // persist is the one held mid-flight.
    gated.arm()
    editTitleUpdate(doc, 'About to be reset')

    // Block the blob write mid-flight, then reset underneath it.
    await gated.blocked
    const reset = relay.resetDocs([docId])
    gated.release()
    await reset

    // Without the await in `evict`, the released insert lands AFTER
    // deleteCollabDocuments and resurrects the dead generation.
    expect(await getCollabDocumentState(harness.db, docId)).toBeNull()
  })

  it('a socket release during reset decrements held ownership without leaking a ref', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const docId = `page:main:${rows[0].id}`
    const retained = await relay.retain(docId)

    gated.arm()
    editTitleUpdate(retained.doc, 'Blocked while socket closes')
    await gated.blocked
    const reset = relay.resetDocs([docId])
    // resetDocs has installed its gate, captured the retained ref, and is now
    // waiting for this blocked persist inside eviction.
    await Bun.sleep(5)
    relay.release(docId)
    gated.release()
    await reset

    const { doc: unboundFresh } = await relay.openDoc(docId)
    let destroyed = false
    unboundFresh.on('destroy', () => { destroyed = true })
    editTitleUpdate(unboundFresh, 'No phantom owner remains')
    await Bun.sleep(30)
    expect(destroyed).toBeTrue()
  })

  it('a release before reset captures held refs leaves no phantom page owner', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const docId = `page:main:${rows[0].id}`
    const retained = await relay.retain(docId)
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)
    let originalDestroyed = false
    retained.doc.on('destroy', () => { originalDestroyed = true })

    gated.arm()
    siteDoc.transact(() => {
      shellMap(siteDoc).set('name', 'Blocked before held-ref snapshot')
    }, LOCAL_ORIGIN)
    await gated.blocked

    // resetDocs installs both reset gates immediately, then waits for the
    // blocked SITE persist before it snapshots heldResetRefs. Releasing here
    // must decrement the live entry without starting a competing eviction.
    const reset = relay.resetDocs([MAIN_SITE_DOC_ID, docId])
    relay.release(docId)
    gated.release()
    await reset
    expect(originalDestroyed).toBeTrue()

    const { doc: unboundFresh } = await relay.openDoc(docId)
    expect(unboundFresh).not.toBe(retained.doc)
    let freshDestroyed = false
    unboundFresh.on('destroy', () => { freshDestroyed = true })
    editTitleUpdate(unboundFresh, 'No pre-snapshot phantom owner remains')
    await Bun.sleep(30)
    expect(freshDestroyed).toBeTrue()
  })

  it('a reset drains an open already reading the old lineage before deleting it', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const row = rows[0]
    const docId = `page:main:${row.id}`

    const seedRelay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    const { doc: seededDoc } = await seedRelay.openDoc(docId)
    editTitleUpdate(seededDoc, 'Old collaborative lineage')
    await seedRelay.flushAll()
    await seedRelay.destroy()

    const gated = gateCollabBlobRead(harness.db, docId)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const staleOpen = relay.openDoc(docId)
    await gated.blocked

    const externalCells = structuredClone(row.cells_json)
    const externalBody = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    externalBody.nodes[externalBody.rootNodeId].label = 'External while open is pending'
    const resetDone = new Promise<void>((resolve) => {
      const unsubscribe = relay.onReset((resetId) => {
        if (resetId !== docId) return
        unsubscribe()
        resolve()
      })
    })
    await saveDataRowDraft(harness.db, MAIN_SCOPE, row.id, {
      cells: externalCells,
      slug: row.slug,
    })
    // Let the queued reset install its gate and begin waiting for staleOpen.
    await Bun.sleep(10)
    gated.release()
    await staleOpen
    await resetDone

    const { doc: freshDoc } = await relay.openDoc(docId)
    const freshPage = projectPageDoc(freshDoc, row.id)
    expect(freshPage.nodes[freshPage.rootNodeId]?.label)
      .toBe('External while open is pending')
  })

  it('retain never returns the doomed entry a reset is awaiting from open', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where table_id = ${'pages'}
    `
    const docId = `page:main:${rows[0].id}`

    const seedRelay = createCollabRelay(harness.db, { persistDebounceMs: 5 })
    const seeded = await seedRelay.openDoc(docId)
    const oldGeneration = seeded.generation
    await seedRelay.destroy()

    const gated = gateCollabBlobRead(harness.db, docId)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    let returnedDestroyCount = 0
    const retainedPromise = relay.retain(docId).then((retained) => {
      retained.doc.on('destroy', () => { returnedDestroyCount += 1 })
      return retained
    })
    await gated.blocked

    // The reset installs its gate and waits on the same opening promise.
    // retain attached first, so its continuation is deliberately poised to
    // observe the just-opened but already-doomed entry.
    const reset = relay.resetDocs([docId])
    gated.release()
    const [retained] = await Promise.all([retainedPromise, reset])

    expect(returnedDestroyCount).toBe(0)
    expect(retained.generation).not.toBe(oldGeneration)
    const current = await relay.openDoc(docId)
    expect(current.doc).toBe(retained.doc)
    expect(current.generation).toBe(retained.generation)

    let finishDestroy!: () => void
    const destroyed = new Promise<void>((resolve) => { finishDestroy = resolve })
    retained.doc.on('destroy', finishDestroy)
    relay.release(docId)
    await destroyed
    await Bun.sleep(5)
    expect(returnedDestroyCount).toBe(1)
  })

  it('an external row save wins over a collaborative persist already in flight', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const row = rows[0]
    const docId = `page:main:${row.id}`
    const { doc } = await relay.openDoc(docId)

    gated.arm()
    editTitleUpdate(doc, 'Stale collaborative edit')
    await gated.blocked

    const externalCells = structuredClone(row.cells_json)
    const externalBody = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    externalBody.nodes[externalBody.rootNodeId].label = 'External save wins'
    const resetDone = new Promise<void>((resolve) => {
      const unsubscribe = relay.onReset((resetId) => {
        if (resetId !== docId) return
        unsubscribe()
        resolve()
      })
    })
    await saveDataRowDraft(harness.db, MAIN_SCOPE, row.id, {
      cells: externalCells,
      slug: row.slug,
    })
    gated.release()
    await resetDone

    const { rows: persisted } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${row.id}
    `
    const persistedBody = persisted[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(persistedBody.nodes[persistedBody.rootNodeId]?.label).toBe('External save wins')
    expect(await getCollabDocumentState(harness.db, docId)).toBeNull()
  })

  it('orders an external save after a collaborative derived write already in flight', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const row = rows[0]
    const docId = `page:main:${row.id}`
    const gated = gateDerivedRowWrites(harness.db, row.id)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { doc } = await relay.openDoc(docId)

    gated.arm()
    editTitleUpdate(doc, 'Collaborative update already in derived SQL')
    const collabFlush = relay.flushAll()
    await gated.blocked

    const externalCells = structuredClone(row.cells_json)
    const externalBody = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    externalBody.nodes[externalBody.rootNodeId].label = 'External ordered last'
    let externalFinished = false
    const resetDone = new Promise<void>((resolve) => {
      const unsubscribe = relay.onReset((resetId) => {
        if (resetId !== docId) return
        unsubscribe()
        resolve()
      })
    })
    const externalSave = saveDataRowDraft(harness.db, MAIN_SCOPE, row.id, {
      cells: externalCells,
      slug: row.slug,
    }).then(() => { externalFinished = true })

    await Bun.sleep(10)
    const externalWaitedForDerivedWrite = !externalFinished
    gated.release()
    await Promise.all([collabFlush, externalSave, resetDone])

    const { rows: persisted } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${row.id}
    `
    const persistedBody = persisted[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(externalWaitedForDerivedWrite).toBeTrue()
    expect(persistedBody.nodes[persistedBody.rootNodeId]?.label).toBe('External ordered last')
  })

  it('an edit that starts after reset invalidation cannot overwrite the external row', async () => {
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const gated = gateCollabBlobWrites(harness.db)
    const relay = createCollabRelay(gated.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const row = rows[0]
    const docId = `page:main:${row.id}`
    const { doc: pageDoc } = await relay.openDoc(docId)
    const { doc: siteDoc } = await relay.openDoc(MAIN_SITE_DOC_ID)

    const externalCells = structuredClone(row.cells_json)
    const externalBody = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    externalBody.nodes[externalBody.rootNodeId].label = 'External reset is authoritative'
    await saveDataRowDraft(
      harness.db,
      MAIN_SCOPE,
      row.id,
      { cells: externalCells, slug: row.slug },
      null,
      null,
      { collabInternal: true },
    )

    // Hold an older SITE persist so resetDocs has activated both ids but is
    // still waiting. The page edit begins only after that invalidation mark.
    gated.arm()
    siteDoc.transact(() => {
      shellMap(siteDoc).set('name', 'Stale collaborative shell')
    }, LOCAL_ORIGIN)
    await gated.blocked
    const reset = relay.resetDocs([MAIN_SITE_DOC_ID, docId])
    editTitleUpdate(pageDoc, 'Late stale collaborative edit')
    await Bun.sleep(30)
    gated.release()
    await reset

    const { rows: persisted } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${row.id}
    `
    const persistedBody = persisted[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(persistedBody.nodes[persistedBody.rootNodeId]?.label)
      .toBe('External reset is authoritative')
    expect(await getCollabDocumentState(harness.db, docId)).toBeNull()
  })

  it('an explicit flush retries and drains a transient queued reset failure', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const harness = await createCapabilityTestHarness()
    cleanups.push(() => harness.cleanup())
    await harness.setupOwner()
    const failing = failNextCollabBlobDelete(harness.db)
    const relay = createCollabRelay(failing.db, { persistDebounceMs: 5 })
    cleanups.push(() => relay.destroy())
    const { rows } = await harness.db<{
      id: string
      slug: string
      cells_json: Record<string, unknown>
    }>`
      select id, slug, cells_json from data_rows where table_id = ${'pages'}
    `
    const row = rows[0]
    const docId = `page:main:${row.id}`
    await relay.retain(docId)
    await relay.flushAll()

    const externalCells = structuredClone(row.cells_json)
    const externalBody = externalCells.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    externalBody.nodes[externalBody.rootNodeId].label = 'Survives reset retry'
    failing.arm()
    await saveDataRowDraft(harness.db, MAIN_SCOPE, row.id, {
      cells: externalCells,
      slug: row.slug,
    })
    await failing.failed

    // An already-bound socket can send another frame before publish triggers
    // the retry, and a new socket can briefly bind/unbind in the same window.
    // Both must share one logical ref count with the refs held by the reset.
    await Bun.sleep(5)
    const { doc: gapDoc } = await relay.openDoc(docId)
    const extraBinding = await relay.retain(docId)
    expect(extraBinding.doc).toBe(gapDoc)
    relay.release(docId)

    // The queued failure remains authoritative and flushAll retries the whole
    // batch before it allows publish/headless consumers to proceed.
    await relay.flushAll()

    const { rows: persisted } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${row.id}
    `
    const persistedBody = persisted[0].cells_json.body as {
      nodes: Record<string, { label?: string }>
      rootNodeId: string
    }
    expect(persistedBody.nodes[persistedBody.rootNodeId]?.label).toBe('Survives reset retry')
    expect(await getCollabDocumentState(harness.db, docId)).not.toBeNull()
    expect(errorLog).toHaveBeenCalled()

    // The retry must also restore the ref owned by the still-bound socket.
    // With refs lost at zero, the next debounce persist immediately evicts
    // this newly seeded authoritative doc even though the socket is connected.
    const { doc: rebound } = await relay.openDoc(docId)
    let reboundDestroyed = false
    rebound.on('destroy', () => { reboundDestroyed = true })
    editTitleUpdate(rebound, 'Connected after reset retry')
    await Bun.sleep(30)
    expect(reboundDestroyed).toBeFalse()
    relay.release(docId)
    await Bun.sleep(10)
    expect(reboundDestroyed).toBeTrue()
    errorLog.mockRestore()
  })

  it('a relay-only page survives a site-doc reset instead of vanishing from the roster', async () => {
    const { harness, relay } = await setup()
    const rowId = 'relay-only-page'
    const { doc: pageDoc } = await relay.openDoc(`page:main:${rowId}`)
    await relay.openDoc(MAIN_SITE_DOC_ID)

    pageDoc.transact(() => {
      const tree = treeMap(pageDoc)
      tree.set('rootNodeId', 'root')
      const nodes = new Y.Map<unknown>()
      const root = new Y.Map<unknown>()
      root.set('id', 'root')
      root.set('moduleId', 'base.body')
      root.set('props', new Y.Map())
      root.set('breakpointOverrides', new Y.Map())
      root.set('children', new Y.Array())
      nodes.set('root', root)
      tree.set('nodes', nodes)
      const meta = pageDoc.getMap('meta')
      meta.set('title', 'Relay only')
      meta.set('slug', 'relay-only')
    }, LOCAL_ORIGIN)

    // Reset the SITE doc while the new page exists ONLY in the relay. Its
    // derived JSON must be flushed first, or the reseed — which builds the
    // roster from listDataRowIdSlugs — cannot see the row at all.
    await relay.resetDocs([MAIN_SITE_DOC_ID])

    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where id = ${rowId} and deleted_at is null
    `
    expect(rows).toHaveLength(1)

    const { doc: reseeded } = await relay.openDoc(MAIN_SITE_DOC_ID)
    const pages = rostersMap(reseeded).get('pages') as Y.Map<unknown>
    expect([...pages.keys()]).toContain(rowId)
  })
})
