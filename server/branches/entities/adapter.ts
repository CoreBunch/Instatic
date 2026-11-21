/**
 * One adapter per kind of branch entity: the site shell, a site file, a
 * table, a row. An adapter owns everything the branch machinery needs to
 * know about its kind: what a branch holds of it (`collect`), the content
 * projection the merge compares and hashes and its wire schema (`parse`),
 * what the review shows for a change (`describe`), how a merge writes it
 * (`write`), how a fork copies it (`copy`), and how a branch delete removes
 * it (`remove`). Plan, apply, undo, fork, and delete are kind-agnostic:
 * adding a branched kind is one adapter file registered in `./index.ts`.
 */
import type { MergeChange, MergeChangeDetail, MergeEntityKind } from '@core/branches'
import type { DataTable } from '@core/data/schemas'
import type { SiteShell } from '@core/page-tree'
import type { DbClient } from '../../db/client'
import type { RowWriteKind } from '../../repositories/rowWriteEvents'
import type { BranchScope } from '../scope'

export type BranchEntityKind = MergeEntityKind
export type MergeAction = MergeChange['action']

/** One entity of a branch, with the content projection the merge compares and hashes. */
export interface BranchEntityOf<K extends BranchEntityKind, C> {
  kind: K
  logicalId: string
  label: string
  /** Logical id of the row's table; null for every other kind. */
  tableId: string | null
  tableName: string | null
  content: C
}

/**
 * What a collect reads from: the scope, plus the shell and the table list
 * loaded once and shared by every adapter, since the site and the files
 * both live in the shell row and the tables and the rows both need the
 * table list.
 */
export interface EntitySource {
  readonly db: DbClient
  readonly scope: BranchScope
  shell(): Promise<SiteShell | null>
  tables(): Promise<DataTable[]>
}

/** What a write needs to know about the change it applies. */
export type EntityRef = Pick<MergeChange, 'kind' | 'logicalId' | 'key' | 'label'>

export interface RowNotice {
  kind: RowWriteKind
  tableId: string
  rowId: string
  /** Cell ids that changed on an update (for the content event). */
  changedFieldIds: string[]
}

/** What an apply wrote, for the collab relay and the content events afterwards. */
export interface WriteNotices {
  rows: RowNotice[]
  shell: boolean
}

export interface WriteContext {
  actorUserId: string | null
  notices: WriteNotices
}

/** A planned change that cannot be applied as such (a table that still has rows, a file path already taken). */
export class MergeApplyError extends Error {
  readonly key: string

  constructor(key: string, message: string) {
    super(message)
    this.name = 'MergeApplyError'
    this.key = key
  }
}

/**
 * Function-typed members rather than method shorthand: an adapter that
 * narrows a parameter is then rejected instead of accepted bivariantly.
 */
export interface BranchEntityAdapter<K extends BranchEntityKind, C> {
  readonly kind: K
  /**
   * Where the kind sits in an apply; lower goes first, and the order for a
   * create is also the collect and copy order (delete runs it backwards).
   * Undo runs the apply order backwards.
   */
  readonly order: (action: MergeAction) => number
  /** Every entity of the kind on the source's scope. */
  readonly collect: (source: EntitySource) => Promise<Array<BranchEntityOf<K, C>>>
  /** Merged content is rebuilt from JSON: parse it into the typed shape, or throw on drift. */
  readonly parse: (value: unknown) => C
  /** What the review shows for a change between the two sides; either side may be absent. */
  readonly describe: (before: C | null, after: C | null, conflicts: readonly string[], tableId: string | null) => MergeChangeDetail
  /**
   * A plan-time refusal the three-way compare cannot see (a file whose path
   * another file already holds on the receiving side), as the conflict
   * marker to report; null when the result can land.
   */
  readonly collision?: (
    result: unknown,
    logicalId: string,
    into: ReadonlyMap<string, BranchEntityOf<BranchEntityKind, unknown>>,
  ) => string | null
  /** Write the content on the scope inside the open transaction; null deletes. */
  readonly write: (tx: DbClient, scope: BranchScope, target: EntityRef, content: C | null, ctx: WriteContext) => Promise<void>
  /**
   * Fork: copy every entity of the kind from the source's scope to `to`,
   * inside the fork's transaction. The source is shared with the other
   * kinds, so the rows copied are the rows of the tables copied.
   */
  readonly copy: (source: EntitySource, to: BranchScope) => Promise<void>
  /** Delete every stored entity of the kind of a branch, and its collab documents, inside the delete's transaction. */
  readonly remove: (tx: DbClient, branchId: string) => Promise<void>
}
