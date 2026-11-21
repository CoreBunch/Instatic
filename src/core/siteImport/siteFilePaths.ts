/**
 * Where an imported script or kept stylesheet lands in `site.files`, and the
 * record an import leaves on it.
 *
 * Shared by conflict detection (which asks "is this path already taken, and
 * what changed since the last import?") and the store commit (which writes
 * the file and its record), so the two can never disagree.
 */

import { isSafePath, normalizePath } from '@core/files/pathValidation'
import type { SiteScriptFormat, SiteScriptPlacement } from '@core/site-runtime'
import type { SiteFile } from '@core/files/schemas'
import { sha256Hex } from '@core/utils/sha256'

/**
 * Hash of a script or kept stylesheet as the bundle delivered it. A module
 * script's CDN imports are already rewritten to bare package names in its
 * text, so the versions it asked for are hashed alongside: a bundle that only
 * bumps `dayjs@1.11.10` to `@1.11.13` still reads as changed.
 */
export function importSourceHash(item: {
  content: string
  format?: SiteScriptFormat
  placement?: SiteScriptPlacement
  dependencies?: { name: string; version: string }[]
}): string {
  const deps = (item.dependencies ?? []).map((d) => `${d.name}@${d.version}`).toSorted()
  if (item.format && (item.format !== 'classic' || item.placement === 'head')) {
    return sha256Hex(JSON.stringify([item.content, deps, item.format, item.placement]))
  }
  return sha256Hex(deps.length > 0 ? `${item.content}\n${deps.join('\n')}` : item.content)
}

/**
 * The `importRecord` an import writes on a site file: the hash of the text as
 * the bundle had it (`sourceHash`, taken before asset URLs were rewritten)
 * and of the content actually written.
 */
export function siteFileImportRecord(sourcePath: string, sourceHash: string, writtenContent: string): NonNullable<SiteFile['importRecord']> {
  return { sourcePath, sourceHash, contentHash: sha256Hex(writtenContent) }
}

const FALLBACK = {
  script: { dir: 'src/scripts/', name: 'script.js' },
  style: { dir: 'src/styles/', name: 'styles.css' },
} as const

/**
 * Normalise an import path into a safe `SiteFile` path. An unsafe source path
 * falls back to a sanitised file name under the kind's directory.
 */
export function importedSiteFilePath(rawPath: string, kind: 'script' | 'style'): string {
  const normalized = normalizePath(rawPath)
  if (isSafePath(normalized)) return normalized
  const fallback = FALLBACK[kind]
  const base = (rawPath.split('/').pop() ?? fallback.name).replace(/[^a-zA-Z0-9._-]+/g, '-')
  return `${fallback.dir}${base || fallback.name}`
}

/** Append `-2`, `-3`, … before the extension until the path is unused. */
export function uniqueSiteFilePath(path: string, used: ReadonlySet<string>): string {
  if (!used.has(path)) return path
  const dot = path.lastIndexOf('.')
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : ''
  let n = 2
  while (used.has(`${stem}-${n}${ext}`)) n += 1
  return `${stem}-${n}${ext}`
}
