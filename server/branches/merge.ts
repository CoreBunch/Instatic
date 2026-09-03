/**
 * Merging a branch into main, and updating a branch from main.
 *
 * Both are the same three-way comparison run in opposite directions. Every
 * entity (the site shell, each table, each row) is compared on three sides:
 * the BASE — main's content when the branch and main last agreed (fork, or
 * the latest merge/update; kept in `site_branch_bases`) — the side receiving
 * changes (`into`), and the side contributing them (`from`).
 *
 *   - only `from` moved            → applied
 *   - only `into` moved            → nothing to do
 *   - both moved, different fields → merged field by field
 *   - both moved, same field       → conflict; the reviewer picks a side
 *
 * MERGE (branch → main) writes the result to main, mirrors it onto the
 * branch so both sides agree, and records it as the new base. UPDATE
 * (main → branch) only ever writes the branch: main is the live site and an
 * update must never touch it, so the base becomes main's content as of the
 * update. Row publish status is never part of the content: a merge changes
 * drafts, never what is live.
 */
import { MAIN_BRANCH_ID, mergeJson } from '@core/branches'
import { validateSite } from '@core/persistence/validate'
import type { DbClient } from '../db/client'
import { MAIN_SCOPE, isMainScope, type BranchScope } from './scope'
import {
  RowContentSchema,
  SiteContentSchema,
  TableContentSchema,
  contentHash,
  parseContent,
  type BranchEntityKind,
} from './contentHash'
import { collectBranchEntities, type BranchEntity } from './entities'
import { deleteBranchBases, listBranchBases, upsertBranchBases, type BranchBase } from '../repositories/branchBases'
import { touchBranch } from '../repositories/branches'
import {
  createDataTable,
  getDataRow,
  getDataTable,
  restoreDataTable,
  saveDataRowDraft,
  softDeleteDataRow,
  softDeleteDataTable,
  updateDataRowTable,
  updateDataTable,
  upsertDataRowDraft,
} from '../repositories/data'
import { getDraftSite, saveDraftSite } from '../repositories/site'
import {
  notifyRowWrite,
  notifyShellWrite,
  serializeCollabAwareWrite,
  type RowWriteKind,
} from '../repositories/rowWriteEvents'
import {
  emitContentEntryCreated,
  emitContentEntryDeleted,
  emitContentEntryUpdated,
} from '../publish/contentEvents'
import { runPublishFlush } from '../publish/publishFlush'

/** `merge`: branch → main. `update`: main → branch. */
export type MergeDirection = 'merge' | 'update'
/** Which side wins a conflicting entity. */
export type MergeResolution = 'into' | 'from'
export type MergeAction = 'create' | 'update' | 'delete'

export interface MergeChange {
  /** `<kind>:<logicalId>` — the key resolutions are addressed by. */
  key: string
  kind: BranchEntityKind
  logicalId: string
  label: string
  tableId: string | null
  tableName: string | null
  action: MergeAction
  /** Field paths both sides changed differently; non-empty means a decision is needed. */
  conflicts: string[]
}

export interface MergePlan {
  branchId: string
  direction: MergeDirection
  from: string
  into: string
  changes: MergeChange[]
  conflictCount: number
}

interface Work {
  change: MergeChange
  ours: BranchEntity | undefined
  theirs: BranchEntity | undefined
  /** The outcome when there is no conflict: content, or null for a deletion. */
  result: unknown | null
}

export class MergeConflictsUnresolvedError extends Error {
  readonly keys: string[]

  constructor(keys: string[]) {
    super(`Resolve ${keys.length} conflicting change${keys.length === 1 ? '' : 's'} before merging`)
    this.name = 'MergeConflictsUnresolvedError'
    this.keys = keys
  }
}

/** A planned change that cannot be applied as such (e.g. a table that still has rows). */
export class MergeApplyError extends Error {
  readonly key: string

  constructor(key: string, message: string) {
    super(message)
    this.name = 'MergeApplyError'
    this.key = key
  }
}

const DELETED_MARKER = '(deleted)'

function scopesFor(branchId: string, direction: MergeDirection): { from: BranchScope; into: BranchScope } {
  const branch: BranchScope = { branchId }
  return direction === 'merge' ? { from: branch, into: MAIN_SCOPE } : { from: MAIN_SCOPE, into: branch }
}

