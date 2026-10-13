/**
 * commitFragmentPlan — carry out a plan.
 *
 *   A. Media: reuse a library asset that is the same file, else upload.
 *   B. Fonts: install Google families, register custom ones from the uploads.
 *   C. Tables: create missing tables (and their rows), append missing fields.
 *   D. Resolve the plan against the ids A–C produced.
 *   E. ONE store transaction (`adapter.commit`): rules, conditions, tokens,
 *      fonts, components, and the nodes or the new page — one undo step.
 *
 * Failure: a media upload or table write that fails stops the insert BEFORE
 * the transaction, so nothing touches the document; files and tables already
 * created stay behind (the media library and Data workspace show them). A
 * font that fails to install is a warning: its token falls back to its
 * fallback stack. Cancellation (`signal`) stops at the next boundary and never
 * after E has started.
 */

import { isAbortError } from '@core/http'
import { getErrorMessage } from '@core/utils/errorMessage'
import type { DataField } from '@core/data/schemas'
import type { FontEntry } from '@core/fonts'
import { createPathReplacer, mapStrings } from './references'
import { resolveFragmentPlan, type FragmentApplyResult } from './resolve'
import type { FragmentInsertAdapter, FragmentMediaRef } from './adapter'
import type { FragmentInsertPlan, FragmentInsertReport, PlannedFontFamily } from './planTypes'
import type { FragmentMedia } from './schema'
import type { FragmentWarning } from './warnings'

export interface CommitFragmentPlanOptions {
  /** The bytes of one media item (from the package, or fetched from its `src`). */
  readMediaBytes(media: FragmentMedia): Uint8Array | null | Promise<Uint8Array | null>
  signal?: AbortSignal
  /** Called as each piece of server work starts, for a progress line. */
  onProgress?(step: { phase: 'media' | 'fonts' | 'tables' | 'commit'; done: number; total: number; label?: string }): void
}

export interface FragmentInsertResult extends FragmentApplyResult {
  report: FragmentInsertReport
}

export type FragmentCommitErrorStage = 'media' | 'tables'

/** Server work failed before the transaction; the document is untouched. */
export class FragmentCommitError extends Error {
  readonly stage: FragmentCommitErrorStage
  constructor(stage: FragmentCommitErrorStage, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FragmentCommitError'
    this.stage = stage
  }
}

export async function commitFragmentPlan(
  plan: FragmentInsertPlan,
  adapter: FragmentInsertAdapter,
  options: CommitFragmentPlanOptions,
): Promise<FragmentInsertResult> {
  const { signal } = options
  const warnings: FragmentWarning[] = []

  const media = await resolveMedia(plan.media, adapter, options)
  const fontEntryByFamilyId = await installFonts(plan.fontFamilies, media.idById, adapter, options, warnings)
  const tableIdMap = await writeTables(plan, media, adapter, options)

  const resolved = resolveFragmentPlan(plan, {
    mediaUrlByPath: media.urlByPath,
    tableIdMap,
    fontEntryByFamilyId,
  })

  signal?.throwIfAborted()
  options.onProgress?.({ phase: 'commit', done: 0, total: 1 })
  const applied = await adapter.commit(resolved)

  return {
    ...applied,
    report: {
      ...plan.report,
      media: { total: plan.media.length, uploaded: media.uploaded, reused: media.reused },
      warnings: [...plan.report.warnings, ...warnings],
    },
  }
}

// ---------------------------------------------------------------------------
// A. Media
// ---------------------------------------------------------------------------

interface ResolvedMedia {
  urlByPath: Map<string, string>
  idById: Map<string, string>
  uploaded: number
  reused: number
}

