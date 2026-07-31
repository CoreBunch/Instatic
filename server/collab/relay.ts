/**
 * Collab relay — the server half of real-time co-editing.
 *
 * Owns a registry of live Y documents (one per collab doc id):
 *   - `openDoc` hydrates the CRDT blob from `collab_documents`, or — first
 *     ever open — SEEDS the doc deterministically from the current persisted
 *     JSON (fixed SEED_CLIENT_ID; the server is the ONLY seeder, so two
 *     clients can never build divergent initial histories). A doc with
 *     neither blob nor row starts empty: that is the client-created-row
 *     flow, whose content arrives as ordinary updates.
 *   - every doc carries a `generation` — its CRDT lineage id, minted on seed
 *     and returned with the doc so the socket can refuse frames from a dead
 *     lineage (see @core/collab/protocol).
 *   - every local doc update fans out to `subscribeUpdates` listeners (the
 *     socket layer broadcasts to the other connections).
 *   - persistence writes BOTH the CRDT blob (source of truth for editing)
 *     and the derived JSON into `data_rows` / `site` — the publisher and all
 *     non-editor reads stay untouched. Derived-JSON writes are tagged
 *     `collabInternal` so the row-write reset seam ignores them.
 *   - rows deleted from the site doc's roster are soft-deleted on persist
 *     (publish version bumped when a published page goes).
 *   - `resetDocs` (and the row-write listener wired in `attachResetSources`)
 *     drop CRDT state whose backing JSON was rewritten OUT-of-relay (plugin
 *     pack installs, HTTP site saves, data-workspace edits): blob deleted,
 *     doc evicted, reset broadcast — clients rebind and the doc reseeds from
 *     the fresh JSON.
 *
 * Single Bun process by product definition — an in-memory registry is
 * correct, not a shortcut (multi-process would need a shared bus; out of
 * scope, documented in docs/features/site-shell.md).
 */
import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import {
  encodeCollabDocId,
  parseCollabDocId,
  projectComponentDoc,
  projectLayoutDoc,
  projectPageDoc,
  projectSiteDoc,
  seedComponentDoc,
  seedLayoutDoc,
  seedPageDoc,
  seedSiteDocFromParts,
  SITE_DOC_ID,
  type CollabDocKind,
} from '@core/collab'
import '@modules/base' // registry population — inline-text props seed as Y.Text
import type { SiteShell } from '@core/page-tree'
import { pageFromRow, pageToCells } from '@core/data/pageFromRow'
import { visualComponentFromRow, visualComponentToCells } from '@core/data/componentFromRow'
import { savedLayoutFromRow, savedLayoutToCells } from '@core/data/layoutFromRow'
import { vcSlugFromName } from '@core/visualComponents'
import { layoutSlugFromName } from '@core/layouts'
import { validateSite } from '@core/persistence/validate'
import type { DbClient } from '../db/client'
import {
  getDataRow,
  listDataRowIdSlugs,
  softDeleteDataRow,
  upsertDataRowDraft,
} from '../repositories/data'
import { getDraftSite, saveDraftSite } from '../repositories/site'
import {
  deleteCollabDocuments,
  getCollabDocumentState,
  putCollabDocumentState,
} from '../repositories/collabDocuments'
import {
  registerRowWriteListener,
  registerShellWriteListener,
} from '../repositories/rowWriteEvents'
import { bumpPublishVersionSerialized } from '../publish/publishState'
import { registerPublishFlush } from '../publish/publishFlush'

const KIND_TABLE: Record<Exclude<CollabDocKind, 'site'>, string> = {
  page: 'pages',
  component: 'components',
  layout: 'layouts',
}
const TABLE_KIND: Record<string, Exclude<CollabDocKind, 'site'>> = {
  pages: 'page',
  components: 'component',
  layouts: 'layout',
}

interface RelayEntry {
  doc: Y.Doc
  /** This doc's CRDT lineage id — see @core/collab/protocol. */
  generation: string
  refs: number
  dirty: boolean
  persistTimer: ReturnType<typeof setTimeout> | null
  /** Serializes persists per doc so row writes never overlap. */
  persistChain: Promise<void>
  detachUpdateHandler: () => void
}

type DerivedWrite = 'written' | 'incomplete' | 'invalid'
type PersistOutcome = 'clean' | 'retry' | 'invalid'

