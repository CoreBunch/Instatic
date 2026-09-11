/**
 * A data table as a branch entity: its settings and field schema. Rows are
 * entities of their own; a table with rows refuses to be deleted, which is
 * why tables apply before rows and delete after them.
 */
import { physicalId } from '@core/branches'
import { DataFieldSchema, DataTableKindSchema, type DataTable } from '@core/data/schemas'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  createDataTable,
  getDataTable,
  restoreDataTable,
  softDeleteDataTable,
  updateDataTable,
} from '../../repositories/data'
import { parseContent } from '../contentHash'
import { fieldChanges, schemaDiff } from '../changeDetail'
import { MergeApplyError, type BranchEntityAdapter, type BranchEntityOf } from './adapter'

const TableContentSchema = Type.Object({
  name: Type.String(),
  slug: Type.String(),
  kind: DataTableKindSchema,
  routeBase: Type.String(),
  singularLabel: Type.String(),
  pluralLabel: Type.String(),
  primaryFieldId: Type.String(),
  fields: Type.Array(DataFieldSchema),
})
export type TableContent = Static<typeof TableContentSchema>
export type TableEntity = BranchEntityOf<'table', TableContent>

function tableContent(table: DataTable): TableContent {
  return {
    name: table.name,
    slug: table.slug,
    kind: table.kind,
    routeBase: table.routeBase,
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
    primaryFieldId: table.primaryFieldId,
    fields: table.fields,
  }
}

const TABLE_LABELS: Record<string, string> = {
  name: 'Name',
  slug: 'Slug',
  kind: 'Kind',
  routeBase: 'Route base',
  singularLabel: 'Singular label',
  pluralLabel: 'Plural label',
  primaryFieldId: 'Primary field',
}

export const tableAdapter: BranchEntityAdapter<'table', TableContent> = {
  kind: 'table',
  // Creates and updates before the rows that need the table; deletes after
  // the rows are gone.
  order: (action) => (action === 'delete' ? 4 : 2),

  async collect(source): Promise<TableEntity[]> {
    return (await source.tables()).map((table) => ({
      kind: 'table',
      logicalId: table.id,
      label: table.name,
      tableId: null,
      tableName: null,
      content: tableContent(table),
    }))
  },

  parse: (value) => parseContent(TableContentSchema, value, 'table'),

  describe(before, after, conflicts) {
    const { fields: beforeFields = [], ...beforeSettings } = before ?? {}
    const { fields: afterFields = [], ...afterSettings } = after ?? {}
    return {
      kind: 'table',
      fields: fieldChanges(beforeSettings, afterSettings, { prefix: '', conflicts: new Set(conflicts), labels: TABLE_LABELS }),
      schema: schemaDiff(beforeFields, afterFields),
    }
  },

  async write(tx, scope, target, content, ctx) {
    if (content === null) {
      const deleted = await softDeleteDataTable(tx, scope, target.logicalId, ctx.actorUserId)
      if (!deleted) {
        throw new MergeApplyError(
          target.key,
          `The table "${target.label}" still has rows on ${scope.branchId}; delete them or keep the table`,
        )
      }
      return
    }
    const settings = {
      name: content.name,
      slug: content.slug,
      routeBase: content.routeBase,
      singularLabel: content.singularLabel,
      pluralLabel: content.pluralLabel,
      primaryFieldId: content.primaryFieldId,
      fields: content.fields,
      updatedByUserId: ctx.actorUserId,
    }
    if (await getDataTable(tx, scope, target.logicalId)) {
      await updateDataTable(tx, scope, target.logicalId, settings)
      return
    }
    // A table this side had deleted comes back with the incoming settings.
    if (await restoreDataTable(tx, scope, target.logicalId, settings)) return
    await createDataTable(tx, scope, {
      id: target.logicalId,
      ...content,
      createdByUserId: ctx.actorUserId,
      updatedByUserId: ctx.actorUserId,
    })
  },

  async copy(source, to) {
    // The physical key is minted per row in TS (the single scheme).
    const from = source.scope
    for (const table of await source.tables()) {
      await source.db`
        insert into data_tables (
          id, branch_id, name, slug, kind, route_base, singular_label,
          plural_label, primary_field_id, fields_json, system,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        )
        select ${physicalId(to.branchId, table.id)}, ${to.branchId}, name, slug, kind, route_base,
               singular_label, plural_label, primary_field_id, fields_json, system,
               created_by_user_id, updated_by_user_id, created_at, updated_at
        from data_tables
        where id = ${physicalId(from.branchId, table.id)}
      `
    }
  },

  async remove(tx, branchId) {
    await tx`delete from data_tables where branch_id = ${branchId}`
  },
}
