/**
 * Collab binding — glues the editor store to the CRDT documents.
 *
 * Write path (hybrid, chosen for zero disturbance of the hot path):
 *   - LOCAL mutations keep applying to the Zustand store directly (exactly
 *     the pre-collab behavior — structural sharing, O(change)), and their
 *     Mutative patches are translated into Y operations
 *     (`applySitePatchesToDocs`, LOCAL_ORIGIN).
 *   - NON-local doc changes (remote peers, undo/redo, reconcile) flow the
 *     other way: a per-doc projection replaces the affected row/shell in the
 *     store. Round-trip identity between the two paths is what the
 *     @core/collab test suite pins down.
 *
 * Undo — per-doc Y.UndoManager tracking LOCAL_ORIGIN only (remote edits are
 * never undoable by this user):
 *   - coalescing reproduces the old `coalesceKey` semantics: consecutive
 *     same-key mutations merge into one undo step (captureTimeout ∞ +
 *     explicit `stopCapturing` whenever the key breaks),
 *   - a global routing stack maps Cmd+Z to the doc that captured the most
 *     recent local step (multi-doc mutations route to their PRIMARY doc —
 *     the site doc for roster/shell ops, the row doc otherwise).
 *
 * Modes:
 *   - DETACHED (default; tests, and the window before the socket connects):
 *     docs live locally, seeded on first use from the loaded site. Everything works
 *     single-user with no transport.
 *   - CONNECTED (editor runtime): `connectCollabProvider` rebinds every doc
 *     through the CollabProvider — empty docs that the SERVER seeds (the
 *     single-seeder rule). Edits gate on per-doc sync (sub-second); the
 *     HTTP-loaded projection keeps the canvas painted meanwhile.
 */
import * as Y from 'yjs'
import type { Patches } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import {
  applySitePatchesToDocs,
  createCollabDocSet,
  dataMap,
  isSiteDocId,
  LOCAL_ORIGIN,
  metaMap,
  parseCollabDocId,
  rostersMap,
  SEED_ORIGIN,
  shellMap,
  siteDocId,
  treeMap,
  type CollabDocSet,
} from '@core/collab'
import { allDocIdsForSite, collabBranchId, needsSiteRosterAssembly, notifyCollabBranchGone } from './collabBranch'
import { createDetachedCollabDocSet } from './detachedCollabDocs'
import { projectCollabDocument } from './collabProjection'
import type { EditorStoreApi } from '@site/store/types'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import type { Awareness } from 'y-protocols/awareness'
import type { BoundCollabDoc, CollabProvider } from '@site/collab/collabProvider'
import {
  collabBlockToast,
  clearCollabBlockNotice,
  collabResetToast,
  resetTargetsActiveDocument,
  transportBlockReason,
  type BlockedReason,
  type LocalPatchOutcome,
} from './collabNotices'
import { anyGateUnsynced, clearProviderGates, hasProviderGate, registerProviderGate, setGatesActive } from './collabWriteGate'

interface ManagedDoc {
  doc: Y.Doc
  manager: Y.UndoManager
  detach: () => void
}

let storeApi: EditorStoreApi | null = null
let docs: CollabDocSet = createCollabDocSet()
let managed = new Map<string, ManagedDoc>()
/**
 * Undo routing — one entry per undoable STEP, holding every docId whose
 * UndoManager captured a new stack item during that step. Single-doc
 * mutations push `[docId]`; multi-doc mutations (convert-to-component,
 * roster ops, Super Import) push the whole group so one Cmd+Z reverts the
 * entire mutation across all its docs.
 */
let undoRoute: string[][] = []
let redoRoute: string[][] = []
const lastCoalesce = new Map<string, string | null>()
let provider: CollabProvider | null = null
let detachProviderReset: (() => void) | null = null
let detachProviderStatus: (() => void) | null = null
const pendingProjections = new Set<string>()
const pendingSyncCompletions = new Map<string, () => void>()
let projectionFlushScheduled = false
/**
 * The exact store `site` object the doc world currently mirrors. Every path
 * that changes both sides together records the new reference (local
 * mutations, loads/resets, projections). When a mutation's PRE-site is a
 * different object, the store was replaced out-of-band (tests hand-assemble
 * via setState) — the detached doc world is stale wholesale and rebuilds
 * from the pre-mutation site before translating.
 */
