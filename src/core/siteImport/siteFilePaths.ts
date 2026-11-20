/**
 * Where an imported script or kept stylesheet lands in `site.files`.
 *
 * One mapping shared by conflict detection (which asks "is this path already
 * taken?") and the store commit (which writes the file), so the two can never
 * disagree about the path a file arrives at.
 */

import { isSafePath, normalizePath } from '@core/files/pathValidation'

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
