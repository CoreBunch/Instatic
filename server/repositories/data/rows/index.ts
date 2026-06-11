/**
 * Public surface of the data-row repository.
 *
 * Split by responsibility:
 *
 *   mapper.ts    — internal mapping + hydrated-SELECT helpers (not re-exported)
 *   read.ts      — hydrated read queries (list / get / by-slug / authors)
 *   search.ts    — cross-table slug search (spotlight content provider)
 *   filter.ts    — operator-object filter querying (plugin content surface)
 *   mutations.ts — single-row writes (create / save / delete / move / status / author)
 *   bulk.ts      — transactional batch writes
 *   reconcile.ts — roster reconcile (the editor's incremental-save write path)
 *   schedule.ts  — scheduled-publish lifecycle
 *   import.ts    — bundle-import upserts
 *
 * Domain types (`DataRow`, etc.) are TypeBox schemas in `@core/data/schemas`.
 */

export {
  listDataRows,
  listDataRowIdSlugs,
  getDataRow,
  getDataRowMany,
  getDataRowBySlug,
  countDataRows,
  listDataAuthorOptions,
} from './read'

export { searchDataRows } from './search'
export type { DataRowSearchResult } from './search'

export { listDataRowsWithFilter } from './filter'
export type { ListDataRowsFilterOptions, ListDataRowsWithFilterResult } from './filter'

export {
  createDataRow,
  saveDataRowDraft,
  updateDataRowDraftCells,
  softDeleteDataRow,
  updateDataRowTable,
  updateDataRowStatus,
  updateDataRowAuthor,
} from './mutations'
export type { UpdateDataRowTableResult } from './mutations'

export { createDataRowMany, saveDataRowDraftMany, softDeleteDataRowMany } from './bulk'

export { reconcileDataRowRoster, rowsToReap } from './reconcile'
export type { ReconcileRowRosterInput, RowRosterWrite } from './reconcile'

export { scheduleDataRowPublish, cancelScheduledPublish, listDuePublishSchedules } from './schedule'
export type { DueScheduledRow } from './schedule'

export { upsertDataRow, insertDataRowIfAbsent, replaceDataRow } from './import'
export type { DataRowImportInput } from './import'
