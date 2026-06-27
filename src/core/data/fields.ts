/**
 * Field-shape helpers for the data module.
 *
 *   normalizeDataTableFields   — coerces an unknown JSON blob into a valid
 *                                `DataField[]`, dropping anything malformed.
 *                                Used on read from `data_tables.fields_json`.
 *   buildPostTypeDefaultFields — the canonical built-in field set for a new
 *                                `kind: 'postType'` table. Title + slug are
 *                                mandatory; body / featured media / SEO are
 *                                optional built-ins that ship enabled.
 *   findField                  — lookup helper.
 *   isPostTypeBuiltInFieldId   — predicate for the reserved field-id check.
 */

import { filterArray } from '@core/utils/typeboxHelpers'
import {
  DataFieldSchema,
  POST_TYPE_FIELD_BODY,
  POST_TYPE_FIELD_FEATURED_MEDIA,
  POST_TYPE_FIELD_SEO,
  POST_TYPE_FIELD_SLUG,
  POST_TYPE_FIELD_TITLE,
  POST_TYPE_MANDATORY_FIELD_IDS,
  POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS,
  type DataField,
  type DataMeta,
  type DataMetaField,
  type DataTable,
} from './schemas'

export function normalizeDataTableFields(value: unknown): DataField[] {
  return filterArray(DataFieldSchema, value)
}

function findField(table: Pick<DataTable, 'fields'>, fieldId: string): DataField | null {
  return table.fields.find((field) => field.id === fieldId) ?? null
}

export function dataTableHasField(table: Pick<DataTable, 'fields'>, fieldId: string): boolean {
  return findField(table, fieldId) !== null
}

const POST_TYPE_BUILTIN_FIELD_IDS = new Set<string>([
  ...POST_TYPE_MANDATORY_FIELD_IDS,
  ...POST_TYPE_OPTIONAL_BUILTIN_FIELD_IDS,
])

export function isPostTypeBuiltInFieldId(fieldId: string): boolean {
  return POST_TYPE_BUILTIN_FIELD_IDS.has(fieldId)
}

// ---------------------------------------------------------------------------
// buildDataMeta — builds the lean binding catalog from a list of DataTables.
//
// Strips deep field settings (options, validation, format, currency, …) and
// keeps only what the instatic binding picker needs: identifiers, labels,
// types, and per-type extras (mediaKind, allowMultiple, targetTableSlug).
//
// Relation fields whose targetTableId does not resolve to a known table are
// omitted from the output — a dangling reference is not useful in a picker.
// ---------------------------------------------------------------------------

function buildMetaFields(
  fields: DataField[],
  tableSlugById: Map<string, string>,
): DataMetaField[] {
  const result: DataMetaField[] = []
  for (const field of fields) {
    if (field.type === 'media') {
      const entry: DataMetaField = { id: field.id, label: field.label, type: field.type }
      if (field.mediaKind !== undefined) entry.mediaKind = field.mediaKind
      if (field.allowMultiple !== undefined) entry.allowMultiple = field.allowMultiple
      result.push(entry)
    } else if (field.type === 'relation') {
      const targetTableSlug = tableSlugById.get(field.targetTableId)
      if (targetTableSlug === undefined) continue
      const entry: DataMetaField = {
        id: field.id,
        label: field.label,
        type: field.type,
        targetTableSlug,
      }
      if (field.allowMultiple !== undefined) entry.allowMultiple = field.allowMultiple
      result.push(entry)
    } else if (field.type === 'pageTree' || field.type === 'fieldSchema' || field.type === 'seoMetadata') {
      // Structural types — not part of the instatic binding catalog.
      // pageTree / fieldSchema / seoMetadata cells hold whole documents
      // (tree / field array / SEO object), not scalar values that can be
      // bound to a property control.
      continue
    } else {
      result.push({ id: field.id, label: field.label, type: field.type })
    }
  }
  return result
}

export function buildDataMeta(tables: DataTable[]): DataMeta {
  const tableSlugById = new Map<string, string>()
  for (const table of tables) {
    tableSlugById.set(table.id, table.slug)
  }

  return {
    tables: tables.map((table) => ({
      id: table.id,
      slug: table.slug,
      name: table.name,
      kind: table.kind,
      singularLabel: table.singularLabel,
      pluralLabel: table.pluralLabel,
      primaryFieldId: table.primaryFieldId,
      routable: (table.routeBase ?? '').length > 0,
      versioned: table.kind === 'postType',
      fields: buildMetaFields(table.fields, tableSlugById),
    })),
  }
}

/**
 * Canonical built-in field set for a new post-type table. Order matters —
 * the Content authoring UI relies on iteration order to render sections.
 */
export function buildPostTypeDefaultFields(): DataField[] {
  return [
    {
      type: 'text',
      id: POST_TYPE_FIELD_TITLE,
      label: 'Title',
      required: true,
      builtIn: true,
    },
    {
      type: 'text',
      id: POST_TYPE_FIELD_SLUG,
      label: 'Slug',
      required: true,
      builtIn: true,
    },
    {
      type: 'richText',
      id: POST_TYPE_FIELD_BODY,
      label: 'Body',
      format: 'markdown',
      builtIn: true,
    },
    {
      type: 'media',
      id: POST_TYPE_FIELD_FEATURED_MEDIA,
      label: 'Featured media',
      mediaKind: 'image',
      builtIn: true,
    },
    {
      type: 'seoMetadata',
      id: POST_TYPE_FIELD_SEO,
      label: 'SEO',
      builtIn: true,
    },
  ]
}