let alignedSiteRef: SiteDocument | null = null

/** Called once by store creation — the binding's only handle into Zustand. */
export function initCollabBinding(api: EditorStoreApi): void {
  storeApi = api
}

// ---------------------------------------------------------------------------
// Awareness access (peer presence UI)
// ---------------------------------------------------------------------------

const providerChangeListeners = new Set<() => void>()

function notifyProviderChange(): void {
  for (const listener of providerChangeListeners) listener()
}

/** The connected provider's awareness instance, or null in detached mode. */
export function collabAwareness(): Awareness | null {
  return provider?.awareness ?? null
}

/** The live Y doc for a docId — caret presence encodes/resolves against it. */
export function collabDocFor(docId: string): Y.Doc | null {
  return docs.get(docId) ?? null
}

/** Notifies when the provider connects/disconnects — re-grab the awareness. */
export function onCollabProviderChange(listener: () => void): () => void {
  providerChangeListeners.add(listener)
  return () => {
    providerChangeListeners.delete(listener)
  }
}

// ---------------------------------------------------------------------------
// Doc infrastructure
// ---------------------------------------------------------------------------

function undoScopesFor(docId: string, doc: Y.Doc): Y.Map<unknown>[] {
  return isSiteDocId(docId)
    ? [shellMap(doc), rostersMap(doc)]
    : [treeMap(doc), metaMap(doc), dataMap(doc)]
}

function ensureManaged(docId: string, doc: Y.Doc): ManagedDoc {
  const existing = managed.get(docId)
  if (existing && existing.doc === doc) return existing
  existing?.detach()

  const manager = new Y.UndoManager(undoScopesFor(docId, doc), {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    // Coalescing is controlled explicitly via stopCapturing (coalesceKey
    // semantics) — an infinite window means WE decide the undo-step breaks.
    captureTimeout: Number.MAX_SAFE_INTEGER,
  })

  const updateHandler = (_update: Uint8Array, origin: unknown) => {
    // Local mutations already applied to the store directly; seeds mirror
    // what the store just loaded. Everything else projects back.
    if (origin === LOCAL_ORIGIN || origin === SEED_ORIGIN) return
    scheduleProjection(docId)
  }
  doc.on('update', updateHandler)

  const entry: ManagedDoc = {
    doc,
    manager,
    detach: () => {
      doc.off('update', updateHandler)
      manager.destroy()
    },
  }
  managed.set(docId, entry)
  return entry
}

/** DocSet facade the patch translator uses — attaches undo/observer infra on demand. */
const managedDocSet: CollabDocSet = {
  get: (docId) => docs.get(docId),
  ensure: (docId) => {
    if (provider) {
      // Route through bindDocThroughProvider so the sync gate is wired to
      // `whenSynced` — adopting the doc directly here left the gate stuck at
      // synced:false forever, and applyLocalSitePatches then rejected every
      // subsequent local mutation. Idempotent: both calls no-op when bound.
      bindDocThroughProvider(docId)
      return provider.bind(docId).doc
    }
    const doc = docs.ensure(docId)
    ensureManaged(docId, doc)
    return doc
  },
  set: (docId, doc) => {
    docs.set(docId, doc)
    ensureManaged(docId, doc)
  },
  delete: (docId) => {
    managed.get(docId)?.detach()
    managed.delete(docId)
    docs.delete(docId)
  },
  entries: () => docs.entries(),
}

// ---------------------------------------------------------------------------
// Local write path
// ---------------------------------------------------------------------------

/**
 * Tell the user their edit did not land (see {@link collabBlockToast} for the
 * once-per-episode latch) and, on the first notice of an episode, snap the
 * in-flight contentEditable back. Characters typed during the block live only
 * in the DOM; ending the session re-renders that node from the model, so what
 * the user sees returns to the last value we actually accepted. NOT
 * `cancelInlineEdit` — that calls undo(), which is itself blocked right now.
 */
