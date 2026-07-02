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
 *   apply.ts     — explicit-delete row apply (the site-document save's write path)
 *   schedule.ts  — scheduled-publish lifecycle
 *   import.ts    — bundle-import upserts
 *
 * Domain types (`DataRow`, etc.) are TypeBox schemas in `@core/data/schemas`.
 */

export {
  listDataRows,
  listDataRowIdSlugs,
  listDataRowSeqs,
  listChangedDataRowRefsSince,
  getDataRow,
  getDataRowMany,
  getDataRowBySlug,
  countDataRows,
  listDataAuthorOptions,
} from './read'

export { searchDataRows } from './search'


export { listDataRowsWithFilter } from './filter'


export {
  createDataRow,
  saveDataRowDraft,
  updateDataRowDraftCells,
  softDeleteDataRow,
  updateDataRowTable,
  updateDataRowStatus,
  updateDataRowAuthor,
} from './mutations'


export { createDataRowMany, saveDataRowDraftMany, softDeleteDataRowMany } from './bulk'

export { applyDataRowChanges, applyDataRowChangesInTx } from './apply'
export type { ApplyDataRowChangesInput, DataRowWrite } from './apply'

export { scheduleDataRowPublish, cancelScheduledPublish, listDuePublishSchedules } from './schedule'


export { upsertDataRow, insertDataRowIfAbsent, replaceDataRow } from './import'
export type { DataRowImportInput } from './import'