/** Site first, then table creates/updates, rows, and table deletes last. */
function changeOrder(change: MergeChange): number {
  if (change.kind === 'site') return 0
  if (change.kind === 'table') return change.action === 'delete' ? 3 : 1
  return 2
}

function describe(entity: BranchEntity, action: MergeAction, conflicts: string[]): MergeChange {
  return {
    key: `${entity.kind}:${entity.logicalId}`,
    kind: entity.kind,
    logicalId: entity.logicalId,
    label: entity.label,
    tableId: entity.tableId,
    tableName: entity.tableName,
    action,
    conflicts,
  }
}

interface PlanResult {
  plan: MergePlan
  work: Work[]
  /**
   * Entities identical on both sides whose base is stale or missing. Not
   * changes — but applying moves their base forward so a later edit on one
   * side is not reported as a conflict against content both sides share.
   */
  converged: BranchBase[]
  /** Bases of entities gone from both sides — a later re-creation must read as new. */
  stale: Array<{ kind: BranchEntityKind; logicalId: string }>
}

/**
 * Compute what a merge (or update) would do. Pure with respect to the
 * database — nothing is written.
 */
export async function planBranchMerge(
  db: DbClient,
  branchId: string,
  direction: MergeDirection,
): Promise<PlanResult> {
  if (branchId === MAIN_BRANCH_ID) throw new Error('main cannot be merged into itself')
  const { from, into } = scopesFor(branchId, direction)
  const bases = new Map((await listBranchBases(db, branchId)).map((base) => [`${base.kind}:${base.logicalId}`, base]))
  const [fromEntities, intoEntities] = await Promise.all([
    collectBranchEntities(db, from),
    collectBranchEntities(db, into),
  ])

  const work: Work[] = []
  const converged: BranchBase[] = []
  const stale: PlanResult['stale'] = []
  const keys = new Set([...fromEntities.keys(), ...intoEntities.keys(), ...bases.keys()])
  for (const key of keys) {
    const theirs = fromEntities.get(key)
    const ours = intoEntities.get(key)
    const base = bases.get(key)
    const theirsHash = theirs ? contentHash(theirs.content) : null
    const oursHash = ours ? contentHash(ours.content) : null
    if (theirsHash === oursHash) {
      if (ours && base?.contentHash !== oursHash) {
        converged.push({ kind: ours.kind, logicalId: ours.logicalId, contentHash: oursHash!, content: ours.content })
      } else if (!ours && base) {
        stale.push({ kind: base.kind, logicalId: base.logicalId })
      }
      continue
    }

    if (!theirs) {
      if (!base || !ours) continue
      const conflicts = base.contentHash === oursHash ? [] : [DELETED_MARKER]
      work.push({ change: describe(ours, 'delete', conflicts), ours, theirs, result: null })
      continue
    }
    if (!ours) {
      if (base && base.contentHash === theirsHash) continue
      const conflicts = base ? [DELETED_MARKER] : []
      work.push({ change: describe(theirs, 'create', conflicts), ours, theirs, result: theirs.content })
      continue
    }
    if (base && base.contentHash === theirsHash) continue
    if (base && base.contentHash === oursHash) {
      work.push({ change: describe(theirs, 'update', []), ours, theirs, result: theirs.content })
      continue
    }
    const merged = mergeJson(base?.content, ours.content, theirs.content)
    work.push({ change: describe(theirs, 'update', merged.conflicts), ours, theirs, result: merged.value })
  }

  work.sort((a, b) => changeOrder(a.change) - changeOrder(b.change) || a.change.label.localeCompare(b.change.label))
  const changes = work.map((entry) => entry.change)
  return {
    plan: {
      branchId,
      direction,
      from: from.branchId,
      into: into.branchId,
      changes,
      conflictCount: changes.filter((change) => change.conflicts.length > 0).length,
    },
    work,
    converged,
    stale,
  }
}

function resolvedResult(entry: Work, resolutions: Readonly<Record<string, MergeResolution>>): unknown | null {
  if (entry.change.conflicts.length === 0) return entry.result
  const resolution = resolutions[entry.change.key]
  if (resolution === 'from') return entry.theirs?.content ?? null
  return entry.ours?.content ?? null
}

