/**
 * Relational projection and site-roster authority for the collaborative relay.
 *
 * The relay owns document lifecycle and socket references; this module owns the
 * database-facing half of a Y document: deterministic JSON seeding, derived
 * row/site writes, authoritative roster deletion, and undo recovery.
 */
import * as Y from 'yjs'
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
import { getCollabDocumentState } from '../repositories/collabDocuments'
import { serializeCollabAwareWrite } from '../repositories/rowWriteEvents'
import { bumpPublishVersionSerialized } from '../publish/publishState'

const KIND_TABLE: Record<Exclude<CollabDocKind, 'site'>, string> = {
  page: 'pages',
  component: 'components',
  layout: 'layouts',
}

/**
 * The cells each doc kind derives from its Y doc. Every other cell on the
 * row (SEO title and description, featured media, plugin-owned fields) is
 * edited elsewhere and must survive a relay write untouched; an owned cell
 * the projection no longer emits (a page that stopped being a template)
 * is cleared.
 */
const OWNED_CELLS: Record<Exclude<CollabDocKind, 'site'>, readonly string[]> = {
  page: ['title', 'slug', 'body', 'templateEnabled', 'templateTarget', 'templatePriority'],
  component: ['name', 'slug', 'body', 'params', 'classIds'],
  layout: ['name', 'slug', 'body', 'classes'],
}

