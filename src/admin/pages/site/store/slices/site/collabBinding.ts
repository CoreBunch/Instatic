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
 *     docs live locally, seeded from the loaded site. Everything works
 *     single-user with no transport.
 *   - CONNECTED (editor runtime): `connectCollabProvider` rebinds every doc
 *     through the CollabProvider — empty docs that the SERVER seeds (the
 *     single-seeder rule). Edits gate on per-doc sync (sub-second); the
 *     HTTP-loaded projection keeps the canvas painted meanwhile.
 */
import * as Y from 'yjs'
import type { Patches } from 'mutative'
import type { Page, SiteDocument, SiteShell } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { SavedLayout } from '@core/layouts'
import {
  applySitePatchesToDocs,
  createCollabDocSet,
  dataMap,
  encodeCollabDocId,
  LOCAL_ORIGIN,
  metaMap,
  parseCollabDocId,
  projectComponentDoc,
  projectLayoutDoc,
  projectPageDoc,
  projectSiteDoc,
  rostersMap,
  seedComponentDoc,
  seedLayoutDoc,
  seedPageDoc,
  seedSiteDoc,
  SEED_ORIGIN,
  shellMap,
  SITE_DOC_ID,
  treeMap,
  type CollabDocSet,
} from '@core/collab'
import { clonePackageJson } from '@core/site-dependencies/manifest'
import { cloneSiteRuntimeConfig } from '@core/site-runtime'
import { validateSite } from '@core/persistence/validate'
import type { EditorStoreApi } from '@site/store/types'
import { pruneCanvasSelectionDraft } from '../selectionSlice'
import type { Awareness } from 'y-protocols/awareness'
import type { CollabProvider } from '@site/collab/collabProvider'

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
const pendingProjections = new Set<string>()
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
  return docId === SITE_DOC_ID
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
 * Translate one local mutation's site patches into the docs. Returns false
 * when the write is currently gated (connected but the target docs have not
 * finished their first sync) — the caller then rejects the mutation.
 */
