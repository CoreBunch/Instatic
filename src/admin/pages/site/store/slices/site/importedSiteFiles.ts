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
  siteFileImportRecord,
  uniqueSiteFilePath,
  type ImportScript,
  type ImportStylesheet,
} from '@core/siteImport'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import {
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  DEFAULT_STYLE_RUNTIME_CONFIG,
  type SiteAssetScope,
  type SiteRuntimeConfig,
} from '@core/site-runtime'

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
      format: script.format,
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
 * Add the npm packages imported scripts load from a CDN to package.json. A
 * package already listed keeps its version, unless `takeImportedVersions`
 * (a replaced script now asks for another version). Packages no script uses
 * any more are never removed; the Dependencies panel does that.
 */
export function addImportedScriptDependencies(
  site: Draft<SiteDocument>,
  scripts: ImportScript[],
  { takeImportedVersions = false }: { takeImportedVersions?: boolean } = {},
): boolean {
  let changed = false
  site.packageJson.dependencies ??= {}
  site.packageJson.devDependencies ??= {}

  for (const script of scripts) {
    for (const dependency of script.dependencies ?? []) {
      if (!isSafePackageName(dependency.name)) continue
      const version = dependency.version.trim() || '*'
      const listed = site.packageJson.dependencies[dependency.name]
      if (listed && (!takeImportedVersions || listed === version)) continue

      site.packageJson.dependencies[dependency.name] = version
      if (site.packageJson.devDependencies[dependency.name]) {
        delete site.packageJson.devDependencies[dependency.name]
      }
      changed = true
    }
  }

  return changed
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
      ...(item.sourceHash ? { importRecord: siteFileImportRecord(item.sourceHash, item.content) } : {}),
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
 * (`addImportedScriptDependencies`), as on the add path.
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
      if (replacement.sourceHash) file.importRecord = siteFileImportRecord(replacement.sourceHash, replacement.content)
    }
    for (const runtime of [site.runtime, siteRuntime]) {
      const script = runtime?.scripts?.[file.id]
      const style = runtime?.styles?.[file.id]
      const entry = script ?? style
      if (!entry) continue
      entry.scope = widenScope(entry.scope, item.pageIds)
      // The load order stays the site's: an import's priorities only rank the
      // files of that import, not this file against the rest of the site.
      if (script && replacement && 'format' in replacement) script.format = replacement.format
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
