/**
 * Collab relay — doc lifecycle, deterministic seeding, persistence (blob +
 * derived JSON), roster-driven deletion, and out-of-relay reset wiring.
 * Runs on a real migrated database via the capability harness (setup seeds
 * the home page row exactly like a live install).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import * as Y from 'yjs'
import {
  LOCAL_ORIGIN,
  projectPageDoc,
  rostersMap,
  SITE_DOC_ID,
  treeMap,
} from '@core/collab'
import { createCollabRelay, type CollabRelay } from '../../../server/collab/relay'
import type { DbClient } from '../../../server/db'
import { getCollabDocumentState } from '../../../server/repositories/collabDocuments'
import { saveDataRowDraft } from '../../../server/repositories/data'
import {
  createCapabilityTestHarness,
  type CapabilityTestHarness,
} from '../helpers/capabilityHarness'

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
 * Wrap a DbClient so the FIRST collab blob write blocks until released. That
 * is the only way to hold a persist mid-flight deterministically, which is
 * exactly the window `resetDocs` has to survive.
 */
function gateCollabBlobWrites(db: DbClient): {
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
    if (!gated && strings.join('?').includes('insert into collab_documents')) {
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

function editTitleUpdate(doc: Y.Doc, nodeText: string): void {
  doc.transact(() => {
    const nodes = treeMap(doc).get('nodes') as Y.Map<unknown>
    const rootId = treeMap(doc).get('rootNodeId') as string
    const root = nodes.get(rootId) as Y.Map<unknown>
    root.set('label', nodeText)
  }, LOCAL_ORIGIN)
}

describe('collab relay', () => {
  it('seeds a page doc deterministically from the stored row (identical state on repeat)', async () => {
    const { harness, relay, homeId } = await setup()
    const doc = await relay.openDoc(`page:${homeId}`)
    const projected = projectPageDoc(doc, homeId)
    expect(projected.slug).toBe('index')
    expect(projected.rootNodeId).not.toBe('')

    // A second relay (fresh registry, no blob persisted yet? force reset) —
    // deterministic seeding must produce an identical state vector.
    const relay2 = createCollabRelay(harness.db, { persistDebounceMs: 10 })
    cleanups.push(() => relay2.destroy())
    const doc2 = await relay2.openDoc(`page:${homeId}`)
    expect(Y.encodeStateVector(doc2)).toEqual(Y.encodeStateVector(doc))
  })

  it('persists the blob AND the derived JSON after an update', async () => {
    const { harness, relay, homeId } = await setup()
    const docId = `page:${homeId}`
    const doc = await relay.openDoc(docId)
    editTitleUpdate(doc, 'Hero section')

    await new Promise((resolve) => setTimeout(resolve, 30))
    await relay.flushAll()

    expect(await getCollabDocumentState(harness.db, docId)).not.toBeNull()
    const { rows } = await harness.db<{ cells_json: Record<string, unknown> }>`
      select cells_json from data_rows where id = ${homeId}
    `
    const body = rows[0].cells_json.body as { nodes: Record<string, { label?: string }>; rootNodeId: string }
    expect(body.nodes[body.rootNodeId].label).toBe('Hero section')
  })

  it('roster removal soft-deletes the row on site-doc persist', async () => {
    const { harness, relay, homeId } = await setup()
    const siteDoc = await relay.openDoc(SITE_DOC_ID)
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
    const docId = `page:${homeId}`
    await relay.openDoc(docId)
    await relay.flushAll()
    expect(await getCollabDocumentState(harness.db, docId)).not.toBeNull()

    const resets: string[] = []
    relay.onReset((id) => resets.push(id))

    // Simulate a pack install / data-workspace edit.
    const { rows } = await harness.db<{ cells_json: Record<string, unknown>; slug: string }>`
      select cells_json, slug from data_rows where id = ${homeId}
    `
    await saveDataRowDraft(harness.db, homeId, { cells: rows[0].cells_json, slug: rows[0].slug })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resets).toContain(docId)
    expect(await getCollabDocumentState(harness.db, docId)).toBeNull()
  })

  it('a doc with neither blob nor row starts empty (client-created-row flow) and persists a new row', async () => {
    const { harness, relay } = await setup()
    const docId = 'page:fresh-row-id'
    const doc = await relay.openDoc(docId)
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

  // ── Lifecycle races ───────────────────────────────────────────────────────
  // The reset seam is how every out-of-relay write (Settings save, Super
  // Import, plugin install, data-workspace edit) reaches connected editors.
  // Both cases below FAIL without the eviction/flush ordering in relay.ts.

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
    const docId = `page:${rows[0].id}`

    const doc = await relay.openDoc(docId)
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

  it('a relay-only page survives a site-doc reset instead of vanishing from the roster', async () => {
    const { harness, relay } = await setup()
    const rowId = 'relay-only-page'
    const pageDoc = await relay.openDoc(`page:${rowId}`)
    await relay.openDoc(SITE_DOC_ID)

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
    await relay.resetDocs([SITE_DOC_ID])

    const { rows } = await harness.db<{ id: string }>`
      select id from data_rows where id = ${rowId} and deleted_at is null
    `
    expect(rows).toHaveLength(1)

    const reseeded = await relay.openDoc(SITE_DOC_ID)
    const pages = rostersMap(reseeded).get('pages') as Y.Map<unknown>
    expect([...pages.keys()]).toContain(rowId)
  })
})