interface RowNotice {
  kind: RowWriteKind
  tableId: string
  rowId: string
  /** Cell ids that changed on an update (for the content event). */
  changedFieldIds: string[]
}

interface WriteNotices {
  rows: RowNotice[]
  shell: boolean
}

function changedCellIds(before: unknown, after: unknown): string[] {
  const a = (before as { cells?: Record<string, unknown> } | null)?.cells ?? {}
  const b = (after as { cells?: Record<string, unknown> } | null)?.cells ?? {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
}

async function writeEntity(
  tx: DbClient,
  scope: BranchScope,
  entry: Work,
  result: unknown | null,
  actorUserId: string | null,
  notices: WriteNotices,
): Promise<void> {
  const { kind, logicalId, key } = entry.change
  if (kind === 'site') {
    const current = await getDraftSite(tx, scope)
    if (!current || result === null) return
    const content = parseContent(SiteContentSchema, result, 'site')
    // The merged shell is rebuilt from stored JSON — validate it as a whole
    // before it becomes the draft, exactly like the relay's projection.
    const shell = validateSite({
      ...current,
      ...content.shell,
      id: current.id,
      name: content.name,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    })
    await saveDraftSite(tx, scope, shell, actorUserId, { collabInternal: true })
    notices.shell = true
    return
  }
  if (kind === 'table') {
    if (result === null) {
      const deleted = await softDeleteDataTable(tx, scope, logicalId, actorUserId)
      if (!deleted) {
        throw new MergeApplyError(
          key,
          `The table "${entry.change.label}" still has rows on ${scope.branchId}; delete them or keep the table`,
        )
      }
      return
    }
    const content = parseContent(TableContentSchema, result, 'table')
    const settings = {
      name: content.name,
      slug: content.slug,
      routeBase: content.routeBase,
      singularLabel: content.singularLabel,
      pluralLabel: content.pluralLabel,
      primaryFieldId: content.primaryFieldId,
      fields: content.fields,
      updatedByUserId: actorUserId,
    }
    if (await getDataTable(tx, scope, logicalId)) {
      await updateDataTable(tx, scope, logicalId, settings)
      return
    }
    // A table this side had deleted comes back with the incoming settings.
    if (await restoreDataTable(tx, scope, logicalId, settings)) return
    await createDataTable(tx, scope, {
      id: logicalId,
      ...content,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
    })
    return
  }
  if (result === null) {
    const deleted = await softDeleteDataRow(tx, scope, logicalId, actorUserId, { collabInternal: true })
    if (deleted) notices.rows.push({ kind: 'delete', tableId: deleted.tableId, rowId: logicalId, changedFieldIds: [] })
    return
  }
  const content = parseContent(RowContentSchema, result, 'row')
  const existing = await getDataRow(tx, scope, logicalId)
  if (existing) {
    if (existing.tableId !== content.tableId) {
      await updateDataRowTable(tx, scope, logicalId, content.tableId, actorUserId, { collabInternal: true })
      notices.rows.push({ kind: 'delete', tableId: existing.tableId, rowId: logicalId, changedFieldIds: [] })
    }
    await saveDataRowDraft(tx, scope, logicalId, { cells: content.cells, slug: content.slug }, actorUserId, null, { collabInternal: true })
    notices.rows.push({
      kind: 'update',
      tableId: content.tableId,
      rowId: logicalId,
      changedFieldIds: changedCellIds({ cells: existing.cells }, content),
    })
    return
  }
  await upsertDataRowDraft(
    tx,
    scope,
    { id: logicalId, tableId: content.tableId, cells: content.cells, slug: content.slug },
    actorUserId,
    { collabInternal: true },
  )
  notices.rows.push({ kind: 'create', tableId: content.tableId, rowId: logicalId, changedFieldIds: [] })
}

function emitCollabNotices(scope: BranchScope, notices: WriteNotices): void {
  const byTable = new Map<string, Map<RowWriteKind, string[]>>()
  for (const notice of notices.rows) {
    const byKind = byTable.get(notice.tableId) ?? new Map<RowWriteKind, string[]>()
    byKind.set(notice.kind, [...(byKind.get(notice.kind) ?? []), notice.rowId])
    byTable.set(notice.tableId, byKind)
  }
  for (const [tableId, byKind] of byTable) {
    for (const [kind, rowIds] of byKind) notifyRowWrite({ branchId: scope.branchId, tableId, rowIds, kind })
  }
  if (notices.shell) notifyShellWrite(scope.branchId)
}

/** Plugins learn about main's rows the moment a merge changes them. */
async function emitContentEvents(db: DbClient, notices: WriteNotices, actorUserId: string | null): Promise<void> {
  const actor = actorUserId ? { kind: 'user' as const, userId: actorUserId } : { kind: 'system' as const }
  for (const notice of notices.rows) {
    if (notice.kind === 'create') await emitContentEntryCreated(db, MAIN_SCOPE, notice.rowId, actor)
    else if (notice.kind === 'update') await emitContentEntryUpdated(db, MAIN_SCOPE, notice.rowId, notice.changedFieldIds, actor)
    else await emitContentEntryDeleted(db, MAIN_SCOPE, notice.rowId, actor)
  }
}

export interface ApplyMergeInput {
  branchId: string
  direction: MergeDirection
  resolutions: Readonly<Record<string, MergeResolution>>
  actorUserId: string | null
}

export interface ApplyMergeResult {
  plan: MergePlan
}

/**
 * Apply a merge or update. Replans against the live data first so a change
 * that landed after the reviewer looked is never applied unseen: a new
 * conflict without a resolution aborts before anything is written.
 */
export async function applyBranchMerge(db: DbClient, input: ApplyMergeInput): Promise<ApplyMergeResult> {
  // Live editors keep edits in the relay's debounce window; persist them so
  // the merge reads exactly what people see.
  await runPublishFlush()
  // Everything that writes runs on the collab-aware lane; the plugin hooks
  // fire AFTER it releases — a listener that writes content takes the same
  // lane and would otherwise wait on the very merge that is waiting on it.
  const { plan, into, intoNotices } = await serializeCollabAwareWrite(async () => {
    const { plan, work, converged, stale } = await planBranchMerge(db, input.branchId, input.direction)
    const unresolved = plan.changes
      .filter((change) => change.conflicts.length > 0 && !input.resolutions[change.key])
      .map((change) => change.key)
    if (unresolved.length > 0) throw new MergeConflictsUnresolvedError(unresolved)

    const { from, into } = scopesFor(input.branchId, input.direction)
    const mirrorOntoFrom = input.direction === 'merge'
    const intoNotices: WriteNotices = { rows: [], shell: false }
    const fromNotices: WriteNotices = { rows: [], shell: false }

    await db.transaction(async (tx) => {
      const bases: BranchBase[] = [...converged]
      const removed: Array<{ kind: BranchEntityKind; logicalId: string }> = [...stale]
      for (const entry of work) {
        const result = resolvedResult(entry, input.resolutions)
        const resultHash = result === null ? null : contentHash(result)
        const oursHash = entry.ours ? contentHash(entry.ours.content) : null
        const theirsHash = entry.theirs ? contentHash(entry.theirs.content) : null
        if (resultHash !== oursHash) await writeEntity(tx, into, entry, result, input.actorUserId, intoNotices)
        if (mirrorOntoFrom && resultHash !== theirsHash) {
          await writeEntity(tx, from, entry, result, input.actorUserId, fromNotices)
        }
        // After a merge both sides hold the result. After an update main is
        // untouched, so main's content is what the branch last agreed with.
        const nextBase = mirrorOntoFrom ? result : entry.theirs?.content ?? null
        const { kind, logicalId } = entry.change
        if (nextBase === null) removed.push({ kind, logicalId })
        else bases.push({ kind, logicalId, contentHash: contentHash(nextBase), content: nextBase })
      }
      await upsertBranchBases(tx, input.branchId, bases)
      await deleteBranchBases(tx, input.branchId, removed)
      await touchBranch(tx, input.branchId)
    })

    emitCollabNotices(into, intoNotices)
    if (mirrorOntoFrom) emitCollabNotices(from, fromNotices)
    return { plan, into, intoNotices }
  })
  if (isMainScope(into)) await emitContentEvents(db, intoNotices, input.actorUserId)
  return { plan }
}
