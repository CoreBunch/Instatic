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
  projectSiteDoc,
  SITE_DOC_ID,
  type CollabDocKind,
} from '@core/collab'
import type { DbClient } from '../db/client'
import {
  deleteCollabDocuments,
  getCollabDocumentState,
  putCollabDocumentState,
} from '../repositories/collabDocuments'
import {
  registerRowWriteListener,
  registerShellWriteListener,
} from '../repositories/rowWriteEvents'
import { registerPublishFlush } from '../publish/publishFlush'
import { createRelayPersistence } from './relayPersistence'

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

type PersistOutcome = 'clean' | 'deferred' | 'superseded' | 'retry' | 'invalid'

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
  const resetGates = new Map<string, Promise<void>>()
  const updateListeners = new Set<RelayUpdateListener>()
  const resetListeners = new Set<RelayResetListener>()
  const invalidationVersions = new Map<string, number>()
  const activeInvalidations = new Set<string>()
  let nextInvalidationVersion = 0
  // A reset evicts live docs before deleting their stored lineages. If that
  // deletion fails, preserve socket ref counts until a later retry can reseed
  // the docs; the sockets still list those ids in their bound-doc sets.
  const heldResetRefs = new Map<string, number>()
  const persistence = createRelayPersistence(db, {
    isResident: (docId) => entries.has(docId),
    schedulePersist: (docId) => schedulePersist(docId),
    openDoc: async (docId) => { await openDoc(docId) },
    invalidationVersion: (docId) => invalidationVersions.get(docId) ?? 0,
  })

  function activateInvalidations(docIds: readonly string[]): Map<string, number> {
    const versions = new Map<string, number>()
    const version = ++nextInvalidationVersion
    for (const docId of docIds) {
      invalidationVersions.set(docId, version)
      activeInvalidations.add(docId)
      versions.set(docId, version)
    }
    return versions
  }

  function finishInvalidations(versions: ReadonlyMap<string, number>): void {
    for (const [docId, version] of versions) {
      // A newer queued invalidation still owns the active marker.
      if ((invalidationVersions.get(docId) ?? 0) === version) {
        activeInvalidations.delete(docId)
      }
    }
  }

  async function persistNow(docId: string): Promise<PersistOutcome> {
    const entry = entries.get(docId)
    if (!entry || !entry.dirty) return 'clean'
    entry.dirty = false
    const invalidationVersion = invalidationVersions.get(docId) ?? 0
    const invalidationCutoff = nextInvalidationVersion
    const state = Y.encodeStateAsUpdate(entry.doc)
    const snapshot = new Y.Doc()
    Y.applyUpdate(snapshot, state, 'persist-snapshot')
    try {
      // Even an unrostered doc writes its CRDT tombstone so a later roster
      // undo restores the latest accepted content. Only its relational upsert
      // is deferred.
      await putCollabDocumentState(db, docId, state, entry.generation)
      const derived = await persistence.serializeMutation(async () => {
        // An out-of-relay write committed while this blob was in flight. Its
        // queued reset is authoritative; never overwrite it with this older
        // collaborative snapshot.
        if (
          activeInvalidations.has(docId) ||
          (invalidationVersions.get(docId) ?? 0) !== invalidationVersion
        ) {
          return 'superseded' as const
        }
        // Re-check INSIDE the shared mutation order. A page blob write may
        // have been blocked while the site roster removed and swept its row.
        if (persistence.isUnrosteredEstablishedDoc(docId)) return 'deferred' as const
        return persistence.persistDerivedJson(docId, snapshot, invalidationCutoff)
      })
      if (derived === 'deferred') return 'deferred'
      if (derived === 'superseded') return 'superseded'
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
    } finally {
      snapshot.destroy()
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
        } else if (outcome === 'deferred' && entry.refs <= 0) {
          void evict(docId, { persist: true }).catch((err) => {
            console.error(`[collab] retirement after roster removal failed for ${docId}:`, err)
          })
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

  async function openDoc(docId: string, ignoreResetGate = false): Promise<RelayDoc> {
    const parsed = parseCollabDocId(docId)
    if (!ignoreResetGate) {
      const resetGate = resetGates.get(docId)
      if (resetGate) {
        await resetGate
        return openDoc(docId)
      }
    }
    const settlement = settling.get(docId)
    if (settlement) {
      await settlement
      return openDoc(docId, ignoreResetGate)
    }
    const existing = entries.get(docId)
    if (existing) return { doc: existing.doc, generation: existing.generation }
    const inFlight = opening.get(docId)
    if (inFlight) return inFlight

    const open = (async () => {
      // Row-doc persistence needs a current roster snapshot. Register this
      // page opening before awaiting SITE so resetDocs can see and drain it.
      if (parsed && parsed.kind !== 'site' && !persistence.hasRosterSnapshot()) {
        await openDoc(SITE_DOC_ID, ignoreResetGate)
      }
      const doc = new Y.Doc()
      const stored = await getCollabDocumentState(db, docId)
      let generation: string
      let minted: boolean
      let seeded = false
      if (stored) {
        Y.applyUpdate(doc, stored.state, 'hydrate')
        // Rows written before migration 023 carry ''.
        minted = stored.generation === ''
        generation = minted ? nanoid() : stored.generation
      } else {
        seeded = await persistence.seedFromJson(docId, doc)
        generation = nanoid()
        minted = true
      }
      const updateHandler = (update: Uint8Array, origin: unknown) => {
        for (const listener of updateListeners) listener(docId, update, origin, generation)
        if (docId === SITE_DOC_ID) persistence.observeSiteRoster(doc)
        schedulePersist(docId)
      }
      doc.on('update', updateHandler)
      const heldRefs = heldResetRefs.get(docId) ?? 0
      entries.set(docId, {
        doc,
        generation,
        refs: heldRefs,
        dirty: false,
        persistTimer: null,
        persistChain: Promise.resolve(),
        detachUpdateHandler: () => doc.off('update', updateHandler),
      })
      // A frame can reopen a doc after a transient reset failure but before
      // the retry. Transfer the still-bound sockets into that gap entry so
      // subsequent retain/release operations update one logical ref count.
      if (heldRefs > 0) heldResetRefs.delete(docId)
      if (parsed?.kind === 'site') {
        persistence.observeSiteRoster(doc)
      } else if (parsed) {
        persistence.noteOpenedRow(docId, { stored: stored !== null, seeded })
      }
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
      let outcome = await persist
      // Membership may have changed while an earlier persist was in flight;
      // a concurrent undo cancels retirement and must finish the deferred
      // write before this entry can be detached.
      if (outcome === 'deferred' && !persistence.isUnrosteredEstablishedDoc(docId)) {
        const resumed = entry.persistChain.then(() => persistNow(docId))
        entry.persistChain = resumed.then(() => undefined)
        outcome = await resumed
      }
      const deferred = outcome === 'deferred' && persistence.isUnrosteredEstablishedDoc(docId)
      if (outcome !== 'clean' && !deferred) {
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
      // A roster-removed row keeps its blob as an undo tombstone. External
      // authoritative deletes still remove blobs through resetDocs below.
    })()
    settling.set(docId, run.then(() => undefined, () => undefined))
    try {
      await run
    } finally {
      settling.delete(docId)
    }
  }

  function orderedEntryDocIds(): string[] {
    const docIds = [...entries.keys()]
    return entries.has(SITE_DOC_ID)
      ? [SITE_DOC_ID, ...docIds.filter((docId) => docId !== SITE_DOC_ID)]
      : docIds
  }

  async function resetDocs(
    docIds: readonly string[],
    ownedInvalidations?: ReadonlyMap<string, number>,
  ): Promise<void> {
    const affected = [...new Set(docIds.filter((id) => parseCollabDocId(id) !== null))]
    if (affected.length === 0) return
    const existingGates = [...new Set(
      affected.flatMap((docId) => {
        const gate = resetGates.get(docId)
        return gate ? [gate] : []
      }),
    )]
    if (existingGates.length > 0) {
      await Promise.all(existingGates)
      const refreshedInvalidations = ownedInvalidations
        ? activateInvalidations(affected)
        : undefined
      return resetDocs(affected, refreshedInvalidations)
    }
    let releaseResetGate!: () => void
    const resetGate = new Promise<void>((resolve) => {
      releaseResetGate = resolve
    })
    for (const docId of affected) resetGates.set(docId, resetGate)
    const invalidations = ownedInvalidations ?? activateInvalidations(affected)
    let completed = false
    try {
    // An open that registered before this gate may already be reading the old
    // lineage. Drain it, then evict the resulting entry; all later opens wait
    // on resetGate until delete + authoritative reseed are complete.
    for (const docId of affected) {
      try {
        await opening.get(docId)
      } catch {
        // A failed open may still have installed an entry before its mint
        // write failed. The eviction pass below handles either outcome.
      }
    }
    for (const docId of affected) {
      const parsed = parseCollabDocId(docId)
      if (!parsed || parsed.kind === 'site') continue
      // An authoritative out-of-relay write ends the provisional-create
      // phase for this id, including when that write is a deletion.
      persistence.markRowEstablished(docId)
    }
    const resetsSite = affected.includes(SITE_DOC_ID)
    if (resetsSite) {
      const siteEntry = entries.get(SITE_DOC_ID)
      if (siteEntry) {
        // The shell write that triggered this reset must win, so do not persist
        // the stale collaborative shell. Apply only its authoritative deletion
        // roster before replacement row docs claim a freed slug. Rows explicitly
        // affected by the out-of-relay write are protected because they seed the
        // replacement site roster below.
        if (siteEntry.persistTimer) {
          clearTimeout(siteEntry.persistTimer)
          siteEntry.persistTimer = null
        }
        const projected = projectSiteDoc(siteEntry.doc)
        const sweep = siteEntry.persistChain.then(() =>
          persistence.serializeMutation(() =>
            persistence.sweepRosterDeletions(
              projected.rosters,
              invalidations.get(SITE_DOC_ID) ?? nextInvalidationVersion,
              new Set(affected),
            ),
          ),
        )
        // A failed reset is surfaced to this caller, but must not poison every
        // later persist chained onto the retained entry.
        siteEntry.persistChain = sweep.then(() => undefined, () => undefined)
        await sweep
      }
      // The site doc reseeds from the DB on next bind. Its first later persist
      // must run a full sweep even if the old and replacement keys compare equal.
      persistence.invalidateRosterSweep()
    }

    // Flush the docs we are NOT resetting first. The site doc reseeds its
    // rosters from `listDataRowIdSlugs`, so a page whose row-doc JSON is still
    // inside the debounce window would not exist in the DB, would vanish from
    // the reseeded roster, and would then be soft-deleted by the next sweep.
    // The reset docs themselves are deliberately NOT flushed: the out-of-relay
    // write that triggered the reset already committed and must win.
    for (const docId of orderedEntryDocIds()) {
      if (affected.includes(docId)) continue
      const entry = entries.get(docId)
      if (!entry?.dirty) continue
      const persist = entry.persistChain.then(() => persistNow(docId))
      entry.persistChain = persist.then(() => undefined)
      const outcome = await persist
      if (
        outcome !== 'clean' &&
        outcome !== 'deferred' &&
        outcome !== 'superseded'
      ) {
        if (outcome === 'retry') schedulePersist(docId)
        throw new Error(`cannot reset ${affected.join(', ')}: failed to flush ${docId}`)
      }
    }

    for (const docId of affected) {
      const refs = entries.get(docId)?.refs ?? 0
      if (refs > 0) heldResetRefs.set(docId, refs)
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

    if (resetsSite) {
      // Keep the old authority through eviction/deletion, then replace it in
      // one step by observing the freshly seeded site doc. There is never a
      // null-authority window in which a dirty deleted row can pass its guard.
      await openDoc(SITE_DOC_ID, true)
    }

    // Re-register the ref counts the eviction dropped. Without this the next
    // `openDoc` starts at 0 while N connections still list the doc in
    // `boundDocs`, so the first close drives refs negative and evicts a doc
    // other editors are actively writing.
    for (const docId of affected) {
      if ((heldResetRefs.get(docId) ?? 0) <= 0) continue
      await openDoc(docId, true)
    }
    for (const docId of affected) {
      for (const listener of resetListeners) listener(docId)
    }
      completed = true
    } finally {
      // A failed reset leaves the ids actively invalidated. The queued reset
      // path retains the failed batch and explicit flushes refuse to publish;
      // a later successful retry owns a newer version and clears the marker.
      if (completed) finishInvalidations(invalidations)
      for (const docId of affected) {
        if (resetGates.get(docId) === resetGate) resetGates.delete(docId)
      }
      releaseResetGate()
    }
  }

  // ── Out-of-relay write sources → resets ───────────────────────────────────

  const pendingResetDocIds = new Set<string>()
  const failedResetDocIds = new Set<string>()
  let resetBatchScheduled = false
  let resetChain: Promise<void> = Promise.resolve()
  let failedResetError: unknown = null

  function queueResetDocs(docIds: readonly string[]): void {
    // Mark synchronously with the post-commit notification. The microtask
    // batching below must not create a window for an older persist to write.
    const combined = [...new Set([...failedResetDocIds, ...docIds])]
    failedResetDocIds.clear()
    failedResetError = null
    activateInvalidations(combined)
    for (const docId of combined) pendingResetDocIds.add(docId)
    if (resetBatchScheduled) return
    resetBatchScheduled = true
    queueMicrotask(() => {
      resetBatchScheduled = false
      const batch = [...pendingResetDocIds]
      pendingResetDocIds.clear()
      if (batch.length === 0) return
      const invalidations = new Map(
        batch.map((docId) => [docId, invalidationVersions.get(docId) ?? 0]),
      )
      const reset = resetChain.then(() => resetDocs(batch, invalidations))
      resetChain = reset.then(
        () => undefined,
        (err) => {
          failedResetError = err
          for (const docId of batch) failedResetDocIds.add(docId)
          console.error('[collab] reset after out-of-relay write failed:', err)
        },
      )
    })
  }

  const detachRowListener = registerRowWriteListener((event) => {
    const kind = TABLE_KIND[event.tableId]
    if (!kind) return
    const docIds = event.rowIds.map((rowId) => encodeCollabDocId({ kind, rowId }))
    // The site-document batch API reports creations in its changed-id group as
    // `update`. An id absent from the observed roster therefore also means
    // membership may have changed and site authority must reseed.
    if (
      event.kind !== 'update' ||
      !persistence.hasRosterSnapshot() ||
      docIds.some((docId) => !persistence.rosterContains(docId))
    ) docIds.push(SITE_DOC_ID)
    queueResetDocs(docIds)
  })
  const detachShellListener = registerShellWriteListener(() => {
    queueResetDocs([SITE_DOC_ID])
  })

  async function drainResetQueue(throwOnFailure = true): Promise<void> {
    let retriedFailure = false
    for (;;) {
      // Let a batch queued by the current call stack attach to resetChain.
      await Promise.resolve()
      const observed = resetChain
      await observed
      if (failedResetError) {
        if (!throwOnFailure) return
        if (!retriedFailure) {
          const retry = [...failedResetDocIds]
          retriedFailure = true
          queueResetDocs(retry)
          continue
        }
        throw failedResetError
      }
      if (
        !resetBatchScheduled &&
        pendingResetDocIds.size === 0 &&
        resetChain === observed
      ) return
    }
  }

  async function flushAll(): Promise<void> {
    await drainResetQueue()
    await persistence.drainRecoveries(true)
    // The site sweep must free slugs before replacement row docs write them.
    for (const docId of orderedEntryDocIds()) {
      const entry = entries.get(docId)
      if (!entry) continue
      if (entry.persistTimer) {
        clearTimeout(entry.persistTimer)
        entry.persistTimer = null
      }
      const persist = entry.persistChain.then(() => persistNow(docId))
      entry.persistChain = persist.then(() => undefined)
      const outcome = await persist
      if (
        outcome !== 'clean' &&
        outcome !== 'deferred' &&
        outcome !== 'superseded'
      ) {
        if (outcome === 'retry') schedulePersist(docId)
        throw new Error(
          outcome === 'invalid'
            ? `cannot flush ${docId}: collaborative state does not project to valid persisted JSON`
            : `cannot flush ${docId}: collaborative state persistence failed`,
        )
      }
    }
    // A repository write may have committed during the loop above. Its reset
    // must finish before publish/headless reads consume the derived JSON.
    await drainResetQueue()
    await persistence.drainRecoveries(true)
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
        const opened = await openDoc(docId)
        const barrier = resetGates.get(docId) ?? settling.get(docId)
        if (barrier) {
          await barrier
          continue
        }
        const entry = entries.get(docId)
        if (!entry || entry.doc !== opened.doc || entry.generation !== opened.generation) continue
        entry.refs += 1
        return { doc: entry.doc, generation: entry.generation }
      }
    },
    release: (docId) => {
      const heldRefs = heldResetRefs.get(docId)
      if (heldRefs !== undefined) {
        // Once reset snapshots ownership, that held count is authoritative
        // even while evict is still draining the doomed entry's persist chain.
        // Starting a second eviction here would race its settling barrier.
        if (heldRefs <= 1) heldResetRefs.delete(docId)
        else heldResetRefs.set(docId, heldRefs - 1)
        return
      }
      const entry = entries.get(docId)
      if (!entry) return
      entry.refs -= 1
      if (entry.refs <= 0 && !resetGates.has(docId)) {
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
      await drainResetQueue()
      await persistence.drainRecoveries(true)
      for (const docId of [...entries.keys()]) {
        await evict(docId, { persist: true })
      }
    },
  }
}
