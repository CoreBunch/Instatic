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
 * Paths are normalised + made unique within `site.files`; an unsafe source
 * path falls back to a sanitised name under `src/scripts/` / `src/styles/`.
 */

import { nanoid } from 'nanoid'
import type { Draft } from 'mutative'
import type { SiteDocument } from '@core/page-tree'
import type { ImportScript, ImportStylesheet } from '@core/siteImport'
import type { SiteFile } from '@core/files/schemas'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import {
  DEFAULT_SCRIPT_RUNTIME_CONFIG,
  DEFAULT_STYLE_RUNTIME_CONFIG,
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

  return commitFiles(site, scripts, 'script', 'src/scripts/', 'script.js', (script, id, pageIds) => {
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

  return commitFiles(site, stylesheets, 'style', 'src/styles/', 'styles.css', (sheet, id, pageIds) => {
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
  type: SiteFile['type'],
  fallbackDir: string,
  fallbackName: string,
  registerRuntime: (item: T, fileId: string, pageIds: string[]) => void,
): { id: string; path: string }[] {
  const usedPaths = new Set(site.files.map((f) => f.path))
  const committed: { id: string; path: string }[] = []

  for (const item of items) {
    const path = uniqueFilePath(safeFilePath(item.path, fallbackDir, fallbackName), usedPaths)
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

/** Normalise a source path into a safe SiteFile path, falling back to the kind's dir. */
function safeFilePath(rawPath: string, fallbackDir: string, fallbackName: string): string {
  const normalized = normalizePath(rawPath)
  if (isSafePath(normalized)) return normalized
  const base = (rawPath.split('/').pop() ?? fallbackName).replace(/[^a-zA-Z0-9._-]+/g, '-')
  return `${fallbackDir}${base || fallbackName}`
}

/** Append `-2`, `-3`, … before the extension until the path is unused. */
function uniqueFilePath(path: string, used: Set<string>): string {
  if (!used.has(path)) return path
  const dot = path.lastIndexOf('.')
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : ''
  let n = 2
  while (used.has(`${stem}-${n}${ext}`)) n += 1
  return `${stem}-${n}${ext}`
}
