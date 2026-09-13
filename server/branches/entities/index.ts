/**
 * The registry of branch entity adapters, and the kind-agnostic helpers the
 * merge engine, fork, delete, and review use over it. See `./adapter.ts`.
 */
import type { DataTable } from '@core/data/schemas'
import type { SiteShell } from '@core/page-tree'
import type { DbClient } from '../../db/client'
import { listDataTables } from '../../repositories/data'
import { getDraftSite } from '../../repositories/site'
import type { BranchScope } from '../scope'
import type { BranchEntityAdapter, BranchEntityKind, EntitySource } from './adapter'
import type { BranchEntityOf } from './adapter'
import { fileAdapter } from './file'
import { rowAdapter } from './row'
import { siteAdapter } from './site'
import { tableAdapter } from './table'

/**
 * The one hand-kept list: every kind's adapter. A kind added to
 * `MergeEntityKindSchema` without an entry here, or an adapter filed under
 * the wrong kind, does not compile; the content map and the entity union
 * below derive from it.
 */
interface Adapters {
  site: typeof siteAdapter
  file: typeof fileAdapter
  table: typeof tableAdapter
  row: typeof rowAdapter
}

export type ContentOf<K extends BranchEntityKind> =
  Adapters[K] extends BranchEntityAdapter<K, infer C> ? C : never

export type BranchEntity = { [K in BranchEntityKind]: BranchEntityOf<K, ContentOf<K>> }[BranchEntityKind]

const ADAPTERS: { [K in BranchEntityKind]: BranchEntityAdapter<K, ContentOf<K>> } = {
  site: siteAdapter,
  file: fileAdapter,
  table: tableAdapter,
  row: rowAdapter,
}

/** Collect and copy order, from each adapter's order for a create; delete runs it backwards. Apply order is per action. */
export const ENTITY_KINDS: readonly BranchEntityKind[] = Object.values(ADAPTERS)
  .sort((a, b) => a.order('create') - b.order('create'))
  .map((adapter) => adapter.kind)

export function adapterFor<K extends BranchEntityKind>(kind: K): BranchEntityAdapter<K, ContentOf<K>> {
  return ADAPTERS[kind]
}

/** The shell and the table list of a scope, loaded once for every adapter's collect. */
export function entitySource(db: DbClient, scope: BranchScope): EntitySource {
  let shell: Promise<SiteShell | null> | undefined
  let tables: Promise<DataTable[]> | undefined
  return {
    db,
    scope,
    shell: () => (shell ??= getDraftSite(db, scope)),
    tables: () => (tables ??= listDataTables(db, scope)),
  }
}

export function entityKey(kind: BranchEntityKind, logicalId: string): string {
  return `${kind}:${logicalId}`
}

/** The typed content of an entity filed under a key of this kind; another kind under that key is a bug. */
export function contentOf<K extends BranchEntityKind>(kind: K, entity: BranchEntity | undefined): ContentOf<K> | null {
  if (!entity) return null
  if (entity.kind !== kind) {
    throw new Error(`[branches] entity ${entity.kind}:${entity.logicalId} was filed under a ${kind} key`)
  }
  return entity.content as ContentOf<K>
}

/** Every mergeable entity of a branch in one keyed map, with the content the merge compares and hashes. */
export async function collectBranchEntities(db: DbClient, scope: BranchScope): Promise<Map<string, BranchEntity>> {
  const entities = new Map<string, BranchEntity>()
  const source = entitySource(db, scope)
  for (const kind of ENTITY_KINDS) {
    for (const entity of await adapterFor(kind).collect(source)) {
      entities.set(entityKey(entity.kind, entity.logicalId), entity)
    }
  }
  return entities
}

export { MergeApplyError, type BranchEntityKind, type EntityRef, type EntitySource, type WriteContext, type WriteNotices } from './adapter'