export function notifyCollabBlocked(reason: BlockedReason): void {
  if (collabBlockToast(reason)) storeApi?.getState().endInlineEdit()
}

export function applyLocalSitePatches(
  patches: Patches,
  preSite: SiteDocument,
  nextSite: SiteDocument,
  coalesceKey: string | null,
): LocalPatchOutcome {
  const blocked = transportBlockReason(provider)
  if (blocked) return { accepted: false, reason: blocked }
  if (provider) {
    // Every already-bound doc must be past its first sync before edits may
    // stream — writing into an unseeded doc would duplicate server content
    // on merge. (Sub-second in practice; the toolbar shows "connecting".)
    if (anyGateUnsynced()) return { accepted: false, reason: 'syncing' }
  }

  if (!provider && preSite !== alignedSiteRef) {
    // Out-of-band site replacement (setState without loadSite). Rebuild the
    // detached doc world from the pre-mutation site so the translation —
    // and its undo — covers exactly this mutation. History from before the
    // replacement is meaningless against the new document and drops.
    // Connected mode never rebuilds from the store: synced docs are the
    // source of truth and the ref updates below as projections land.
    resetCollabDocsFromSite(preSite)
  }

  const stopped = new Set<string>()
  const decideCoalescing = (docId: string): void => {
    if (stopped.has(docId)) return
    stopped.add(docId)
    const last = lastCoalesce.get(docId) ?? null
    const entry = managed.get(docId)
    if (entry && (coalesceKey === null || coalesceKey !== last)) {
      entry.manager.stopCapturing()
    }
    lastCoalesce.set(docId, coalesceKey)
  }

  const decidingDocSet: CollabDocSet = {
    ...managedDocSet,
    ensure: (docId) => {
      const doc = managedDocSet.ensure(docId)
      decideCoalescing(docId)
      return doc
    },
  }

  const before = new Map<string, number>()
  for (const [docId, entry] of managed) before.set(docId, entry.manager.undoStack.length)

  const touched = applySitePatchesToDocs(
    patches, preSite, nextSite, decidingDocSet, LOCAL_ORIGIN, collabBranchId(),
  )
  alignedSiteRef = nextSite
  if (touched.length === 0) return { accepted: true }

  // Docs whose undo stack GREW form this step's routing group. Docs that
  // only folded into their existing top item (coalescing) push nothing —
  // the burst's original group already covers them.
  const grew = touched.filter(
    (docId) => (managed.get(docId)?.manager.undoStack.length ?? 0) > (before.get(docId) ?? 0),
  )
  if (grew.length > 0) {
    undoRoute.push(grew)
    redoRoute = []
    syncUndoFlags()
  }
  return { accepted: true }
}

