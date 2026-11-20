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

export function addImportedScriptDependencies(
  site: Draft<SiteDocument>,
  scripts: ImportScript[],
): boolean {
  let changed = false
  site.packageJson.dependencies ??= {}
  site.packageJson.devDependencies ??= {}

  for (const script of scripts) {
    for (const dependency of script.dependencies ?? []) {
      if (!isSafePackageName(dependency.name)) continue
      const version = dependency.version.trim() || '*'
      if (site.packageJson.dependencies[dependency.name]) continue

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
    site.files.push({ id, path, type, content: item.content, createdAt: now, updatedAt: now })

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
 * Keep files an import delivers again (see `SiteImportTransaction.reuseSiteFiles`):
 * optionally replace the content, then let the importing pages into the
 * file's runtime scope, on the persisted runtime and the live canvas mirror.
 */
export function reuseImportedFiles(
  site: Draft<SiteDocument>,
  siteRuntime: Draft<SiteRuntimeConfig> | undefined,
  items: { existingFileId: string; pageIds: string[]; content?: string }[],
): { id: string; path: string }[] {
  const reused: { id: string; path: string }[] = []
  for (const item of items) {
    const file = site.files.find((f) => f.id === item.existingFileId)
    if (!file) continue
    if (item.content !== undefined && item.content !== file.content) {
      file.content = item.content
      file.updatedAt = Date.now()
    }
    for (const runtime of [site.runtime, siteRuntime]) {
      const entry = runtime?.scripts?.[file.id] ?? runtime?.styles?.[file.id]
      if (entry) entry.scope = widenScope(entry.scope, item.pageIds)
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
