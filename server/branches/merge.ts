/**
 * Merging a branch into main, and updating a branch from main.
 *
 * Both are the same three-way comparison run in opposite directions. Every
 * entity (the site shell, each site file, each table, each row) is compared on three sides:
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
import {
  MAIN_BRANCH_ID,
  mergeJson,
  type BranchMergeRecord,
  type MergeChange,
  type MergeDirection,
  type MergePlan,
  type MergeResolution,
} from '@core/branches'
import type { DbClient } from '../db/client'
import { MAIN_SCOPE, isMainScope, type BranchScope } from './scope'
import { contentHash } from './contentHash'
import {
  adapterFor,
  collectBranchEntities,
  contentOf,
  entityKey,
  type BranchEntity,
  type BranchEntityKind,
  type EntityRef,
  type WriteContext,
  type WriteNotices,
} from './entities'
import { deleteBranchBases, listBranchBases, upsertBranchBases, type BranchBase } from '../repositories/branchBases'
import { touchBranch } from '../repositories/branches'
import {
  getLatestBranchMerge,
  insertBranchMerge,
  listMergeUndoEntries,
  markBranchMergeUndone,
  type MergeUndoEntry,
} from '../repositories/branchMerges'
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

export type { MergeChange, MergeDirection, MergePlan, MergeResolution } from '@core/branches'
export { MergeApplyError } from './entities'

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

const DELETED_MARKER = '(deleted)'

function scopesFor(branchId: string, direction: MergeDirection): { from: BranchScope; into: BranchScope } {
  const branch: BranchScope = { branchId }
  return direction === 'merge' ? { from: branch, into: MAIN_SCOPE } : { from: MAIN_SCOPE, into: branch }
}

/** Where a change sits in an apply: the adapter of its kind decides. */
function changeOrder(change: MergeChange): number {
  return adapterFor(change.kind).order(change.action)
}

