import { BundleImportSelectionSchema, ExportRequestSchema, ImportStrategySchema, SiteBundleSchema } from '@core/data/bundleSchema'
import { DataFieldSchema } from '@core/data/schemas'
import { Type } from '@core/utils/typeboxHelpers'
import { DATA_ACCESS_CAPABILITIES } from '../../auth/dataAccess'
import { DATA_EDIT_CAPABILITIES, DATA_PUBLISH_CAPABILITIES, DATA_REASSIGN_CAPABILITIES, TABLE_READ_CAPABILITIES } from '../../handlers/cms/data/access'
import {
  RowAuthorBodySchema, RowCreateBodySchema, RowScheduleBodySchema, RowStatusBodySchema, RowTableBodySchema, RowUpsertBodySchema,
  TableAccessBodySchema, TableCreateBodySchema, TablePatchBodySchema,
} from '../../handlers/cms/data/schemas'
import { PreviewBodySchema } from '../../handlers/cms/data/preview'
import { operation as op } from './operation'

const listTables = [...TABLE_READ_CAPABILITIES, ...DATA_ACCESS_CAPABILITIES]
const manage = ['data.custom.tables.manage', 'data.system.tables.manage'] as const
const readRow = [TABLE_READ_CAPABILITIES, [...DATA_EDIT_CAPABILITIES, ...DATA_PUBLISH_CAPABILITIES]]
const editRow = [TABLE_READ_CAPABILITIES, DATA_EDIT_CAPABILITIES]
const publishRow = [TABLE_READ_CAPABILITIES, DATA_PUBLISH_CAPABILITIES]
const reassign = [TABLE_READ_CAPABILITIES, DATA_REASSIGN_CAPABILITIES]
const query = Type.Partial(Type.Object({ query: Type.String(), limit: Type.Integer() }))
const exportQuery = Type.Partial(Type.Object({
  tables: Type.String({ description: 'Comma-separated table IDs' }), includeMedia: Type.Literal('1'),
  includeSite: Type.Literal('0'), includeRedirects: Type.Literal('0'), includeMediaFolders: Type.Literal('0'),
}))
export const dataOperations = [
  op('GET', 'data/_meta', DATA_ACCESS_CAPABILITIES, 'Read the data workspace metadata'),
  op('GET', 'data/search', DATA_ACCESS_CAPABILITIES, 'Search visible rows', { querySchema: query }),
  op('GET', 'data/authors', DATA_REASSIGN_CAPABILITIES, 'List eligible authors'),
  op('GET', 'data/tables', listTables, 'List visible tables', { querySchema: query }),
  op('POST', 'data/tables', 'data.custom.tables.manage', 'Create a custom table', { bodySchema: Type.Object({ ...TableCreateBodySchema.properties, fields: Type.Optional(Type.Array(DataFieldSchema)) }) }),
  op('GET', 'data/tables/:id', listTables, 'Read a table schema and field IDs'),
  op('PATCH', 'data/tables/:id', manage, 'Update a table in the corresponding system or custom family. Send appendFields on its own.', { bodySchema: Type.Object({ ...TablePatchBodySchema.properties, fields: Type.Optional(Type.Array(DataFieldSchema)) }) }),
  op('DELETE', 'data/tables/:id', 'data.custom.tables.manage', 'Delete a custom table'),
  op('GET', 'data/tables/:id/access', TABLE_READ_CAPABILITIES, 'Read live member access rules for a visible table'),
  op('PUT', 'data/tables/:id/access', manage, 'Set live member access rules for a table you manage', { bodySchema: TableAccessBodySchema }),
  op('GET', 'data/tables/:id/rows', [TABLE_READ_CAPABILITIES, DATA_ACCESS_CAPABILITIES], 'List rows within your table and ownership scope'),
  op('POST', 'data/tables/:id/rows', 'content.create', 'Create a draft row. Use table field IDs as cells keys.', { bodySchema: RowCreateBodySchema }),
  op('GET', 'data/tables/:id/loop-preview', DATA_ACCESS_CAPABILITIES, 'Preview entries for a loop', { querySchema: Type.Partial(Type.Object({
    orderBy: Type.String(), direction: Type.Union([Type.Literal('asc'), Type.Literal('desc')]), limit: Type.Integer(), offset: Type.Integer(),
    cellField: Type.String(), cellOperator: Type.String(), cellValue: Type.String(),
  })) }),
  op('GET', 'data/rows/:id', readRow, 'Read a visible row within your ownership scope'),
  op('PATCH', 'data/rows/:id', editRow, 'Update draft cells using field IDs from the table', { bodySchema: RowUpsertBodySchema }),
  op('DELETE', 'data/rows/:id', editRow, 'Delete an editable row'),
  op('POST', 'data/rows/:id/publish', publishRow, 'Publish a row on main, subject to row ownership'),
  op('POST', 'data/rows/:id/schedule', publishRow, 'Schedule publication on main. Send a future ISO timestamp.', { bodySchema: RowScheduleBodySchema }),
  op('DELETE', 'data/rows/:id/schedule', publishRow, 'Cancel scheduled publication on main'),
  op('PATCH', 'data/rows/:id/status', editRow, 'Change a row to draft or unpublished', { bodySchema: RowStatusBodySchema }),
  op('PATCH', 'data/rows/:id/author', reassign, 'Reassign an editable row to an active author', { bodySchema: RowAuthorBodySchema }),
  op('PATCH', 'data/rows/:id/table', [...editRow, ['data.rows.move']], 'Move an editable row to another table', { bodySchema: RowTableBodySchema }),
  op('POST', 'data/rows/:id/preview', readRow, 'Render an entry with optional draft cell overrides', { bodySchema: PreviewBodySchema }),
  op('GET', 'data/rows/:id/versions', readRow, 'List the published versions of a row'),
  op('POST', 'data/rows/:id/versions/:versionId/restore', editRow, 'Restore a published version into the draft'),
  ...['export', 'export/estimate'].flatMap(path => {
    const summary = path === 'export' ? 'Download a ZIP archive' : 'Estimate export size'
    const output = path === 'export' ? { outputFile: 'site.zip' } : {}
    return [
      op('GET', path, 'data.export', summary + ' for whole tables', { querySchema: exportQuery, ...output }),
      op('POST', path, 'data.export', summary + ' for a detailed selection', { bodySchema: ExportRequestSchema, ...output }),
    ]
  }),
  ...['GET', 'POST'].map(method => op(method, 'export/summary', 'data.export', 'Count exportable media, folders and redirects')),
  op('POST', 'import/preview', 'data.export', 'Preview conflicts for a JSON site bundle', { bodySchema: SiteBundleSchema }),
  op('POST', 'import', 'data.import', 'Apply a JSON bundle. Replace additionally requires content.manage. The CMS checks imported sections.', { bodySchema: SiteBundleSchema, querySchema: Type.Object({ strategy: Type.Optional(ImportStrategySchema) }) }),
  op('POST', 'import/archive', 'data.import', 'Apply an export ZIP. Replace additionally requires content.manage. URL-encode selection as JSON.', {
    raw: 'site.zip', querySchema: Type.Object({ strategy: Type.Optional(ImportStrategySchema), selection: Type.Optional(BundleImportSelectionSchema) }),
  }),
]
