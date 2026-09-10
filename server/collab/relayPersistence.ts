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
  projectLocalizationDoc,
  projectPageDoc,
  projectSiteDoc,
  seedComponentDoc,
  seedLayoutDoc,
  seedLocalizationDoc,
  sharedCollabDocId,
  seedPageDoc,
  seedSiteDocFromParts,
  type CollabDocKind,
} from '@core/collab'
import '@modules/base' // registry population — inline-text props seed as Y.Text
import type { SiteShell } from '@core/page-tree'
import { pageFromRow, pageToCells } from '@core/data/pageFromRow'
import { visualComponentFromRow, visualComponentToCells } from '@core/data/componentFromRow'
import { savedLayoutFromRow, savedLayoutToCells } from '@core/data/layoutFromRow'
import { resolveDataFieldLocalization } from '@core/localization'
import type { DataField } from '@core/data/schemas'
import type { VisualComponent } from '@core/visualComponents'
import { validateSite } from '@core/persistence/validate'
import type { DbClient } from '../db/client'
import {
  getDataRow,
  getDataTable,
  listDataRowIdSlugs,
  listDataRows,
  softDeleteDataRow,
  upsertSharedDataRowDraft,
} from '../repositories/data'
import { getContentLocalization, getDefaultLocale, getLocale, saveContentLocalizationDraft } from '../repositories/localization'
import { getDraftSite, saveDraftSite } from '../repositories/site'
import { getCollabDocumentState, listCollabDocumentIds } from '../repositories/collabDocuments'
import { serializeCollabAwareWrite } from '../repositories/rowWriteEvents'
import { bumpPublishVersionSerialized } from '../publish/publishState'

const KIND_TABLE: Record<Exclude<CollabDocKind, 'site'>, string> = {
  page: 'pages',
  component: 'components',
  layout: 'layouts',
}

export type DerivedWrite = 'written' | 'incomplete' | 'invalid'
type SiteRosters = ReturnType<typeof projectSiteDoc>['rosters']

interface RelayPersistenceHooks {
  isResident(docId: string): boolean
  residentDoc(docId: string): Y.Doc | undefined
  residentDocIds(): string[]
  schedulePersist(docId: string): void
  openDoc(docId: string): Promise<void>
  invalidationVersion(docId: string): number
}

export interface LocalizationGuardContext {
  fields: DataField[]
  components: VisualComponent[]
  sharedCells: Record<string, unknown>
}