export function applyLocalSitePatches(
  patches: Patches,
  preSite: SiteDocument,
  nextSite: SiteDocument,
  coalesceKey: string | null,
): boolean {
  if (provider) {
    // Every already-bound doc must be past its first sync before edits may
    // stream — writing into an unseeded doc would duplicate server content
    // on merge. (Sub-second in practice; the toolbar shows "connecting".)
    for (const [, binding] of providerBindings) {
      if (!binding.synced) return false
    }
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

  const touched = applySitePatchesToDocs(patches, preSite, nextSite, decidingDocSet, LOCAL_ORIGIN)
  alignedSiteRef = nextSite
  if (touched.length === 0) return true

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
  return true
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
  // Site doc last — it assembles rows the row projections just refreshed.
  batch.sort((a, b) => (a === SITE_DOC_ID ? 1 : 0) - (b === SITE_DOC_ID ? 1 : 0))
  for (const id of batch) projectDocIntoStore(id)
}

function scheduleProjection(docId: string): void {
  pendingProjections.add(docId)
  if (projectionFlushScheduled) return
  projectionFlushScheduled = true
  queueMicrotask(() => {
    projectionFlushScheduled = false
    flushProjections()
  })
}

function rowFromDoc(docId: string): Page | VisualComponent | SavedLayout | null {
  const parsed = parseCollabDocId(docId)
  if (!parsed || parsed.kind === 'site') return null
  const doc = docs.get(docId)
  if (!doc) return null
  if (parsed.kind === 'page') {
    const page = projectPageDoc(doc, parsed.rowId)
    return page.rootNodeId ? page : null
  }
  if (parsed.kind === 'component') {
    const vc = projectComponentDoc(doc, parsed.rowId)
    return vc.tree.rootNodeId ? vc : null
  }
  const layout = projectLayoutDoc(doc, parsed.rowId)
  return layout.rootNodeId ? layout : null
}

function projectDocIntoStore(docId: string): void {
  const api = storeApi
  if (!api) return
  const state = api.getState()
  const site = state.site
  if (!site) return
  const parsed = parseCollabDocId(docId)
  if (!parsed) return

  if (parsed.kind === 'site') {
    const doc = docs.get(docId)
    if (!doc) return
    const projected = projectSiteDoc(doc)
    if (Object.keys(projected.shell).length === 0) return
    // The projected shell is untyped wire data — validate it before it enters
    // the store, exactly like the HTTP load path (validateSite) and the relay's
    // persist path both do. `validateSite` is tolerant of individual malformed
    // entries (drops bad style rules / conditions / files rather than
    // rejecting the whole shell), so one corrupt rule from any source can't
    // crash a panel. `id`/`updatedAt` are non-collaborative — inject them like
    // the persist path. If the shell is not yet coherent (mid-sync), skip this
    // tick; the next projection re-runs once it is.
    let shell: SiteShell
    try {
      shell = validateSite({
        ...projected.shell,
        id: 'default',
        updatedAt:
          typeof projected.shell.updatedAt === 'number' ? projected.shell.updatedAt : Date.now(),
      })
    } catch (err) {
      console.warn('[collabBinding] projected shell failed validation — projection skipped:', err)
      return
    }
    const byId = {
      pages: new Map(site.pages.map((p) => [p.id, p])),
      components: new Map(site.visualComponents.map((vc) => [vc.id, vc])),
      layouts: new Map(site.layouts.map((l) => [l.id, l])),
    }
    const assemble = <T extends { id: string }>(
      ids: readonly string[],
      existing: Map<string, T>,
      kind: 'page' | 'component' | 'layout',
    ): T[] => {
      const rows: T[] = []
      for (const id of ids) {
        const known = existing.get(id)
        if (known) {
          rows.push(known)
          continue
        }
        const rowDocId = encodeCollabDocId({ kind, rowId: id })
        const fresh = rowFromDoc(rowDocId) as T | null
        if (fresh) {
          rows.push(fresh)
          continue
        }
        // A peer created this row — its doc isn't bound here yet. Bind it;
        // the whenSynced hook re-projects the site once content arrives.
        bindDocThroughProvider(rowDocId)
      }
      return rows
    }
    const nextSite: SiteDocument = {
      ...site,
      ...shell,
      pages: assemble(projected.rosters.pages, byId.pages, 'page'),
      visualComponents: assemble(projected.rosters.components, byId.components, 'component'),
      layouts: assemble(projected.rosters.layouts, byId.layouts, 'layout'),
    }
    if (projected.shell.conditions === undefined) delete nextSite.conditions
    const packageJson = clonePackageJson(nextSite.packageJson)
    const siteRuntime = cloneSiteRuntimeConfig(nextSite.runtime)
    const alignedSite = { ...nextSite, packageJson, runtime: siteRuntime }
    alignedSiteRef = alignedSite
    api.setState((draft) => {
      draft.site = alignedSite
      draft.packageJson = packageJson
      draft.siteRuntime = siteRuntime
      if (!nextSite.pages.some((p) => p.id === draft.activePageId)) {
        draft.activePageId = nextSite.pages[0]?.id ?? null
      }
      // A roster change can drop the whole document the selection lives in (a
      // peer deleted the page, or an undo removed it). Prune AFTER site +
      // activePageId land, since the pruner resolves the active tree from them.
      pruneCanvasSelectionDraft(draft)
    })
    return
  }

  const row = rowFromDoc(docId)
  const collection =
    parsed.kind === 'page' ? 'pages' : parsed.kind === 'component' ? 'visualComponents' : 'layouts'
  const rows = site[collection] as Array<{ id: string }>
  const index = rows.findIndex((r) => r.id === parsed.rowId)
  if (!row) {
    if (index === -1) return
    const nextRows = rows.filter((r) => r.id !== parsed.rowId)
    const nextSite = { ...site, [collection]: nextRows } as SiteDocument
    alignedSiteRef = nextSite
    api.setState((draft) => {
      draft.site = nextSite
      pruneCanvasSelectionDraft(draft)
    })
    return
  }
  const nextRows = index === -1 ? [...rows, row] : rows.map((r, i) => (i === index ? row : r))
  const nextSite = { ...site, [collection]: nextRows } as SiteDocument
  alignedSiteRef = nextSite
  api.setState((draft) => {
    draft.site = nextSite
    // The freshly projected row may have lost nodes — a peer deleted them, or a
    // Y.UndoManager undo reverted their creation. Prune by tree-membership, the
    // same way a local delete does: survivors keep their selection, dead ids
    // (including descendants swept with a subtree) drop out, and an inline-edit
    // session on a vanished node is closed. `pruneCanvasSelectionDraft` reads
    // the ACTIVE tree, so it self-limits to the doc the user is looking at.
    pruneCanvasSelectionDraft(draft)
  })
}

// ---------------------------------------------------------------------------
// Lifecycle + provider connection
// ---------------------------------------------------------------------------

const providerBindings = new Map<string, { synced: boolean }>()

function allDocIdsForSite(site: SiteDocument): string[] {
  return [
    SITE_DOC_ID,
    ...site.pages.map((p) => encodeCollabDocId({ kind: 'page', rowId: p.id })),
    ...site.visualComponents.map((vc) => encodeCollabDocId({ kind: 'component', rowId: vc.id })),
    ...site.layouts.map((l) => encodeCollabDocId({ kind: 'layout', rowId: l.id })),
  ]
}

/**
 * Reset the doc world to mirror a freshly loaded site (or nothing). In
 * detached mode the docs are seeded locally; in connected mode every doc
 * rebinds through the provider (server-seeded).
 */
export function resetCollabDocsFromSite(site: SiteDocument | null): void {
  alignedSiteRef = site
  for (const [, entry] of managed) entry.detach()
  managed = new Map()
  providerBindings.clear()
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
  syncUndoFlags()

  if (!site) return
  if (provider) {
    bindThroughProvider(allDocIdsForSite(site))
    return
  }
  seedDetachedDocs(site)
}

function seedDetachedDocs(site: SiteDocument): void {
  const siteDoc = docs.ensure(SITE_DOC_ID)
  seedSiteDoc(siteDoc, site)
  ensureManaged(SITE_DOC_ID, siteDoc)
  for (const page of site.pages) {
    const docId = encodeCollabDocId({ kind: 'page', rowId: page.id })
    const doc = docs.ensure(docId)
    seedPageDoc(doc, page)
    ensureManaged(docId, doc)
  }
  for (const vc of site.visualComponents) {
    const docId = encodeCollabDocId({ kind: 'component', rowId: vc.id })
    const doc = docs.ensure(docId)
    seedComponentDoc(doc, vc)
    ensureManaged(docId, doc)
  }
  for (const layout of site.layouts) {
    const docId = encodeCollabDocId({ kind: 'layout', rowId: layout.id })
    const doc = docs.ensure(docId)
    seedLayoutDoc(doc, layout)
    ensureManaged(docId, doc)
  }
}

function adoptProviderDoc(docId: string, doc: Y.Doc): { synced: boolean } {
  docs.set(docId, doc)
  ensureManaged(docId, doc)
  const gate = { synced: false }
  providerBindings.set(docId, gate)
  return gate
}

function bindDocThroughProvider(docId: string): void {
  if (!provider || providerBindings.has(docId)) return
  const binding = provider.bind(docId)
  const gate = adoptProviderDoc(docId, binding.doc)
  gate.synced = binding.synced
  void binding.whenSynced.then(() => {
    gate.synced = true
    scheduleProjection(docId)
    // A row doc bound on demand (a peer created the row) re-assembles the
    // site once its content arrives — the roster projection skipped it
    // while it was empty.
    if (docId !== SITE_DOC_ID) scheduleProjection(SITE_DOC_ID)
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
  detachProviderReset?.()
  detachProviderReset = next.onReset((docId) => {
    // The server dropped this doc (out-of-relay JSON rewrite): rebind and
    // let the fresh server seed re-project into the store.
    const rebound = next.bind(docId)
    const gate = adoptProviderDoc(docId, rebound.doc)
    gate.synced = rebound.synced
    void rebound.whenSynced.then(() => {
      gate.synced = true
      scheduleProjection(docId)
    })
  })
  const site = storeApi?.getState().site ?? null
  resetCollabDocsFromSite(site)
  notifyProviderChange()
}

export function disconnectCollabProvider(): void {
  detachProviderReset?.()
  detachProviderReset = null
  provider?.destroy()
  provider = null
  providerBindings.clear()
  const site = storeApi?.getState().site ?? null
  resetCollabDocsFromSite(site)
  notifyProviderChange()
}
