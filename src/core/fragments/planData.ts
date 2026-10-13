/**
 * Table and media merge for `planFragmentInsert`.
 *
 * Tables match by slug and the site's table wins: a fragment field the table
 * lacks (by field id) is appended, nothing else changes, and the fragment's
 * sample rows are NOT added. A table the site lacks is created with its
 * schema and rows. Relation fields only survive when the table they point at
 * travels in the same fragment; relation CELLS never travel (row ids are
 * site-local), so they insert empty.
 */

import type { DataField } from '@core/data/schemas'
import type { PageNode, StyleRule } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { collectCellMediaIds } from '@core/data/cells'
import { createPathFinder, forEachString, nodeContent, ruleContent } from './references'
import type { FragmentMedia, FragmentTable, FragmentTableRow, SiteFragment } from './schema'
import type { FragmentInsertReport, FragmentInsertTarget, PlannedFontFamily, PlannedTable } from './planTypes'
import type { FragmentWarning } from './warnings'

export function planTables(
  target: FragmentInsertTarget,
  fragment: SiteFragment,
  report: FragmentInsertReport,
  warnings: FragmentWarning[],
): { tables: PlannedTable[]; tableIdMap: Map<string, string> } {
  const carriedIds = new Set(fragment.tables.map((t) => t.id))
  const tables: PlannedTable[] = []
  const tableIdMap = new Map<string, string>()

  for (const table of fragment.tables) {
    const fields = keepPortableFields(table, carriedIds, warnings)
    const existing = target.tables.find((t) => t.slug === table.slug)
    if (existing) {
      const addFields: DataField[] = []
      for (const field of fields) {
        const current = existing.fields.find((f) => f.id === field.id)
        if (!current) {
          addFields.push(field)
          report.tables.fieldsAdded.push(`${table.slug}.${field.id}`)
        } else if (current.type !== field.type) {
          warnings.push({
            code: 'field-type-mismatch',
            message: `"${table.slug}.${field.id}" is a ${current.type} field here and ${field.type} in the fragment; the site's field is kept.`,
            subject: `${table.slug}.${field.id}`,
          })
        }
      }
      tables.push({
        action: 'reuse',
        fragmentTableId: table.id,
        tableId: existing.id,
        slug: table.slug,
        existingFields: existing.fields,
        addFields,
      })
      tableIdMap.set(table.id, existing.id)
      report.tables.reused.push(table.slug)
      continue
    }

    const rows = (table.rows ?? []).map((row) => portableRow(row, table.fields, fields))
    // Named fields only: unknown keys a fragment file carries never reach the server.
    const { name, slug, kind, singularLabel, pluralLabel, routeBase, primaryFieldId } = table
    const input = { name, slug, kind, singularLabel, pluralLabel, routeBase, primaryFieldId, fields }
    tables.push({ action: 'create', fragmentTableId: table.id, slug, input, rows })
    report.tables.created.push(table.slug)
    report.tables.rows += rows.length
  }
  return { tables, tableIdMap }
}

function keepPortableFields(
  table: FragmentTable,
  carriedIds: Set<string>,
  warnings: FragmentWarning[],
): DataField[] {
  return table.fields.filter((field) => {
    if (field.type !== 'relation' || carriedIds.has(field.targetTableId)) return true
    warnings.push({
      code: 'relation-field-dropped',
      message: `"${table.slug}.${field.id}" relates to a table the fragment does not carry, so it is left out.`,
      subject: `${table.slug}.${field.id}`,
    })
    return false
  })
}

function portableRow(row: FragmentTableRow, allFields: DataField[], kept: DataField[]): FragmentTableRow {
  const keptIds = new Set(kept.map((f) => f.id))
  const cells: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row.cells)) {
    const field = allFields.find((f) => f.id === key)
    if (field && !keptIds.has(key)) continue
    cells[key] = field?.type === 'relation' ? (field.allowMultiple ? [] : null) : structuredClone(value)
  }
  return { ...row, cells }
}

/**
 * The media the inserted content actually references: paths in placed nodes,
 * added component trees and added rules; files of font families being
 * installed; and media cells / inline paths of rows in created tables.
 * Assets only rows of a REUSED table use are not needed and not uploaded.
 */
export function referencedMedia(
  fragment: SiteFragment,
  parts: {
    nodes: PageNode[]
    components: VisualComponent[]
    rules: StyleRule[]
    fontFamilies: PlannedFontFamily[]
    tables: PlannedTable[]
  },
): FragmentMedia[] {
  const byPath = new Map(fragment.media.map((m) => [m.path, m]))
  const found = new Set<string>()
  const find = createPathFinder(byPath.keys())
  const scan = (text: string) => find(text, found)
  for (const node of parts.nodes) forEachString(nodeContent(node), scan)
  for (const vc of parts.components) for (const node of Object.values(vc.tree.nodes)) forEachString(nodeContent(node), scan)
  for (const rule of parts.rules) forEachString(ruleContent(rule), scan)

  const ids = new Set<string>()
  for (const path of found) ids.add(byPath.get(path)!.id)
  for (const family of parts.fontFamilies) {
    if (family.entry.source !== 'custom') continue
    for (const file of family.entry.files) {
      if (file.mediaAssetId) ids.add(file.mediaAssetId)
      const byFilePath = byPath.get(file.path)
      if (byFilePath) ids.add(byFilePath.id)
    }
  }
  for (const table of parts.tables) {
    if (table.action !== 'create') continue
    for (const row of table.rows) {
      for (const id of collectCellMediaIds(row.cells, table.input.fields)) ids.add(id)
      const rowPaths = new Set<string>()
      forEachString(row.cells, (text) => find(text, rowPaths))
      for (const path of rowPaths) ids.add(byPath.get(path)!.id)
    }
  }
  return fragment.media.filter((m) => ids.has(m.id))
}