export interface RelayPersistence {
  localizationGuardContext(docId: string): Promise<LocalizationGuardContext | null>
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
    if (hooks.isResident(docId)) hooks.schedulePersist(docId)
    if (pendingRosterRecoveries.has(docId)) return
    const recovery = (async () => {
      // Collaborative deletion keeps the row blob as an undo tombstone. Only
      // a stored lineage can be revived; never mint an empty page here.
      const stored = await getCollabDocumentState(db, docId)
      if ((!stored && !hooks.isResident(docId)) || !rosterDocIds?.has(docId)) return
      await hooks.openDoc(docId)
      if (rosterDocIds?.has(docId)) hooks.schedulePersist(docId)
      // Locale tombstones carry edits accepted while the global row was absent.
      for (const relatedId of await listCollabDocumentIds(db)) {
        if (relatedId === docId || sharedCollabDocId(relatedId) !== docId || !rosterDocIds?.has(docId)) continue
        await hooks.openDoc(relatedId)
        if (rosterDocIds?.has(docId)) hooks.schedulePersist(relatedId)
      }
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
    docId = sharedCollabDocId(docId)
    knownRowDocIds.add(docId)
    provisionalRowDocIds.delete(docId)
  }

  function noteOpenedRow(
    docId: string,
    state: { stored: boolean; seeded: boolean },
  ): void {
    docId = sharedCollabDocId(docId)
    if (provisionalRowDocIds.has(docId)) {
      // A fresh client-created doc can reconnect before its roster frame.
    } else if (state.stored || state.seeded || knownRowDocIds.has(docId)) {
      markRowEstablished(docId)
    } else {
      provisionalRowDocIds.add(docId)
    }
  }

  function isUnrosteredEstablishedDoc(docId: string): boolean {
    docId = sharedCollabDocId(docId)
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
    const row = await getDataRow(db, parsed.rowId, parsed.localeId)
    if (!row || row.tableId !== KIND_TABLE[parsed.kind]) return false
    if (parsed.localeId !== undefined) {
      const source = await getDefaultLocale(db)
      const draft = row.localization ?? await getContentLocalization(db, row.id, source.id)
      seedLocalizationDoc(doc, row.localization ?? { cells: {}, slug: draft?.slug ?? '' })
      return true
    }
    row.cells = { ...row.sharedCells }
    row.slug = typeof row.sharedCells.slug === 'string' ? row.sharedCells.slug : ''
    // Required domain names are metadata; translated page text stays in its locale doc.
    if (parsed.kind !== 'page' && !row.cells.name) row.cells.name = row.id
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

    if (parsed.localeId !== undefined) {
      let row = await getDataRow(db, parsed.rowId, parsed.localeId)
      if (!row) {
        // A new row's locale frame may arrive before the common doc debounce.
        const common = hooks.residentDoc(sharedCollabDocId(docId))
        if (!common || await persistSharedRow(sharedCollabDocId(docId), common) !== 'written') return 'incomplete'
        row = await getDataRow(db, parsed.rowId, parsed.localeId)
      }
      if (!row || row.tableId !== KIND_TABLE[parsed.kind]) return 'incomplete'
      await saveContentLocalizationDraft(db, parsed.rowId, parsed.localeId, projectLocalizationDoc(doc))
    } else {
      const result = await persistSharedRow(docId, doc)
      if (result !== 'written') return result
    }

    markRowEstablished(docId)
    return 'written'
  }

  function projectSharedCells(docId: string, doc: Y.Doc): Record<string, unknown> | null {
    const parsed = parseCollabDocId(docId)
    if (!parsed || parsed.kind === 'site') return null
    if (parsed.kind === 'page') {
      const page = projectPageDoc(doc, parsed.rowId)
      return page.rootNodeId ? pageToCells(page) : null
    }
    if (parsed.kind === 'component') {
      const component = projectComponentDoc(doc, parsed.rowId)
      return component.tree.rootNodeId && component.name ? visualComponentToCells(component) : null
    }
    const layout = projectLayoutDoc(doc, parsed.rowId)
    return layout.rootNodeId && layout.name ? savedLayoutToCells(layout) : null
  }

  function sharedProjection(fields: readonly DataField[], stored: Record<string, unknown>, projected: Record<string, unknown>): Record<string, unknown> {
    const cells = { ...stored }
    for (const field of fields) {
      if (field.type === 'pageTree' || resolveDataFieldLocalization(field) === 'shared') {
        if (Object.hasOwn(projected, field.id)) cells[field.id] = projected[field.id]
        else if (['templateEnabled', 'templateTarget', 'templatePriority'].includes(field.id)) delete cells[field.id]
      } else {
        delete cells[field.id]
      }
    }
    return cells
  }

  async function localizationGuardContext(docId: string): Promise<LocalizationGuardContext | null> {
    const parsed = parseCollabDocId(docId)
    if (!parsed || parsed.kind === 'site' || parsed.localeId === undefined || !await getLocale(db, parsed.localeId)) return null
    const table = await getDataTable(db, KIND_TABLE[parsed.kind])
    if (!table) return null
    const row = await getDataRow(db, parsed.rowId)
    if (row && row.tableId !== table.id) return null
    const common = hooks.residentDoc(sharedCollabDocId(docId))
    const projected = common ? projectSharedCells(docId, common) : null
    const sharedCells = row?.sharedCells ?? {}
    const components = new Map<string, VisualComponent>()
    for (const definition of await listDataRows(db, 'components')) {
      const component = visualComponentFromRow({ ...definition, cells: definition.sharedCells })
      if (component) components.set(component.id, component)
    }
    for (const id of hooks.residentDocIds()) {
      const address = parseCollabDocId(id)
      if (address?.kind !== 'component' || address.localeId !== undefined) continue
      const resident = hooks.residentDoc(id)
      if (!resident) continue
      const component = projectComponentDoc(resident, address.rowId)
      if (component.tree.rootNodeId && component.name) components.set(component.id, component)
    }
    return { fields: table.fields, components: [...components.values()], sharedCells: projected ? sharedProjection(table.fields, sharedCells, projected) : sharedCells }
  }

  async function persistSharedRow(docId: string, doc: Y.Doc): Promise<DerivedWrite> {
    const parsed = parseCollabDocId(docId)
    if (!parsed || parsed.kind === 'site') return 'incomplete'
    const projected = projectSharedCells(docId, doc)
    if (!projected) return 'incomplete'
    const table = await getDataTable(db, KIND_TABLE[parsed.kind])
    if (!table) return 'incomplete'
    const row = await getDataRow(db, parsed.rowId)
    const cells = sharedProjection(table.fields, row?.sharedCells ?? {}, projected)
    await upsertSharedDataRowDraft(db, { id: parsed.rowId, tableId: table.id, cells }, null, { collabInternal: true })
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
    localizationGuardContext,
    hasRosterSnapshot: () => rosterDocIds !== null,
    rosterContains: (docId) => rosterDocIds?.has(sharedCollabDocId(docId)) ?? false,
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