function describe(
  entity: BranchEntity,
  action: MergeChange['action'],
  conflicts: string[],
  ours: BranchEntity | undefined,
  theirs: BranchEntity | undefined,
): MergeChange {
  const { kind } = entity
  return {
    key: entityKey(kind, entity.logicalId),
    kind,
    logicalId: entity.logicalId,
    label: entity.label,
    tableId: entity.tableId,
    tableName: entity.tableName,
    action,
    conflicts,
    detail: adapterFor(kind).describe(contentOf(kind, ours), contentOf(kind, theirs), conflicts, entity.tableId),
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
  const bases = new Map((await listBranchBases(db, branchId)).map((base) => [entityKey(base.kind, base.logicalId), base]))
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
      work.push({ change: describe(ours, 'delete', conflicts, ours, theirs), ours, theirs, result: null })
      continue
    }
    if (!ours) {
      if (base && base.contentHash === theirsHash) continue
      const conflicts = base ? [DELETED_MARKER] : []
      work.push({ change: describe(theirs, 'create', conflicts, ours, theirs), ours, theirs, result: theirs.content })
      continue
    }
    if (base && base.contentHash === theirsHash) continue
    if (base && base.contentHash === oursHash) {
      work.push({ change: describe(theirs, 'update', [], ours, theirs), ours, theirs, result: theirs.content })
      continue
    }
    const merged = mergeJson(base?.content, ours.content, theirs.content)
    work.push({ change: describe(theirs, 'update', merged.conflicts, ours, theirs), ours, theirs, result: merged.value })
  }

  // A refusal the three-way compare cannot see (a file path another file holds).
  for (const entry of work) {
    if (entry.result === null) continue
    const marker = adapterFor(entry.change.kind).collision?.(entry.result, entry.change.logicalId, intoEntities) ?? null
    if (marker && !entry.change.conflicts.includes(marker)) entry.change.conflicts.push(marker)
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

/** Write one change's result on a scope through the adapter of its kind; null deletes. */
async function writeEntity(
  tx: DbClient,
  scope: BranchScope,
  target: EntityRef,
  result: unknown | null,
  ctx: WriteContext,
): Promise<void> {
  const adapter = adapterFor(target.kind)
  await adapter.write(tx, scope, target, result === null ? null : adapter.parse(result), ctx)
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
  /** The record `undoBranchMerge` reverses. */
  merge: BranchMergeRecord
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
  const { plan, into, intoNotices, merge } = await serializeCollabAwareWrite(async () => {
    const { plan, work, converged, stale } = await planBranchMerge(db, input.branchId, input.direction)
    const unresolved = plan.changes
      .filter((change) => change.conflicts.length > 0 && !input.resolutions[change.key])
      .map((change) => change.key)
    if (unresolved.length > 0) throw new MergeConflictsUnresolvedError(unresolved)

    const { from, into } = scopesFor(input.branchId, input.direction)
    const mirrorOntoFrom = input.direction === 'merge'
    const intoNotices: WriteNotices = { rows: [], shell: false }
    const fromNotices: WriteNotices = { rows: [], shell: false }
    const intoCtx: WriteContext = { actorUserId: input.actorUserId, notices: intoNotices }
    const fromCtx: WriteContext = { actorUserId: input.actorUserId, notices: fromNotices }
    let merge: BranchMergeRecord | null = null

    await db.transaction(async (tx) => {
      const bases: BranchBase[] = [...converged]
      const removed: Array<{ kind: BranchEntityKind; logicalId: string }> = [...stale]
      // Before-images for undo: what every written entity held on each side,
      // and the base it was judged against.
      const basesBefore = new Map(
        (await listBranchBases(tx, input.branchId)).map((base) => [entityKey(base.kind, base.logicalId), base.content]),
      )
      const undoEntries: MergeUndoEntry[] = []
      for (const entry of work) {
        const result = resolvedResult(entry, input.resolutions)
        const resultHash = result === null ? null : contentHash(result)
        undoEntries.push({
          change: entry.change,
          intoBefore: entry.ours?.content ?? null,
          fromBefore: mirrorOntoFrom ? entry.theirs?.content ?? null : null,
          baseBefore: basesBefore.get(entry.change.key) ?? null,
          resultHash,
        })
        const oursHash = entry.ours ? contentHash(entry.ours.content) : null
        const theirsHash = entry.theirs ? contentHash(entry.theirs.content) : null
        if (resultHash !== oursHash) await writeEntity(tx, into, entry.change, result, intoCtx)
        if (mirrorOntoFrom && resultHash !== theirsHash) {
          await writeEntity(tx, from, entry.change, result, fromCtx)
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
      merge = await insertBranchMerge(tx, {
        branchId: input.branchId,
        direction: input.direction,
        appliedByUserId: input.actorUserId,
        entries: undoEntries,
      })
    })

    emitCollabNotices(into, intoNotices)
    if (mirrorOntoFrom) emitCollabNotices(from, fromNotices)
    if (!merge) throw new Error('[branches] the merge transaction committed without a record')
    return { plan, into, intoNotices, merge }
  })
  if (isMainScope(into)) await emitContentEvents(db, intoNotices, input.actorUserId)
  return { plan, merge }
}

function contentHashOrNull(content: unknown | null): string | null {
  return content === null ? null : contentHash(content)
}

function entityHash(entity: BranchEntity | undefined): string | null {
  return entity ? contentHash(entity.content) : null
}

/** The latest apply cannot be reversed: nothing is recorded, or the target moved since. */
export class MergeUndoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeUndoError'
  }
}

export interface UndoMergeInput {
  branchId: string
  direction: MergeDirection
  actorUserId: string | null
}

export interface UndoMergeResult {
  merge: BranchMergeRecord
  /** Entities put back on the target. */
  restoredCount: number
}

/**
 * Reverse the latest merge or update on the branch. Every entity the apply
 * wrote goes back to what it was on the target, the bases return with it,
 * and after a merge the branch's mirrored copy goes back too, for every
 * entity that still holds the merged content (an edit made on the branch
 * since is kept). Refused outright when the TARGET moved since the apply:
 * an undo must never silently discard work that landed after the merge.
 */
export async function undoBranchMerge(db: DbClient, input: UndoMergeInput): Promise<UndoMergeResult> {
  await runPublishFlush()
  const { from, into } = scopesFor(input.branchId, input.direction)
  const mirrorOntoFrom = input.direction === 'merge'
  const { merge, restoredCount, intoNotices } = await serializeCollabAwareWrite(async () => {
    const record = await getLatestBranchMerge(db, input.branchId, input.direction)
    if (!record) throw new MergeUndoError('There is no merge to undo')
    const entries = await listMergeUndoEntries(db, record.id)
    const intoNow = await collectBranchEntities(db, into)
    const moved = entries.filter((entry) => entityHash(intoNow.get(entry.change.key)) !== entry.resultHash)
    if (moved.length > 0) {
      const names = moved.slice(0, 3).map((entry) => entry.change.label).join(', ')
      throw new MergeUndoError(
        `${into.branchId} changed since the merge (${names}${moved.length > 3 ? ', ...' : ''}); put it back by hand`,
      )
    }
    const fromNow = mirrorOntoFrom ? await collectBranchEntities(db, from) : null
    const intoNotices: WriteNotices = { rows: [], shell: false }
    const fromNotices: WriteNotices = { rows: [], shell: false }
    const intoCtx: WriteContext = { actorUserId: input.actorUserId, notices: intoNotices }
    const fromCtx: WriteContext = { actorUserId: input.actorUserId, notices: fromNotices }
    let restored = 0
    await db.transaction(async (tx) => {
      const bases: BranchBase[] = []
      const removed: Array<{ kind: BranchEntityKind; logicalId: string }> = []
      // Reverse apply order: the rows an apply created go before the table
      // it created them in (a table with rows refuses to be deleted), and a
      // table an apply deleted comes back before its rows do.
      for (const entry of [...entries].reverse()) {
        const intoBefore = entry.intoBefore ?? null
        if (contentHashOrNull(intoBefore) !== entry.resultHash) {
          await writeEntity(tx, into, entry.change, intoBefore, intoCtx)
          restored += 1
        }
        if (fromNow && entityHash(fromNow.get(entry.change.key)) === entry.resultHash) {
          const fromBefore = entry.fromBefore ?? null
          if (contentHashOrNull(fromBefore) !== entry.resultHash) {
            await writeEntity(tx, from, entry.change, fromBefore, fromCtx)
          }
        }
        const { kind, logicalId } = entry.change
        const baseBefore = entry.baseBefore ?? null
        if (baseBefore === null) removed.push({ kind, logicalId })
        else bases.push({ kind, logicalId, contentHash: contentHash(baseBefore), content: baseBefore })
      }
      await upsertBranchBases(tx, input.branchId, bases)
      await deleteBranchBases(tx, input.branchId, removed)
      await touchBranch(tx, input.branchId)
      await markBranchMergeUndone(tx, record.id)
    })
    emitCollabNotices(into, intoNotices)
    if (mirrorOntoFrom) emitCollabNotices(from, fromNotices)
    return { merge: { ...record, undoneAt: new Date().toISOString() }, restoredCount: restored, intoNotices }
  })
  if (isMainScope(into)) await emitContentEvents(db, intoNotices, input.actorUserId)
  return { merge, restoredCount }
}
