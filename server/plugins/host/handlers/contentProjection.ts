/**
 * Projection helpers for the `cms.content.*` plugin surface — DB → wire
 * shapes. Extracted from `content.ts` (which owns the api-call handlers);
 * everything here is a pure mapping from repository types (`DataTable`,
 * `DataRow`, `DataField`) to the plugin SDK's content schemas, plus the two
 * slug-oriented lookups the mappings need.
 */

import type {
  ContentEntry,
  ContentTableSchema as ContentTableSchemaShape,
  ContentTableSummary,
} from '@core/plugin-sdk/contentSchemas'
import type { PluginRepeaterItemField } from '@core/plugin-sdk/types/content'
import type {
  DataField,
  DataRow,
  DataTable,
  RepeaterItemField,
} from '@core/data/schemas'
import type { DbClient } from '../../../db/client'
import { getDataTableBySlug, listDataTables } from '../../../repositories/data'
import { MAIN_SCOPE } from '../../../branches/scope'

/**
 * Project the host's full `DataField` union onto the narrowed
 * `PluginContentField` projection (see `types/content.ts`). Drops the
 * recursive `fieldSchema` type and reduces `relation` / `pageTree` to
 * marker shapes the plugin can introspect.
 *
 * `tableSlugById` maps the host's internal `targetTableId` to the
 * public-facing slug so the plugin boundary never leaks DB ids.
 */
function projectRepeaterItemField(
  field: RepeaterItemField,
  tableSlugById: Map<string, string>,
): PluginRepeaterItemField | null {
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'richText':
    case 'number':
      return {
        type: field.type,
        id: field.id,
        label: field.label,
        required: field.required,
      }
    case 'select':
    case 'multiSelect':
      return {
        type: field.type,
        id: field.id,
        label: field.label,
        options: (field.options ?? []).map((option) => ({
          value: option.value,
          label: option.label,
        })),
      }
    case 'media':
      return {
        type: field.type,
        id: field.id,
        label: field.label,
        mediaKind: field.mediaKind,
        allowMultiple: field.allowMultiple,
      }
    case 'relation': {
      const targetTableSlug = tableSlugById.get(field.targetTableId)
      if (targetTableSlug === undefined) return null
      return {
        type: field.type,
        id: field.id,
        label: field.label,
        targetTableSlug,
        allowMultiple: field.allowMultiple,
      }
    }
    case 'boolean':
    case 'date':
    case 'dateTime':
    case 'url':
    case 'email':
      return { type: field.type, id: field.id, label: field.label }
  }
}

function projectFields(
  fields: DataField[],
  tableSlugById: Map<string, string>,
): ContentTableSchemaShape['fields'] {
  const out: ContentTableSchemaShape['fields'] = []
  for (const f of fields) {
    switch (f.type) {
      case 'text':
      case 'longText':
      case 'richText':
      case 'number':
        out.push({ type: f.type, id: f.id, label: f.label, required: f.required })
        break
      case 'boolean':
      case 'date':
      case 'dateTime':
      case 'url':
      case 'email':
      case 'media':
        out.push({ type: f.type, id: f.id, label: f.label })
        break
      case 'select':
      case 'multiSelect':
        out.push({
          type: f.type,
          id: f.id,
          label: f.label,
          options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
        })
        break
      case 'relation':
        out.push({
          type: 'relation',
          id: f.id,
          label: f.label,
          targetTableSlug: tableSlugById.get(f.targetTableId) ?? '',
        })
        break
      case 'repeater': {
        const fields = f.fields
          .map((field) => projectRepeaterItemField(field, tableSlugById))
          .filter((field) => field !== null)
        out.push({
          type: 'repeater',
          id: f.id,
          label: f.label,
          required: f.required,
          fields,
          itemLabelFieldId: fields.some((field) => field.id === f.itemLabelFieldId)
            ? f.itemLabelFieldId
            : undefined,
        })
        break
      }
      case 'pageTree':
        out.push({ type: 'pageTree', id: f.id, label: f.label })
        break
      case 'fieldSchema':
        // Intentionally omitted from the v1 projection — too rich/recursive
        // for the JSON RPC boundary.
        break
    }
  }
  return out
}

export function tableSummary(
  table: DataTable,
  rowCount: number,
): ContentTableSummary {
  return {
    slug: table.slug,
    name: table.name,
    kind: table.kind,
    routeBase: table.routeBase,
    system: table.system,
    primaryFieldId: table.primaryFieldId,
    fieldCount: table.fields.length,
    rowCount,
  }
}

export function tableSchema(
  table: DataTable,
  rowCount: number,
  tableSlugById: Map<string, string>,
): ContentTableSchemaShape {
  return {
    ...tableSummary(table, rowCount),
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
    fields: projectFields(table.fields, tableSlugById),
  }
}

export async function buildTableSlugLookup(db: DbClient): Promise<Map<string, string>> {
  const tables = await listDataTables(db, MAIN_SCOPE)
  return new Map(tables.map((t) => [t.id, t.slug]))
}

export function rowToEntry(row: DataRow, tableSlug: string): ContentEntry {
  return {
    id: row.id,
    tableSlug,
    slug: row.slug,
    status: row.status,
    cells: row.cells,
    authorUserId: row.authorUserId,
    pluginActorId: (row as { pluginActorId?: string | null }).pluginActorId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    scheduledPublishAt: row.scheduledPublishAt,
  }
}

/**
 * Resolve a table by slug or throw the canonical not-found error. Runs on
 * EVERY `cms.content.*` api-call — one indexed lookup, never a full list.
 */
export async function resolveTableBySlug(
  db: DbClient,
  slug: string,
): Promise<DataTable> {
  const found = await getDataTableBySlug(db, MAIN_SCOPE, slug)
  if (!found) throw new Error(`Content table "${slug}" not found`)
  return found
}

/**
 * Compute the denormalized slug for a row. Mirrors what the host's CMS
 * handlers do at the boundary: prefer `cells.slug` when the table has a
 * slug field; fall back to an empty string for tables without one.
 */
export function denormalizeSlug(table: DataTable, cells: Record<string, unknown>): string {
  const hasSlugField = table.fields.some((f) => f.id === 'slug')
  if (!hasSlugField) return ''
  const value = cells['slug']
  return typeof value === 'string' ? value : ''
}