async function resolveMedia(
  items: FragmentMedia[],
  adapter: FragmentInsertAdapter,
  options: CommitFragmentPlanOptions,
): Promise<ResolvedMedia> {
  const out: ResolvedMedia = { urlByPath: new Map(), idById: new Map(), uploaded: 0, reused: 0 }
  const byKey = new Map<string, FragmentMediaRef>()
  let done = 0
  for (const item of items) {
    options.signal?.throwIfAborted()
    options.onProgress?.({ phase: 'media', done, total: items.length, label: item.filename })
    let ref = item.key ? byKey.get(item.key) : undefined
    if (!ref) {
      try {
        ref = await adapter.findMedia(item) ?? undefined
        if (ref) out.reused += 1
        else {
          const bytes = await options.readMediaBytes(item)
          if (!bytes) throw new Error(`no bytes for ${item.src}`)
          ref = await adapter.uploadMedia({
            filename: item.filename,
            mimeType: item.mimeType,
            bytes,
            ...(item.alt ? { altText: item.alt } : {}),
            signal: options.signal,
          })
          out.uploaded += 1
        }
      } catch (err) {
        if (isAbortError(err)) throw err
        throw new FragmentCommitError('media', `Could not add ${item.filename} to the media library: ${getErrorMessage(err, String(err))}`, { cause: err })
      }
      if (item.key) byKey.set(item.key, ref)
    }
    out.urlByPath.set(item.path, ref.url)
    out.idById.set(item.id, ref.id)
    done += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// B. Fonts
// ---------------------------------------------------------------------------

async function installFonts(
  families: PlannedFontFamily[],
  mediaIdById: Map<string, string>,
  adapter: FragmentInsertAdapter,
  options: CommitFragmentPlanOptions,
  warnings: FragmentWarning[],
): Promise<Map<string, FontEntry>> {
  const installed = new Map<string, FontEntry>()
  let done = 0
  for (const { fragmentFamilyId, entry } of families) {
    options.signal?.throwIfAborted()
    options.onProgress?.({ phase: 'fonts', done, total: families.length, label: entry.family })
    try {
      if (entry.source === 'google') {
        installed.set(fragmentFamilyId, await adapter.installGoogleFont({
          family: entry.family,
          variants: entry.variants,
          subsets: entry.subsets,
        }))
      } else {
        const files = entry.files.flatMap((file) => {
          const mediaAssetId = file.mediaAssetId ? mediaIdById.get(file.mediaAssetId) : undefined
          return mediaAssetId ? [{ mediaAssetId, variant: file.variant }] : []
        })
        if (files.length === 0) throw new Error('none of its files reached the media library')
        installed.set(fragmentFamilyId, await adapter.registerCustomFont({ family: entry.family, files }))
      }
    } catch (err) {
      if (isAbortError(err)) throw err
      warnings.push({
        code: 'font-install-failed',
        message: `${entry.family} could not be installed (${getErrorMessage(err, String(err))}); text using it falls back.`,
        subject: entry.family,
      })
    }
    done += 1
  }
  return installed
}

// ---------------------------------------------------------------------------
// C. Tables
// ---------------------------------------------------------------------------

async function writeTables(
  plan: FragmentInsertPlan,
  media: ResolvedMedia,
  adapter: FragmentInsertAdapter,
  options: CommitFragmentPlanOptions,
): Promise<Map<string, string>> {
  const tableIdMap = new Map<string, string>()
  for (const table of plan.tables) if (table.action === 'reuse') tableIdMap.set(table.fragmentTableId, table.tableId)
  const replacePaths = createPathReplacer(media.urlByPath)
  const total = plan.tables.length
  let done = 0

  try {
    // Created tables first, relation fields to a table not created yet held
    // back, so every relation can point at a real id.
    const deferred: { tableId: string; fields: DataField[]; withRelations: DataField[] }[] = []
    for (const table of plan.tables) {
      if (table.action !== 'create') continue
      options.signal?.throwIfAborted()
      options.onProgress?.({ phase: 'tables', done, total, label: table.slug })
      const ready = table.input.fields.filter((f) => f.type !== 'relation' || tableIdMap.has(f.targetTableId))
      const created = await adapter.createTable({ ...table.input, fields: ready.map((f) => withTableIds(f, tableIdMap)) })
      tableIdMap.set(table.fragmentTableId, created.id)
      if (ready.length !== table.input.fields.length) {
        deferred.push({ tableId: created.id, fields: ready, withRelations: table.input.fields })
      }
      for (const row of table.rows) {
        options.signal?.throwIfAborted()
        await adapter.createRow(created.id, {
          status: row.status,
          cells: rewriteCells(table.input.fields, row.cells, media.idById, replacePaths),
        })
      }
      done += 1
    }
    for (const item of deferred) {
      await adapter.updateTableFields(item.tableId, item.withRelations.map((f) => withTableIds(f, tableIdMap)))
    }
    for (const table of plan.tables) {
      if (table.action !== 'reuse' || table.addFields.length === 0) continue
      options.signal?.throwIfAborted()
      options.onProgress?.({ phase: 'tables', done, total, label: table.slug })
      await adapter.updateTableFields(table.tableId, [
        ...table.existingFields,
        ...table.addFields.map((f) => withTableIds(f, tableIdMap)),
      ])
      done += 1
    }
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new FragmentCommitError('tables', `Could not write the fragment's tables: ${getErrorMessage(err, String(err))}`, { cause: err })
  }
  return tableIdMap
}

function withTableIds(field: DataField, tableIdMap: Map<string, string>): DataField {
  if (field.type !== 'relation') return field
  return { ...field, targetTableId: tableIdMap.get(field.targetTableId) ?? field.targetTableId }
}

/** Media cells → new media ids; inline media paths in text → new URLs. */
function rewriteCells(
  fields: DataField[],
  cells: Record<string, unknown>,
  mediaIdById: Map<string, string>,
  replacePaths: (text: string) => string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(cells)) {
    const field = fields.find((f) => f.id === key)
    if (field && (field.type === 'media' || field.type === 'repeater')) {
      out[key] = remapMediaIds(field, value, mediaIdById)
    } else {
      out[key] = mapStrings(value, replacePaths)
    }
  }
  return out
}

function remapMediaIds(field: DataField, value: unknown, mediaIdById: Map<string, string>): unknown {
  if (field.type === 'media') {
    if (typeof value === 'string') return mediaIdById.get(value) ?? null
    if (Array.isArray(value)) return value.flatMap((id) => (typeof id === 'string' && mediaIdById.has(id) ? [mediaIdById.get(id)!] : []))
    return value
  }
  if (field.type === 'repeater' && Array.isArray(value)) {
    return value.map((item) => {
      if (!item || typeof item !== 'object' || !('cells' in item)) return item
      const cells = (item as { cells: unknown }).cells
      if (!cells || typeof cells !== 'object') return item
      const next: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(cells as Record<string, unknown>)) {
        const innerField = field.fields.find((f) => f.id === key)
        next[key] = innerField ? remapMediaIds(innerField, inner, mediaIdById) : inner
      }
      return { ...(item as object), cells: next }
    })
  }
  return value
}