export type RelayUpdateListener = (
  docId: string,
  update: Uint8Array,
  origin: unknown,
  generation: string,
) => void
export type RelayResetListener = (docId: string) => void

/** A doc plus the CRDT lineage the caller must stamp on its frames. */
export interface RelayDoc {
  doc: Y.Doc
  generation: string
}

export interface CollabRelay {
  openDoc(docId: string): Promise<RelayDoc>
  retain(docId: string): Promise<RelayDoc>
  release(docId: string): void
  subscribeUpdates(listener: RelayUpdateListener): () => void
  onReset(listener: RelayResetListener): () => void
  resetDocs(docIds: readonly string[]): Promise<void>
  /** Flush every dirty doc now (tests + shutdown). */
  flushAll(): Promise<void>
  /** Detach the row-write reset sources and drop all docs (tests). */
  destroy(): Promise<void>
}

export function createCollabRelay(
  db: DbClient,
  opts: { persistDebounceMs?: number } = {},
): CollabRelay {
  const persistDebounceMs = opts.persistDebounceMs ?? 800
  const entries = new Map<string, RelayEntry>()
  const opening = new Map<string, Promise<RelayDoc>>()
  /**
   * Docs mid-eviction or mid-reset. `openDoc` waits these out, so it can never
   * hand back a doc that is about to be destroyed, nor resurrect one whose
   * blob a reset is still deleting.
   */
  const settling = new Map<string, Promise<void>>()
  // Last roster set the site-doc persist actually swept, so shell-field-only
  // persists skip the three full-table scans. Cleared when the site doc resets.
  let lastSweptRostersKey: string | null = null
  const updateListeners = new Set<RelayUpdateListener>()
  const resetListeners = new Set<RelayResetListener>()

  // ── Seeding ───────────────────────────────────────────────────────────────

  async function seedFromJson(docId: string, doc: Y.Doc): Promise<void> {
    const parsed = parseCollabDocId(docId)
    if (!parsed) return
    if (parsed.kind === 'site') {
      const shell = await getDraftSite(db)
      if (!shell) return // pre-setup — nothing to seed
      const [pages, components, layouts] = await Promise.all([
        listDataRowIdSlugs(db, 'pages'),
        listDataRowIdSlugs(db, 'components'),
        listDataRowIdSlugs(db, 'layouts'),
      ])
      seedSiteDocFromParts(doc, shell as unknown as Record<string, unknown>, {
        pages: pages.map((r) => r.id),
        components: components.map((r) => r.id),
        layouts: layouts.map((r) => r.id),
      })
      return
    }
    const row = await getDataRow(db, parsed.rowId)
    if (!row || row.tableId !== KIND_TABLE[parsed.kind]) return // client-created flow
    if (parsed.kind === 'page') {
      seedPageDoc(doc, pageFromRow(row))
    } else if (parsed.kind === 'component') {
      const vc = visualComponentFromRow(row)
      if (vc) seedComponentDoc(doc, vc)
    } else {
      const layout = savedLayoutFromRow(row)
      if (layout) seedLayoutDoc(doc, layout)
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Outcome of a derived-JSON write. `invalid` is the one that MUST be
   * retried: the blob was written but the JSON the publisher (and a reseed)
   * read is now stale, so leaving the doc clean is how an accepted edit
   * silently disappears. `incomplete` is a doc that is simply not assembled
   * yet — retrying that would spin forever.
   */
  async function persistDerivedJson(docId: string, doc: Y.Doc): Promise<DerivedWrite> {
    const parsed = parseCollabDocId(docId)
    if (!parsed) return 'incomplete'
    if (parsed.kind === 'site') {
      const projected = projectSiteDoc(doc)
      if (Object.keys(projected.shell).length === 0) return 'incomplete' // never seeded
      let shell: SiteShell
      try {
        // `id` and `updatedAt` are deliberately NOT collaborative (fixed row /
        // per-mutation noise) — inject them at the persistence boundary.
        shell = validateSite({
          ...projected.shell,
          id: 'default',
          updatedAt:
            typeof projected.shell.updatedAt === 'number' ? projected.shell.updatedAt : Date.now(),
        })
      } catch (err) {
        // The blob stays authoritative; JSON write is skipped until the doc
        // heals — never persist an invalid shell for the publisher to read.
        console.error('[collab] projected shell failed validation — JSON write skipped:', err)
        return 'invalid'
      }
      await saveDraftSite(db, shell, null, { collabInternal: true })

      // Roster-driven deletions: live rows missing from the roster are gone.
      // The three full-table scans below are wasted when only a shell FIELD
      // changed (settings/styleRules edits, the common case) and the rosters
      // are identical to the last sweep — a heavy edit session would otherwise
      // run them on every debounced persist. Skip when the roster is unchanged;
      // out-of-relay deletions reset the doc, so a stale roster can't linger.
      const rostersKey =
        projected.rosters.pages.join(',') + '|' +
        projected.rosters.components.join(',') + '|' +
        projected.rosters.layouts.join(',')
      if (rostersKey === lastSweptRostersKey) return 'written'
      let deletedPublished = false
      for (const [table, ids] of [
        ['pages', projected.rosters.pages],
        ['components', projected.rosters.components],
        ['layouts', projected.rosters.layouts],
      ] as const) {
        const live = await listDataRowIdSlugs(db, table)
        const keep = new Set(ids)
        for (const row of live) {
          if (keep.has(row.id)) continue
          const deleted = await softDeleteDataRow(db, row.id, null, { collabInternal: true })
          if (deleted?.status === 'published') deletedPublished = true
        }
      }
      lastSweptRostersKey = rostersKey
      if (deletedPublished) await bumpPublishVersionSerialized()
      return 'written'
    }

    const table = KIND_TABLE[parsed.kind]
    let cells: Record<string, unknown>
    let slug: string
    if (parsed.kind === 'page') {
      const page = projectPageDoc(doc, parsed.rowId)
      if (!page.rootNodeId) return 'incomplete' // never seeded / still assembling
      cells = pageToCells(page)
      slug = page.slug
    } else if (parsed.kind === 'component') {
      const vc = projectComponentDoc(doc, parsed.rowId)
      if (!vc.tree.rootNodeId || typeof vc.name !== 'string' || vc.name === '') return 'incomplete'
      cells = visualComponentToCells(vc)
      slug = vcSlugFromName(vc.name)
    } else {
      const layout = projectLayoutDoc(doc, parsed.rowId)
      if (!layout.rootNodeId || layout.name === '') return 'incomplete'
      cells = savedLayoutToCells(layout)
      slug = layoutSlugFromName(layout.name)
    }

    // upsert = update live / resurrect soft-deleted / create fresh. A row the
    // roster sweep soft-deleted and a peer then restored (Cmd+Z of a page
    // delete) still holds its primary key, so a plain insert would conflict
    // forever — the upsert revives it in place instead.
    await upsertDataRowDraft(
      db,
      { id: parsed.rowId, tableId: table, cells, slug },
      null,
      { collabInternal: true },
    )
    return 'written'
  }

  async function persistNow(docId: string): Promise<PersistOutcome> {
    const entry = entries.get(docId)
    if (!entry || !entry.dirty) return 'clean'
    entry.dirty = false
    try {
      await putCollabDocumentState(db, docId, Y.encodeStateAsUpdate(entry.doc), entry.generation)
      const derived = await persistDerivedJson(docId, entry.doc)
      // A shell that failed validation MUST be retried: the blob is fresh but
      // the derived JSON is stale, and a reset reseeds from that JSON. Leaving
      // the doc clean here is how an accepted page silently disappears.
      if (derived === 'invalid') {
        entry.dirty = true
        return 'invalid'
      }
      return 'clean'
    } catch (err) {
      entry.dirty = true
      console.error(`[collab] persist failed for ${docId}:`, err)
      return 'retry'
    }
  }

  function schedulePersist(docId: string): void {
    const entry = entries.get(docId)
    if (!entry) return
    entry.dirty = true
    if (entry.persistTimer) return
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = null
      const persist = entry.persistChain.then(() => persistNow(docId))
      entry.persistChain = persist.then(() => undefined)
      void persist.then((outcome) => {
        if (outcome === 'retry') {
          schedulePersist(docId)
        } else if (outcome === 'clean' && entry.refs <= 0) {
          // A final persist may have failed after the last editor disconnected.
          // Keep the doc resident until a retry succeeds, then finish eviction.
          void evict(docId, { persist: false }).catch((err) => {
            console.error(`[collab] eviction after retry failed for ${docId}:`, err)
          })
        }
      })
    }, persistDebounceMs)
  }

  // ── Registry ──────────────────────────────────────────────────────────────

  async function openDoc(docId: string): Promise<RelayDoc> {
    const existing = entries.get(docId)
    if (existing) return { doc: existing.doc, generation: existing.generation }
    const inFlight = opening.get(docId)
    if (inFlight) return inFlight

    const open = (async () => {
      // Never step on a doc that is being torn down: an eviction still has a
      // persist in flight (whose blob write would resurrect state a reset is
      // deleting), and a reset has not finished deleting the blob we would
      // otherwise hydrate from — keeping the dead generation alive.
      await settling.get(docId)
      const doc = new Y.Doc()
      const stored = await getCollabDocumentState(db, docId)
      let generation: string
      let minted: boolean
      if (stored) {
        Y.applyUpdate(doc, stored.state, 'hydrate')
        // Rows written before migration 023 carry ''.
        minted = stored.generation === ''
        generation = minted ? nanoid() : stored.generation
      } else {
        await seedFromJson(docId, doc)
        generation = nanoid()
        minted = true
      }
      const updateHandler = (update: Uint8Array, origin: unknown) => {
        for (const listener of updateListeners) listener(docId, update, origin, generation)
        schedulePersist(docId)
      }
      doc.on('update', updateHandler)
      entries.set(docId, {
        doc,
        generation,
        refs: 0,
        dirty: false,
        persistTimer: null,
        persistChain: Promise.resolve(),
        detachUpdateHandler: () => doc.off('update', updateHandler),
      })
      if (minted) {
        // Persist the mint IMMEDIATELY rather than through the debounce. A doc
        // that hydrated cleanly is not dirty, so a mint riding the debounce
        // would never reach the DB — the next open would mint a DIFFERENT id
        // and reset every bound client for a byte-identical lineage.
        await putCollabDocumentState(db, docId, Y.encodeStateAsUpdate(doc), generation)
      }
      return { doc, generation }
    })()

    opening.set(docId, open)
    try {
      return await open
    } finally {
      opening.delete(docId)
    }
  }

  async function evict(docId: string, opts2: { persist: boolean }): Promise<void> {
    const entry = entries.get(docId)
    if (!entry) return
    const run = (async () => {
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer)
        entry.persistTimer = null
      }
      // Await the chain even when NOT persisting: a persist already past its
      // `dirty` check would otherwise resolve after `resetDocs` deleted the
      // row and re-insert the dead blob via upsert, undoing the reset.
      const persist = entry.persistChain.then(() =>
        opts2.persist ? persistNow(docId) : Promise.resolve<PersistOutcome>('clean'),
      )
      entry.persistChain = persist.then(() => undefined)
      const outcome = await persist
      if (outcome !== 'clean') {
        if (outcome === 'retry') schedulePersist(docId)
        throw new Error(
          outcome === 'invalid'
            ? `cannot evict ${docId}: collaborative state does not project to valid persisted JSON`
            : `cannot evict ${docId}: collaborative state persistence failed`,
        )
      }
      // An update may have landed during that await and scheduled a new timer.
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer)
        entry.persistTimer = null
      }
      entry.detachUpdateHandler()
      entry.doc.destroy()
      entries.delete(docId)
    })()
    settling.set(docId, run.then(() => undefined, () => undefined))
    try {
      await run
    } finally {
      settling.delete(docId)
    }
  }

  async function resetDocs(docIds: readonly string[]): Promise<void> {
    const affected = docIds.filter((id) => parseCollabDocId(id) !== null)
    if (affected.length === 0) return
    // The site doc reseeds from the DB on next bind — force a full roster
    // sweep on its first persist afterwards.
    if (affected.includes(SITE_DOC_ID)) lastSweptRostersKey = null

    // Flush the docs we are NOT resetting first. The site doc reseeds its
    // rosters from `listDataRowIdSlugs`, so a page whose row-doc JSON is still
    // inside the debounce window would not exist in the DB, would vanish from
    // the reseeded roster, and would then be soft-deleted by the next sweep.
    // The reset docs themselves are deliberately NOT flushed: the out-of-relay
    // write that triggered the reset already committed and must win.
    for (const docId of [...entries.keys()]) {
      if (affected.includes(docId)) continue
      const entry = entries.get(docId)
      if (!entry?.dirty) continue
      const persist = entry.persistChain.then(() => persistNow(docId))
      entry.persistChain = persist.then(() => undefined)
      const outcome = await persist
      if (outcome !== 'clean') {
        if (outcome === 'retry') schedulePersist(docId)
        throw new Error(`cannot reset ${affected.join(', ')}: failed to flush ${docId}`)
      }
    }

    const heldRefs = new Map<string, number>()
    for (const docId of affected) {
      const refs = entries.get(docId)?.refs ?? 0
      if (refs > 0) heldRefs.set(docId, refs)
      await evict(docId, { persist: false })
    }

    // Hold the door shut across the delete: an in-flight frame from a still
    // connected editor would otherwise re-open the doc from the not-yet-deleted
    // blob and the delete would land on a live doc.
    const deletion = deleteCollabDocuments(db, affected).then(() => undefined)
    for (const docId of affected) settling.set(docId, deletion)
    try {
      await deletion
    } finally {
      for (const docId of affected) settling.delete(docId)
    }

    // Re-register the ref counts the eviction dropped. Without this the next
    // `openDoc` starts at 0 while N connections still list the doc in
    // `boundDocs`, so the first close drives refs negative and evicts a doc
    // other editors are actively writing.
    for (const [docId, refs] of heldRefs) {
      await openDoc(docId)
      const reopened = entries.get(docId)
      if (reopened) reopened.refs = refs
    }
    for (const docId of affected) {
      for (const listener of resetListeners) listener(docId)
    }
  }

  // ── Out-of-relay write sources → resets ───────────────────────────────────

  const detachRowListener = registerRowWriteListener((event) => {
    const kind = TABLE_KIND[event.tableId]
    if (!kind) return
    const docIds = event.rowIds.map((rowId) => encodeCollabDocId({ kind, rowId }))
    // Creations/deletions also change the roster — the site doc must reseed.
    if (event.kind !== 'update') docIds.push(SITE_DOC_ID)
    void resetDocs(docIds).catch((err) => {
      console.error('[collab] reset after out-of-relay row write failed:', err)
    })
  })
  const detachShellListener = registerShellWriteListener(() => {
    void resetDocs([SITE_DOC_ID]).catch((err) => {
      console.error('[collab] reset after out-of-relay shell write failed:', err)
    })
  })

  async function flushAll(): Promise<void> {
    for (const docId of [...entries.keys()]) {
      const entry = entries.get(docId)
      if (!entry) continue
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer)
        entry.persistTimer = null
      }
      const persist = entry.persistChain.then(() => persistNow(docId))
      entry.persistChain = persist.then(() => undefined)
      const outcome = await persist
      if (outcome !== 'clean') {
        if (outcome === 'retry') schedulePersist(docId)
        throw new Error(
          outcome === 'invalid'
            ? `cannot flush ${docId}: collaborative state does not project to valid persisted JSON`
            : `cannot flush ${docId}: collaborative state persistence failed`,
        )
      }
    }
  }

  // Every publish path flushes the relay first (see publishFlush.ts) so the
  // baked output includes edits still inside the persist debounce window.
  const detachPublishFlush = registerPublishFlush(flushAll)

  return {
    openDoc,
    retain: async (docId) => {
      // A reset can evict between `openDoc` resolving and the registry read,
      // which would both crash on a non-null assertion and hand back a doc
      // that was just destroyed. Re-open until the doc we return is the one
      // whose refs we incremented.
      for (;;) {
        await openDoc(docId)
        const entry = entries.get(docId)
        if (!entry) continue
        entry.refs += 1
        return { doc: entry.doc, generation: entry.generation }
      }
    },
    release: (docId) => {
      const entry = entries.get(docId)
      if (!entry) return
      entry.refs -= 1
      if (entry.refs <= 0) {
        void evict(docId, { persist: true }).catch((err) => {
          console.error(`[collab] final persist for ${docId} failed:`, err)
        })
      }
    },
    subscribeUpdates: (listener) => {
      updateListeners.add(listener)
      return () => updateListeners.delete(listener)
    },
    onReset: (listener) => {
      resetListeners.add(listener)
      return () => resetListeners.delete(listener)
    },
    resetDocs,
    flushAll,
    destroy: async () => {
      detachRowListener()
      detachShellListener()
      detachPublishFlush()
      for (const docId of [...entries.keys()]) {
        await evict(docId, { persist: true })
      }
    },
  }
}
