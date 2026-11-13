/**
 * Data closure for `extractFragment`: the tables loops and CMS forms read, and
 * every media asset the carried content, fonts and rows reference.
 */

import type { PageNode, StyleRule } from '@core/page-tree'
import type { FontEntry } from '@core/fonts'
import type { DataRow, DataTable } from '@core/data/schemas'
import { collectCellMediaIds } from '@core/data/cells'
import { createPathFinder, forEachString, nodeContent, ruleContent } from './references'
import type { FragmentMedia, FragmentTable, FragmentTableRow } from './schema'
import type { FragmentSource, FragmentSourceMedia } from './source'
import type { FragmentWarning } from './warnings'
import { mediaPackagePath, sha256Hex } from './mediaKeys'

// ---------------------------------------------------------------------------
// 7. Tables
// ---------------------------------------------------------------------------

const BUILT_IN_LOOP_SOURCES_WITHOUT_TABLE = new Set(['entry.field', 'site.pages', 'site.media'])

export function collectTables(
  source: FragmentSource,
  allNodes: PageNode[],
  warnings: FragmentWarning[],
): FragmentTable[] {
  const withRows = new Set<string>()
  const schemaOnly = new Set<string>()
  for (const node of allNodes) {
    if (node.moduleId === 'base.loop') {
      const sourceId = typeof node.props.sourceId === 'string' ? node.props.sourceId : ''
      if (sourceId === 'data.rows') {
        const filters = node.props.filters
        const tableId = filters && typeof filters === 'object' && !Array.isArray(filters)
          ? (filters as Record<string, unknown>).tableId
          : undefined
        if (typeof tableId === 'string' && tableId) withRows.add(tableId)
      } else if (sourceId && !BUILT_IN_LOOP_SOURCES_WITHOUT_TABLE.has(sourceId)) {
        warnings.push({
          code: 'unsupported-loop-source',
          message: `A loop reads "${sourceId}", a source that only exists where its plugin is installed.`,
          subject: sourceId,
        })
      }
    } else if (node.moduleId === 'base.form' && node.props.mode === 'cms') {
      const tableId = node.props.targetTableId
      if (typeof tableId === 'string' && tableId) schemaOnly.add(tableId)
    }
  }

  const out: FragmentTable[] = []
  for (const tableId of [...withRows, ...schemaOnly]) {
    if (out.some((t) => t.id === tableId)) continue
    const table = source.tables.find((t) => t.id === tableId)
    if (!table) {
      warnings.push({
        code: 'missing-table',
        message: `A loop or form reads table "${tableId}", which the source does not include.`,
        subject: tableId,
      })
      continue
    }
    if (table.kind !== 'postType' && table.kind !== 'data') {
      warnings.push({
        code: 'unsupported-table',
        message: `Table "${table.name}" holds ${table.kind} rows, which a fragment does not carry.`,
        subject: table.slug,
      })
      continue
    }
    out.push(toFragmentTable(table, withRows.has(tableId) ? rowsOf(source.rows, tableId) : undefined))
  }
  return out
}

function rowsOf(rows: readonly DataRow[], tableId: string): FragmentTableRow[] {
  return rows
    .filter((row) => row.tableId === tableId && row.deletedAt === null)
    .map((row) => ({
      id: row.id,
      slug: row.slug,
      status: row.status === 'published' ? 'published' : 'draft',
      cells: structuredClone(row.cells),
    }))
}

function toFragmentTable(table: DataTable, rows: FragmentTableRow[] | undefined): FragmentTable {
  return {
    id: table.id,
    slug: table.slug,
    name: table.name,
    kind: table.kind === 'postType' ? 'postType' : 'data',
    singularLabel: table.singularLabel,
    pluralLabel: table.pluralLabel,
    routeBase: table.routeBase,
    primaryFieldId: table.primaryFieldId,
    fields: structuredClone(table.fields),
    ...(rows ? { rows } : {}),
  }
}

// ---------------------------------------------------------------------------
// 8. Media
// ---------------------------------------------------------------------------

export async function collectMedia(
  source: FragmentSource,
  closure: {
    styleRules: StyleRule[]
    allNodes: PageNode[]
    tables: FragmentTable[]
    fontFamilies: FontEntry[]
  },
  warnings: FragmentWarning[],
): Promise<{ media: FragmentMedia[]; mediaBytes: Map<string, Uint8Array> }> {
  const byPath = new Map(source.media.map((m) => [m.path, m]))
  const byId = new Map(source.media.map((m) => [m.id, m]))
  const foundPaths = new Set<string>()
  const find = createPathFinder(byPath.keys())
  const scan = (text: string) => find(text, foundPaths)

  for (const rule of closure.styleRules) forEachString(ruleContent(rule), scan)
  for (const node of closure.allNodes) forEachString(nodeContent(node), scan)

  const ids = new Set<string>()
  for (const path of foundPaths) {
    const media = byPath.get(path)
    if (media) ids.add(media.id)
  }
  for (const family of closure.fontFamilies) {
    for (const file of family.files) {
      if (file.mediaAssetId && byId.has(file.mediaAssetId)) ids.add(file.mediaAssetId)
      else if (byPath.has(file.path)) ids.add(byPath.get(file.path)!.id)
    }
  }
  for (const table of closure.tables) {
    for (const row of table.rows ?? []) {
      for (const id of collectCellMediaIds(row.cells, table.fields)) if (byId.has(id)) ids.add(id)
      forEachString(row.cells, scan)
    }
  }
  // Paths found in row text (rich text with an inline image) join last.
  for (const path of foundPaths) {
    const media = byPath.get(path)
    if (media) ids.add(media.id)
  }

  const media: FragmentMedia[] = []
  const mediaBytes = new Map<string, Uint8Array>()
  for (const id of ids) {
    const asset = byId.get(id)!
    const bytes = asset.readBytes ? await asset.readBytes() : null
    let key: string | undefined
    if (bytes) {
      key = await sha256Hex(bytes)
      mediaBytes.set(asset.id, bytes)
    } else if (asset.readBytes) {
      warnings.push({
        code: 'missing-media-bytes',
        message: `The bytes of ${asset.filename} are not in the source; the fragment points at ${asset.path}.`,
        subject: asset.path,
      })
    }
    media.push(toFragmentMedia(asset, key))
  }
  return { media, mediaBytes }
}

function toFragmentMedia(asset: FragmentSourceMedia, key: string | undefined): FragmentMedia {
  return {
    id: asset.id,
    ...(key ? { key } : {}),
    path: asset.path,
    filename: asset.filename,
    mimeType: asset.mimeType,
    ...(asset.sizeBytes !== undefined ? { sizeBytes: asset.sizeBytes } : {}),
    ...(typeof asset.width === 'number' ? { width: asset.width } : {}),
    ...(typeof asset.height === 'number' ? { height: asset.height } : {}),
    ...(asset.alt ? { alt: asset.alt } : {}),
    src: key ? mediaPackagePath(key, asset.filename, asset.mimeType) : asset.path,
  }
}