/** The row's stored cells with the doc-owned ones replaced by what the doc derives. */
export function mergeDerivedCells(
  existing: Record<string, unknown> | undefined,
  derived: Record<string, unknown>,
  owned: readonly string[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  for (const key of owned) delete merged[key]
  return { ...merged, ...derived }
}

export type DerivedWrite = 'written' | 'incomplete' | 'invalid'
type SiteRosters = ReturnType<typeof projectSiteDoc>['rosters']

interface RelayPersistenceHooks {
  isResident(docId: string): boolean
  schedulePersist(docId: string): void
  openDoc(docId: string): Promise<void>
  invalidationVersion(docId: string): number
}

export interface RelayPersistence {
  hasRosterSnapshot(): boolean
  rosterContains(docId: string): boolean
  observeSiteRoster(doc: Y.Doc): void
  noteOpenedRow(docId: string, state: { stored: boolean; seeded: boolean }): void
  markRowEstablished(docId: string): void
  isUnrosteredEstablishedDoc(docId: string): boolean
  seedFromJson(docId: string, doc: Y.Doc): Promise<boolean>
  serializeMutation<T>(operation: () => Promise<T>): Promise<T>
  sweepRosterDeletions(
    rosters: SiteRosters,
    invalidationCutoff: number,
    protectedDocIds?: ReadonlySet<string>,
  ): Promise<void>
  persistDerivedJson(
    docId: string,
    doc: Y.Doc,
    invalidationCutoff: number,
  ): Promise<DerivedWrite>
  invalidateRosterSweep(): void
  drainRecoveries(throwOnFailure: boolean): Promise<void>
}

export function createRelayPersistence(
  db: DbClient,
  hooks: RelayPersistenceHooks,
): RelayPersistence {
  // Last roster set the site-doc persist actually swept, so shell-field-only
  // persists skip the three full-table scans. Reset when the site doc resets.
  let lastSweptRostersKey: string | null = null
  /**
   * The site roster is authoritative for an established row doc. A freshly
   * created client doc may arrive before its roster frame, so it remains
   * provisional until either the roster names it or its first derived row is
   * written. Once established, removing it from the roster defers all later
   * row writes instead of letting a dirty editor resurrect the deletion.
   */
  let rosterDocIds: Set<string> | null = null
  const knownRowDocIds = new Set<string>()
  const provisionalRowDocIds = new Set<string>()
  const pendingRosterRecoveries = new Map<string, Promise<void>>()
  const failedRosterRecoveries = new Set<string>()

  function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    return serializeCollabAwareWrite(operation)
  }

  function projectedRosterDocIds(doc: Y.Doc): Set<string> {
    const { rosters } = projectSiteDoc(doc)
    return new Set([
      ...rosters.pages.map((rowId) => encodeCollabDocId({ kind: 'page', rowId })),
      ...rosters.components.map((rowId) => encodeCollabDocId({ kind: 'component', rowId })),
      ...rosters.layouts.map((rowId) => encodeCollabDocId({ kind: 'layout', rowId })),
    ])
  }

  function observeSiteRoster(doc: Y.Doc): void {
    const previous = rosterDocIds
    const next = projectedRosterDocIds(doc)
    rosterDocIds = next
    for (const docId of next) {
      knownRowDocIds.add(docId)
      provisionalRowDocIds.delete(docId)
      // Re-adding the same id is undo-of-delete. Its row was soft-deleted by
      // the sweep, so recover even when its row doc is no longer resident and
      // no page-local edit accompanied the roster change.
      if (previous && !previous.has(docId)) scheduleRosterRecovery(docId)
    }
  }

  function scheduleRosterRecovery(docId: string): void {
    failedRosterRecoveries.delete(docId)
    if (hooks.isResident(docId)) {
      hooks.schedulePersist(docId)
      return
    }
    if (pendingRosterRecoveries.has(docId)) return
    const recovery = (async () => {
      // Collaborative deletion keeps the row blob as an undo tombstone. Only
      // a stored lineage can be revived; never mint an empty page here.
      const stored = await getCollabDocumentState(db, docId)
      if (!stored || !rosterDocIds?.has(docId)) return
      await hooks.openDoc(docId)
      if (rosterDocIds?.has(docId)) hooks.schedulePersist(docId)
    })()
    pendingRosterRecoveries.set(docId, recovery)
    void recovery.catch((err) => {
      failedRosterRecoveries.add(docId)
      console.error(`[collab] roster undo recovery failed for ${docId}:`, err)
    }).finally(() => {
      if (pendingRosterRecoveries.get(docId) === recovery) {
        pendingRosterRecoveries.delete(docId)
      }
    })
  }

  function markRowEstablished(docId: string): void {
    knownRowDocIds.add(docId)
    provisionalRowDocIds.delete(docId)
  }

  function noteOpenedRow(
    docId: string,
    state: { stored: boolean; seeded: boolean },
  ): void {
    if (provisionalRowDocIds.has(docId)) {
      // A fresh client-created doc can reconnect before its roster frame.
    } else if (state.stored || state.seeded || knownRowDocIds.has(docId)) {
      markRowEstablished(docId)
    } else {
      provisionalRowDocIds.add(docId)
    }
  }

  function isUnrosteredEstablishedDoc(docId: string): boolean {
    return rosterDocIds !== null && knownRowDocIds.has(docId) && !rosterDocIds.has(docId)
  }

  async function seedFromJson(docId: string, doc: Y.Doc): Promise<boolean> {
    const parsed = parseCollabDocId(docId)
    if (!parsed) return false
    if (parsed.kind === 'site') {
      const shell = await getDraftSite(db)
      if (!shell) return false // pre-setup — nothing to seed
      const [pages, components, layouts] = await Promise.all([
        listDataRowIdSlugs(db, 'pages'),
        listDataRowIdSlugs(db, 'components'),
        listDataRowIdSlugs(db, 'layouts'),
      ])
      seedSiteDocFromParts(doc, shell as unknown as Record<string, unknown>, {
        pages: pages.map((row) => row.id),
        components: components.map((row) => row.id),
        layouts: layouts.map((row) => row.id),
      })
      return true
    }
    const row = await getDataRow(db, parsed.rowId)
    if (!row || row.tableId !== KIND_TABLE[parsed.kind]) return false
    if (parsed.kind === 'page') {
      seedPageDoc(doc, pageFromRow(row))
    } else if (parsed.kind === 'component') {
      const component = visualComponentFromRow(row)
      if (!component) return false
      seedComponentDoc(doc, component)
    } else {
      const layout = savedLayoutFromRow(row)
      if (!layout) return false
      seedLayoutDoc(doc, layout)
    }
    return true
  }

  async function sweepRosterDeletions(
    rosters: SiteRosters,
    invalidationCutoff: number,
    protectedDocIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    let deletedPublished = false
    for (const [kind, table, ids] of [
      ['page', 'pages', rosters.pages],
      ['component', 'components', rosters.components],
      ['layout', 'layouts', rosters.layouts],
    ] as const) {
      const live = await listDataRowIdSlugs(db, table)
      const keep = new Set(ids)
      for (const row of live) {
        const rowDocId = encodeCollabDocId({ kind, rowId: row.id })
        // A newer roster frame or authoritative row write may land while this
        // snapshot's sweep is queued. Only writes ordered AFTER the snapshot
        // are protected; an older invalidation still resetting must not erase
        // a later collaborative deletion.
        if (
          keep.has(row.id) ||
          rosterDocIds?.has(rowDocId) ||
          hooks.invalidationVersion(rowDocId) > invalidationCutoff ||
          protectedDocIds.has(rowDocId)
        ) continue
        const deleted = await softDeleteDataRow(db, row.id, null, { collabInternal: true })
        if (deleted?.status === 'published') deletedPublished = true
      }
    }
    if (deletedPublished) await bumpPublishVersionSerialized()
  }

  async function persistDerivedJson(
    docId: string,
    doc: Y.Doc,
    invalidationCutoff: number,
  ): Promise<DerivedWrite> {
    const parsed = parseCollabDocId(docId)
    if (!parsed) return 'incomplete'
    if (parsed.kind === 'site') {
      const projected = projectSiteDoc(doc)
      if (Object.keys(projected.shell).length === 0) return 'incomplete'
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

      const rostersKey =
        projected.rosters.pages.join(',') + '|' +
        projected.rosters.components.join(',') + '|' +
        projected.rosters.layouts.join(',')
      if (rostersKey === lastSweptRostersKey) return 'written'
      await sweepRosterDeletions(projected.rosters, invalidationCutoff)
      lastSweptRostersKey = rostersKey
      return 'written'
    }

    const table = KIND_TABLE[parsed.kind]
    let cells: Record<string, unknown>
    let slug: string
    if (parsed.kind === 'page') {
      const page = projectPageDoc(doc, parsed.rowId)
      if (!page.rootNodeId) return 'incomplete'
      cells = pageToCells(page)
      slug = page.slug
    } else if (parsed.kind === 'component') {
      const component = projectComponentDoc(doc, parsed.rowId)
      if (
        !component.tree.rootNodeId ||
        typeof component.name !== 'string' ||
        component.name === ''
      ) return 'incomplete'
      cells = visualComponentToCells(component)
      slug = vcSlugFromName(component.name)
    } else {
      const layout = projectLayoutDoc(doc, parsed.rowId)
      if (!layout.rootNodeId || layout.name === '') return 'incomplete'
      cells = savedLayoutToCells(layout)
      slug = layoutSlugFromName(layout.name)
    }

    // The doc carries only the cells the editor owns; the rest of the row
    // was edited elsewhere and stays exactly as stored.
    const existing = await getDataRow(db, parsed.rowId)
    await upsertDataRowDraft(
      db,
      { id: parsed.rowId, tableId: table, cells: mergeDerivedCells(existing?.cells, cells, OWNED_CELLS[parsed.kind]), slug },
      null,
      { collabInternal: true },
    )
    markRowEstablished(docId)
    return 'written'
  }

  async function drainRecoveries(throwOnFailure: boolean): Promise<void> {
    for (const docId of [...failedRosterRecoveries]) {
      if (rosterDocIds?.has(docId)) scheduleRosterRecovery(docId)
      else failedRosterRecoveries.delete(docId)
    }
    while (pendingRosterRecoveries.size > 0) {
      const results = await Promise.allSettled([...pendingRosterRecoveries.values()])
      if (throwOnFailure) {
        const failed = results.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
      await Promise.resolve()
    }
    if (throwOnFailure && failedRosterRecoveries.size > 0) {
      throw new Error(
        `cannot recover roster undo for ${[...failedRosterRecoveries].join(', ')}`,
      )
    }
  }

  return {
    hasRosterSnapshot: () => rosterDocIds !== null,
    rosterContains: (docId) => rosterDocIds?.has(docId) ?? false,
    observeSiteRoster,
    noteOpenedRow,
    markRowEstablished,
    isUnrosteredEstablishedDoc,
    seedFromJson,
    serializeMutation,
    sweepRosterDeletions,
    persistDerivedJson,
    invalidateRosterSweep: () => { lastSweptRostersKey = null },
    drainRecoveries,
  }
}
