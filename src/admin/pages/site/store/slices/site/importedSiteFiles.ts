/**
 * importedSiteFiles — commit imported scripts and kept stylesheets as
 * `SiteFile`s plus page-scoped runtime entries.
 *
 * Both kinds share one shape: a `SiteFile` (`type: 'script' | 'style'`) with
 * a normalised, unique path, and a `site.runtime.{scripts,styles}` entry
 * scoped to exactly the pages whose source HTML linked the file. The runtime
 * entry is mirrored onto the live `siteRuntime` draft (the canvas reads that
 * copy) exactly as `filesSlice.deleteFile` mirrors its delete.
 *
 * Paths come from `importedSiteFilePath` (the same mapping conflict detection
 * uses) and are made unique within `site.files`. A file the import delivers
 * again goes through `reuseImportedFiles` instead, which keeps the existing
 * file and widens its page scope.
 */

import { nanoid } from 'nanoid'
import type { Draft } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import {
  importedSiteFilePath,
  mergeImportOrder,
  prioritiesForOrder,
  siteFileImportRecord,
  uniqueSiteFilePath,
  type ImportScript,
  type ImportStylesheet,
} from '@core/siteImport'
import {
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  DEFAULT_STYLE_RUNTIME_CONFIG,
  type SiteAssetScope,
  type SiteRuntimeConfig,
} from '@core/site-runtime'

function importedScriptRuntime(script: ImportScript) {
  return {
    format: script.format,
    placement: script.placement,
    timing: script.placement === 'head' ? 'immediate' as const : DEFAULT_SCRIPT_RUNTIME_CONFIG.timing,
  }
}

export function addImportedScripts(
  site: Draft<SiteDocument>,
  siteRuntime: Draft<SiteRuntimeConfig> | undefined,
  scripts: ImportScript[],
): { id: string; path: string }[] {
  if (scripts.length === 0) return []
  ensureRuntime(site)
  site.runtime!.scripts ??= {}

  return commitFiles(site, scripts, 'script', (script, id, pageIds) => {
    const config = {
      ...DEFAULT_SCRIPT_RUNTIME_CONFIG,
      ...importedScriptRuntime(script),
      priority: script.priority,
      scope: pageIds.length > 0
        ? { type: 'pages' as const, pageIds }
        : DEFAULT_SCRIPT_RUNTIME_CONFIG.scope,
    }
    site.runtime!.scripts[id] = config
    if (siteRuntime?.scripts) siteRuntime.scripts[id] = { ...config }
  })
}

/**
 * Commit stylesheets kept as files (import `mode: 'file'`): the same shape
 * the Site panel's Styles section manages, so the imported sheet is
 * immediately editable there and in the code editor.
 */
export function addImportedStylesheets(
  site: Draft<SiteDocument>,
  siteRuntime: Draft<SiteRuntimeConfig> | undefined,
  stylesheets: ImportStylesheet[],
): { id: string; path: string }[] {
  if (stylesheets.length === 0) return []
  ensureRuntime(site)
  site.runtime!.styles ??= {}

  return commitFiles(site, stylesheets, 'style', (sheet, id, pageIds) => {
    const config = {
      ...DEFAULT_STYLE_RUNTIME_CONFIG,
      priority: sheet.priority,
      scope: pageIds.length > 0
        ? { type: 'pages' as const, pageIds }
        : DEFAULT_STYLE_RUNTIME_CONFIG.scope,
    }
    site.runtime!.styles[id] = config
    if (siteRuntime?.styles) siteRuntime.styles[id] = { ...config }
  })
}

// ---------------------------------------------------------------------------
// Shared core
// ---------------------------------------------------------------------------

interface ImportedFileItem {
  path: string
  content: string
  pageIds?: string[]
  sourceHash?: string
}

function commitFiles<T extends ImportedFileItem>(
  site: Draft<SiteDocument>,
  items: T[],
  type: 'script' | 'style',
  registerRuntime: (item: T, fileId: string, pageIds: string[]) => void,
): { id: string; path: string }[] {
  const usedPaths = new Set(site.files.map((f) => f.path))
  const committed: { id: string; path: string }[] = []

  for (const item of items) {
    const path = uniqueSiteFilePath(importedSiteFilePath(item.path, type), usedPaths)
    usedPaths.add(path)

    const id = nanoid()
    const now = Date.now()
    site.files.push({
      id,
      path,
      type,
      content: item.content,
      ...(item.sourceHash ? { importRecord: siteFileImportRecord(item.path, item.sourceHash, item.content) } : {}),
      createdAt: now,
      updatedAt: now,
    })

    const pageIds = Array.isArray(item.pageIds)
      ? item.pageIds.filter((pageId): pageId is string => typeof pageId === 'string' && pageId.length > 0)
      : []
    registerRuntime(item, id, pageIds)

    committed.push({ id, path })
  }

  return committed
}

