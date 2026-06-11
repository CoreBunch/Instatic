/**
 * Public surface of the data repository.
 *
 * Split into four modules by responsibility:
 *
 *   shared.ts   — shared mapper helpers (userRefAt, join-column types)
 *   versions.ts — version-number allocation for data_row_versions
 *   tables.ts   — data_tables CRUD
 *   rows/       — data_rows repository, split by responsibility (read, search,
 *                 filter, mutations, bulk, schedule, import); see rows/index.ts
 *   publish.ts  — data_row_versions + redirects + public-route lookups
 *
 * Domain types (`DataRow`, `DataTable`, `PublishedDataRow`, `DataRowRedirect`,
 * `DataRowVersion`, `DataUserReference`) are TypeBox schemas in
 * `@core/data/schemas` — import them from there.
 * Row shapes and mappers stay co-located with the queries that produce them.
 */

export {
  listDataTables,
  listDataTablesWithCounts,
  getDataTable,
  getDataTableBySlug,
  createDataTable,
  updateDataTable,
  softDeleteDataTable,
} from './tables'

export {
  listDataRows,
  listDataRowIdSlugs,
  listDataRowsWithFilter,
  searchDataRows,
  getDataRow,
  getDataRowMany,
  getDataRowBySlug,
  countDataRows,
  listDataAuthorOptions,
  createDataRow,
  createDataRowMany,
  saveDataRowDraft,
  updateDataRowDraftCells,
  saveDataRowDraftMany,
  softDeleteDataRow,
  softDeleteDataRowMany,
  updateDataRowTable,
  updateDataRowStatus,
  updateDataRowAuthor,
  scheduleDataRowPublish,
  cancelScheduledPublish,
  listDuePublishSchedules,
  reconcileDataRowRoster,
  rowsToReap,
} from './rows'

export type { ListDataRowsFilterOptions, ListDataRowsWithFilterResult } from './rows'

export {
  publishDataRow,
  removeDataRowArtefact,
  getPublishedDataRowByRoute,
  getDataRowRedirectByRoute,
} from './publish'

export {
  ensureDefaultEntryTemplate,
  backfillDefaultEntryTemplates,
} from './templateSeeding'

export { nextDataRowVersionNumber } from './versions'
