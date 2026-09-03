/**
 * Content hashes for branch bases and three-way diffs.
 *
 * A base records what an entity looked like when a branch was forked (or last
 * merged); comparing a side's current hash against it says whether that side
 * changed. The hashed shape must be exactly what merge compares, so the three
 * projections below are the single definition of "the content of a row, a
 * table, and the shell".
 */
import { createHash } from 'node:crypto'
import type { Static, TSchema } from '@sinclair/typebox'
import { Type, safeParseValue } from '@core/utils/typeboxHelpers'
import { canonicalJson } from '@core/utils/canonicalJson'
import { DataFieldSchema, DataTableKindSchema, type DataRow, type DataTable } from '@core/data/schemas'
import type { SiteShell } from '@core/page-tree'

export type BranchEntityKind = 'row' | 'table' | 'site'

export interface RowContent {
  tableId: string
  cells: Record<string, unknown>
  slug: string
}

export interface TableContent {
  name: string
  slug: string
  kind: DataTable['kind']
  routeBase: string
  singularLabel: string
  pluralLabel: string
  primaryFieldId: string
  fields: DataTable['fields']
}

export interface SiteContent {
  name: string
  shell: Omit<SiteShell, 'id' | 'name' | 'createdAt' | 'updatedAt'>
}

export function rowContent(row: Pick<DataRow, 'tableId' | 'cells' | 'slug'>): RowContent {
  return { tableId: row.tableId, cells: row.cells, slug: row.slug }
}

export function tableContent(table: DataTable): TableContent {
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

export function siteContent(shell: SiteShell): SiteContent {
  const { id: _id, name, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = shell
  return { name, shell: rest }
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

// ---------------------------------------------------------------------------
// Wire/storage validation — merged content is rebuilt from JSON and must
// match the shapes the repositories accept before it is written back.
// ---------------------------------------------------------------------------

export const RowContentSchema = Type.Object({
  tableId: Type.String(),
  cells: Type.Record(Type.String(), Type.Unknown()),
  slug: Type.String(),
})

export const TableContentSchema = Type.Object({
  name: Type.String(),
  slug: Type.String(),
  kind: DataTableKindSchema,
  routeBase: Type.String(),
  singularLabel: Type.String(),
  pluralLabel: Type.String(),
  primaryFieldId: Type.String(),
  fields: Type.Array(DataFieldSchema),
})

export const SiteContentSchema = Type.Object({
  name: Type.String(),
  shell: Type.Record(Type.String(), Type.Unknown()),
})

/** Parse merged content back into its typed shape; throws on drift. */
export function parseContent<T extends TSchema>(schema: T, value: unknown, what: string): Static<T> {
  const parsed = safeParseValue(schema, value)
  if (!parsed.ok) {
    const detail = parsed.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`[branches] merged ${what} content is malformed: ${detail}`)
  }
  return parsed.value
}