function ensureRuntime(site: Draft<SiteDocument>): void {
  site.runtime ??= { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {}, styles: {} }
}

/**
 * Keep files an import delivers again (see `SiteImportTransaction.reuseSiteFiles`).
 * A replacement swaps in the imported content, a script's format, and the
 * file's `importRecord`; the file keeps its load order. The importing pages
 * join the file's runtime scope. Both the persisted runtime and the live canvas mirror are updated.
 * A replacing script's npm dependencies are the caller's step
 * (`replaceImportedScriptDependencies`).
 */
export function reuseImportedFiles(
  site: Draft<SiteDocument>,
  siteRuntime: Draft<SiteRuntimeConfig> | undefined,
  items: { existingFileId: string; pageIds: string[]; replacement?: ImportScript | ImportStylesheet }[],
): { id: string; path: string }[] {
  const reused: { id: string; path: string }[] = []
  for (const item of items) {
    const file = site.files.find((f) => f.id === item.existingFileId)
    if (!file) continue
    const { replacement } = item
    if (replacement) {
      if (replacement.content !== file.content) {
        file.content = replacement.content
        file.updatedAt = Date.now()
      }
      const record = replacement.sourceHash ? siteFileImportRecord(replacement.path, replacement.sourceHash, replacement.content) : undefined
      // Writing an identical record would still show as a change in branch review.
      if (record && (record.sourcePath !== file.importRecord?.sourcePath || record.sourceHash !== file.importRecord?.sourceHash || record.contentHash !== file.importRecord?.contentHash)) {
        file.importRecord = record
      }
    }
    for (const runtime of [site.runtime, siteRuntime]) {
      const script = runtime?.scripts?.[file.id]
      const style = runtime?.styles?.[file.id]
      const entry = script ?? style
      if (!entry) continue
      entry.scope = widenScope(entry.scope, item.pageIds)
      // The load order stays the site's: an import's priorities only rank the
      // files of that import, not this file against the rest of the site.
      if (script && replacement && 'format' in replacement) Object.assign(script, importedScriptRuntime(replacement))
    }
    reused.push({ id: file.id, path: file.path })
  }
  return reused
}

/**
 * A page-scoped file gains the importing pages; no pages (a site-wide sheet)
 * widens it to every page. Any other scope already covers what it should.
 */
function widenScope(scope: SiteAssetScope, pageIds: string[]): SiteAssetScope {
  if (scope.type !== 'pages') return scope
  if (pageIds.length === 0) return { type: 'all-pages' }
  return { type: 'pages', pageIds: [...new Set([...scope.pageIds, ...pageIds])] }
}

/**
 * Merge an import's files of one kind into the site's load order and write
 * the priorities that order needs (see `SiteImportTransaction.orderImportedFiles`).
 * Today's order is read the way the runtime sorts (priority, then path); the
 * written priorities never tie, so the result does not depend on paths.
 */
export function orderImportedFiles(
  site: Draft<SiteDocument>,
  siteRuntime: Draft<SiteRuntimeConfig> | undefined,
  kind: 'script' | 'style',
  importOrder: string[],
  addedIds: string[],
): boolean {
  ensureRuntime(site)
  const entries = kind === 'script' ? (site.runtime!.scripts ??= {}) : (site.runtime!.styles ??= {})
  const defaults = kind === 'script' ? DEFAULT_SCRIPT_RUNTIME_CONFIG : DEFAULT_STYLE_RUNTIME_CONFIG
  const added = new Set(addedIds)
  const siteFiles = site.files
    .filter((file) => file.type === kind && !added.has(file.id))
    .map((file) => ({ id: file.id, path: file.path, priority: entries[file.id]?.priority ?? defaults.priority }))
    .toSorted((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))
  const sequence = mergeImportOrder(siteFiles.map((file) => file.id), importOrder)
  const priorities = prioritiesForOrder(sequence, new Map(siteFiles.map((file) => [file.id, file.priority])))

  let changed = false
  for (const [id, priority] of priorities) {
    const entry = entries[id]
    if (entry?.priority === priority) continue
    if (!entry && priority === defaults.priority) continue
    entries[id] = { ...(entry ?? defaults), priority }
    const mirror = kind === 'script' ? siteRuntime?.scripts : siteRuntime?.styles
    if (mirror) mirror[id] = { ...entries[id]! }
    changed = true
  }
  return changed
}