/** End any in-progress coalescing burst (inline-edit session boundaries). */
export function collabBreakCoalescing(): void {
  lastCoalesce.clear()
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

function syncUndoFlags(): void {
  storeApi?.setState({
    canUndo: undoRoute.length > 0,
    canRedo: redoRoute.length > 0,
  })
}

export function collabUndo(): boolean {
  // Undo transacts with `origin = undoManager`, so it never passes through
  // applyLocalSitePatches and the write gate cannot see it. Offline, a Cmd+Z
  // would otherwise be applied to the doc, projected into the store, and then
  // dropped by sendFrame — displayed and lost, with no warning. Checked BEFORE
  // undoRoute.pop() so a refused undo does not consume a history step.
  const blocked = transportBlockReason(provider)
  if (blocked) {
    notifyCollabBlocked(blocked)
    return false
  }
  while (undoRoute.length > 0) {
    const group = undoRoute.pop()!
    let undid = false
    lastCoalesce.clear()
    // Reverse touch order: the site doc is always first in a group, so
    // row-level reverts land before the roster/shell revert projects.
    for (const docId of [...group].reverse()) {
      const entry = managed.get(docId)
      if (entry && entry.manager.undoStack.length > 0) {
        entry.manager.undo()
        undid = true
      }
    }
    if (undid) {
      // Undo repaints synchronously — the managers fired the doc updates
      // inside .undo(), so the projections are already pending.
      flushProjections()
      redoRoute.push(group)
      syncUndoFlags()
      return true
    }
  }
  syncUndoFlags()
  return false
}

export function collabRedo(): boolean {
  const blocked = transportBlockReason(provider)
  if (blocked) {
    notifyCollabBlocked(blocked)
    return false
  }
  while (redoRoute.length > 0) {
    const group = redoRoute.pop()!
    let redid = false
    lastCoalesce.clear()
    for (const docId of group) {
      const entry = managed.get(docId)
      if (entry && entry.manager.redoStack.length > 0) {
        entry.manager.redo()
        redid = true
      }
    }
    if (redid) {
      flushProjections()
      undoRoute.push(group)
      syncUndoFlags()
      return true
    }
  }
  syncUndoFlags()
  return false
}

export function collabClearHistory(): void {
  for (const [, entry] of managed) entry.manager.clear()
  undoRoute = []
  redoRoute = []
  lastCoalesce.clear()
  syncUndoFlags()
}

// ---------------------------------------------------------------------------
// Projection (remote / undo / reconcile → store)
// ---------------------------------------------------------------------------

function flushProjections(): void {
  const batch = [...pendingProjections]
  pendingProjections.clear()
  const api = storeApi
  const site = api?.getState().site
  if (batch.length === 0) return
  const completeSync = () => {
    for (const id of batch) {
      pendingSyncCompletions.get(id)?.()
      pendingSyncCompletions.delete(id)
    }
  }
  if (!api || !site) { completeSync(); return }
  // Site doc last — it assembles rows the row projections just refreshed.
  batch.sort((a, b) => (isSiteDocId(a) ? 1 : 0) - (isSiteDocId(b) ? 1 : 0))
  let nextSite = site
  const context = {
    getDoc: (docId: string) => docs.get(docId),
    branchId: collabBranchId(),
    bindDoc: bindDocThroughProvider,
  }
  for (const id of batch) nextSite = projectCollabDocument(nextSite, id, context)
  if (nextSite === site) { completeSync(); return }
  alignedSiteRef = nextSite
  api.setState((draft) => {
    draft.site = nextSite
    if (nextSite.packageJson !== site.packageJson) draft.packageJson = nextSite.packageJson
    if (nextSite.runtime !== site.runtime) draft.siteRuntime = nextSite.runtime
    if (!nextSite.pages.some((p) => p.id === draft.activePageId)) {
      draft.activePageId = nextSite.pages[0]?.id ?? null
    }
    // Project rows and their roster atomically before pruning selections.
    pruneCanvasSelectionDraft(draft)
  })
  completeSync()
}

function scheduleProjection(docId: string): void {
  pendingProjections.add(docId)
  if (projectionFlushScheduled) return
  projectionFlushScheduled = true
  const flush = () => {
    projectionFlushScheduled = false
    flushProjections()
  }
  // Initial sync spans thousands of socket tasks on large sites. Group those
  // tasks over a frame while writes are gated; live edits retain microtask
  // projection so the next local mutation reads the latest remote content.
  if (provider && anyGateUnsynced()) setTimeout(flush, 16)
  else queueMicrotask(flush)
}

// ---------------------------------------------------------------------------
// Lifecycle + provider connection
// ---------------------------------------------------------------------------

/**
 * Reset the doc world to mirror a freshly loaded site (or nothing). In
 * detached mode the docs seed locally on first use; in connected mode every doc
 * rebinds through the provider (server-seeded).
 */
export function resetCollabDocsFromSite(site: SiteDocument | null): void {
  alignedSiteRef = site
  for (const [, entry] of managed) entry.detach()
  managed = new Map()
  clearProviderGates()
  const previous = docs
  docs = createCollabDocSet()
  for (const [docId] of previous.entries()) {
    if (provider) provider.unbind(docId)
    else previous.delete(docId)
  }
  undoRoute = []
  redoRoute = []
  lastCoalesce.clear()
  // Drop any projection still queued for the OLD docs — flushing it against
  // the fresh doc set would project empty rows into the just-loaded site.
  pendingProjections.clear()
  for (const complete of pendingSyncCompletions.values()) complete()
  pendingSyncCompletions.clear()
  syncUndoFlags()

  if (!site) return
  if (provider) {
    bindThroughProvider(allDocIdsForSite(site))
    return
  }
  docs = createDetachedCollabDocSet(site, collabBranchId(), ensureManaged)
}

function bindDocThroughProvider(docId: string): void {
  if (!provider || hasProviderGate(docId)) return
  const binding = provider.bind(docId)
  docs.set(docId, binding.doc)
  ensureManaged(docId, binding.doc)
  registerProjectionGate(docId, binding, true)
}

/** Writes open only after the server seed has also reached the store. */
function registerProjectionGate(docId: string, binding: BoundCollabDoc, assembleRoster: boolean): void {
  let resolveProjection!: () => void
  const projected = new Promise<void>((resolve) => { resolveProjection = resolve })
  const gate = registerProviderGate(docId, projected)
  void binding.whenSynced.then(() => {
    if (docs.get(docId) !== binding.doc) { resolveProjection(); return }
    pendingSyncCompletions.set(docId, () => {
      gate.synced = true
      resolveProjection()
    })
    scheduleProjection(docId)
    if (assembleRoster && needsSiteRosterAssembly(storeApi?.getState().site, docId)) {
      scheduleProjection(siteDocId(collabBranchId()))
    }
  })
}

function bindThroughProvider(docIds: readonly string[]): void {
  for (const docId of docIds) bindDocThroughProvider(docId)
}

/**
 * Switch to CONNECTED mode: all current and future docs bind through the
 * provider (server-seeded). Called by the editor runtime once the socket
 * exists; never called in unit tests (detached mode).
 */
export function connectCollabProvider(next: CollabProvider): void {
  provider = next
  setGatesActive(true)
  detachProviderStatus?.()
  // A recovered transport re-arms the block notice, so the NEXT outage speaks
  // up instead of being swallowed by the previous one's latch.
  detachProviderStatus = next.onStatus((status) => {
    if (status === 'connected') clearCollabBlockNotice()
  })
  detachProviderReset?.()
  detachProviderReset = next.onReset((docId, reason) => {
    if (reason === 'gone') {
      // The branch is gone: leave it (rebinding would only be refused again).
      next.unbind(docId)
      const parsed = parseCollabDocId(docId)
      if (parsed) notifyCollabBranchGone(parsed.branchId)
      return
    }
    collabResetToast(reason)
    const current = storeApi?.getState()
    if (
      current?.activeInlineEdit &&
      resetTargetsActiveDocument(docId, current.activeDocument, current.activePageId)
    ) {
      current.endInlineEdit()
    }
    // The undo history belongs to the lineage that just died: its
    // UndoManager is rebuilt empty below, so any routing entry still naming
    // this doc would make Cmd+Z a silent no-op that consumes a step.
    undoRoute = undoRoute.map((group) => group.filter((id) => id !== docId)).filter((g) => g.length > 0)
    redoRoute = redoRoute.map((group) => group.filter((id) => id !== docId)).filter((g) => g.length > 0)
    syncUndoFlags()
    // The server dropped this doc: rebind and let the fresh server seed
    // re-project into the store.
    const rebound = next.bind(docId)
    docs.set(docId, rebound.doc)
    ensureManaged(docId, rebound.doc)
    registerProjectionGate(docId, rebound, false)
  })
  const site = storeApi?.getState().site ?? null
  resetCollabDocsFromSite(site)
  notifyProviderChange()
}

export function disconnectCollabProvider(): void {
  detachProviderReset?.()
  detachProviderReset = null
  detachProviderStatus?.()
  detachProviderStatus = null
  provider?.destroy()
  provider = null
  setGatesActive(false)
  clearProviderGates()
  const site = storeApi?.getState().site ?? null
  resetCollabDocsFromSite(site)
  notifyProviderChange()
}
