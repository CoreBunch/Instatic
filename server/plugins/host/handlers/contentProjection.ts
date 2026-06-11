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
import type { DataField, DataRow, DataTable } from '@core/data/schemas'
import type { DbClient } from '../../../db/client'
import { listDataTables } from '../../../repositories/data'

/**
 * Project the host's full `DataField` union onto the narrowed
 * `PluginContentField` projection (see `types/content.ts`). Drops the
 * recursive `fieldSchema` type and reduces `relation` / `pageTree` to
 * marker shapes the plugin can introspect.
 *
 * `tableSlugById` maps the host's internal `targetTableId` to the
 * public-facing slug so the plugin boundary never leaks DB ids.
 */
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
  const tables = await listDataTables(db)
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

export async function resolveTableBySlug(
  db: DbClient,
  slug: string,
): Promise<DataTable> {
  const all = await listDataTables(db)
  const found = all.find((t) => t.slug === slug)
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
