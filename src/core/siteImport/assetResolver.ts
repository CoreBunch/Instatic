/**
 * assetResolver — the one place an imported URL becomes a FileMap key.
 *
 * Every normaliser in `assetPlan.ts` (node props, CSS bags, raw CSS text,
 * `@font-face`) and the head-settings normaliser in `headSeo.ts` funnel into
 * `resolveAndRecord`, which resolves the URL against the referencing file,
 * finds the archive entry (exactly, or by the punctuation-insensitive
 * fallback), and plans uploadable files for upload.
 */

import { dirname, joinPaths } from './paths'
import type { FileMap, ImportAsset } from './types'
import type { ImportWarning } from './warnings'
import { guessMimeType, isImportUploadableMimeType } from './mimeTypes'

/**
 * Everything URL normalisation needs, gathered once per import.
 *
 * The normalisers in `assetPlan.ts` (node props, CSS bags, raw CSS text, `@font-face`) and `headSeo.ts`
 * all funnel into `resolveAndRecord`, and all of them need the same four
 * things — so they take the resolver rather than passing the pieces around
 * individually. The lookup indexes live here for the same reason: they are
 * per import, not per call.
 */
export interface AssetResolver {
  fileMap: FileMap
  /** Deduplicated assets to upload, keyed by FileMap key. */
  assetMap: Map<string, ImportAsset>
  warnings: ImportWarning[]
  /** Lazily built by `normalizedIndex` — see the note there. */
  byNormalizedPath?: ReadonlyMap<string, string | null>
  /** Lazily built by `suffixIndex` — see the note there. */
  bySuffixPath?: ReadonlyMap<string, string | null>
  /** One `unresolved-asset` warning per path, however many pages reference it. */
  reportedMissing: Set<string>
}

/** URLs that should always pass through unchanged (external + special schemes). */
export const EXTERNAL_URL_RE = /^https?:\/\/|^\/\/|^data:|^mailto:|^tel:|^#/


/**
 * MIME type prefixes that identify web document / script sources.
 *
 * Files with these types are processed by the pipeline as pages or style
 * sources, not uploaded to the media library.  An `<a href="about.html">`
 * anchor should never cause `about.html` to appear in `plan.assets`, even
 * if the file exists in the FileMap.
 */
export const NON_ASSET_MIME_PREFIXES: readonly string[] = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
]

/**
 * Resolve a raw URL relative to `basePath`, look it up in the FileMap,
 * register the asset in `assetMap`, and return the FileMap key.
 *
 * Returns null when:
 *   - the URL is external / uses a special scheme,
 *   - the resolved path is not in the FileMap (a media reference that lands
 *     here also emits an `unresolved-asset` warning), or
 *   - the resolved file is a web document / script (HTML, CSS, JS), or any
 *     other MIME the CMS media endpoint cannot store.
 */
export function resolveAndRecord(rawUrl: string, basePath: string, resolver: AssetResolver): string | null {
  if (!rawUrl || EXTERNAL_URL_RE.test(rawUrl)) return null

  const resolvedPath = resolveRelativePath(rawUrl, basePath)
  if (!resolvedPath) return null

  const fileMapKey = resolveFileMapKey(resolvedPath, resolver)
  if (!fileMapKey) return null

  const entry = resolver.fileMap.files[fileMapKey]
  if (!entry) return null

  const { assetMap } = resolver
  const mimeType = entry.mimeType ?? guessMimeType(fileMapKey)

  // HTML, CSS, and JS files are page/style sources — never upload them as
  // media assets.  An anchor <a href="other-page.html"> must not cause
  // "other-page.html" to appear in plan.assets. Likewise, source companions
  // such as SCSS, sourcemaps, PHP mail handlers, and OS metadata are not
  // public media assets and would be rejected by the media endpoint.
  if (NON_ASSET_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) {
    return null
  }
  if (!isImportUploadableMimeType(mimeType)) return null

  if (!assetMap.has(fileMapKey)) {
    assetMap.set(fileMapKey, { sourcePath: fileMapKey, mimeType, bytes: entry.bytes })
  }

  return fileMapKey
}

/**
 * Turn a resolved archive path into the FileMap key that actually holds the
 * bytes, and report the ones that hold nothing.
 *
 * Exporters do not always agree with themselves about filenames or archive
 * roots. Punctuation-insensitive matching rejoins filename variants, while a
 * unique path suffix finds files stored below an extra archive directory.
 *
 * A fallback match must be UNIQUE. Picking between equivalent candidates would
 * silently put the wrong image on the page. Ambiguity and genuine absence both
 * fall through to the same warning.
 */
function resolveFileMapKey(resolvedPath: string, resolver: AssetResolver): string | null {
  if (resolver.fileMap.files[resolvedPath]) return resolvedPath

  const match = normalizedIndex(resolver).get(normalizeAssetPath(resolvedPath))
  if (match) return match

  const suffixMatch = suffixIndex(resolver).get(resolvedPath)
  if (suffixMatch) return suffixMatch

  // Only media references are worth reporting. Anchors point at pages and
  // extensionless routes that legitimately live outside the archive, and a
  // wall of warnings about those would bury the images that really are gone.
  if (isImportUploadableMimeType(guessMimeType(resolvedPath)) && !resolver.reportedMissing.has(resolvedPath)) {
    resolver.reportedMissing.add(resolvedPath)
    resolver.warnings.push({
      kind: 'unresolved-asset',
      message: `"${resolvedPath}" is referenced but not in the archive — the element imports with a broken link. Re-export the site, or upload the file and repoint it.`,
      path: resolvedPath,
    })
  }
  return null
}

/**
 * Index of every FileMap key by its punctuation-insensitive form. Keys that
 * collide map to `null` — an ambiguous match is no match.
 *
 * Built on the first miss: an archive whose references all resolve exactly
 * never pays for it.
 */
function normalizedIndex(resolver: AssetResolver): ReadonlyMap<string, string | null> {
  if (resolver.byNormalizedPath) return resolver.byNormalizedPath

  const index = new Map<string, string | null>()
  for (const filePath of Object.keys(resolver.fileMap.files)) {
    const key = normalizeAssetPath(filePath)
    index.set(key, index.has(key) ? null : filePath)
  }
  resolver.byNormalizedPath = index
  return index
}

/**
 * Index FileMap keys by path-segment suffix. Shared suffixes map to `null`, and
 * lazy construction avoids a full FileMap scan for every lookup.
 */
function suffixIndex(resolver: AssetResolver): ReadonlyMap<string, string | null> {
  if (resolver.bySuffixPath) return resolver.bySuffixPath

  const index = new Map<string, string | null>()
  for (const filePath of Object.keys(resolver.fileMap.files)) {
    let separatorIndex = filePath.indexOf('/')
    while (separatorIndex !== -1) {
      const suffix = filePath.slice(separatorIndex + 1)
      index.set(suffix, index.has(suffix) ? null : filePath)
      separatorIndex = filePath.indexOf('/', separatorIndex + 1)
    }
  }
  resolver.bySuffixPath = index
  return index
}

/**
 * Strip a path down to what survives an exporter's filename sanitising:
 * lowercase, with everything but letters, digits, `.` and `/` removed. That
 * folds `&`, `+`, spaces, and `-` together, which is exactly the set that
 * differs between a stored filename and the reference written to it.
 */
function normalizeAssetPath(path: string): string {
  return path.toLowerCase().replace(/[^a-z0-9./]+/g, '')
}

/**
 * Resolve a raw URL against a base file path to produce a FileMap key.
 * Returns null for traversal-escaping paths or empty strings.
 *
 * As in `resolveHref`, a query string or fragment is stripped before the
 * lookup — it addresses a file, it does not identify one. Callers keep the
 * original `rawUrl` for the in-place CSS string replacement
 * (`replaceRawUrlInValue`), so stripping here affects only which FileMap entry
 * is found.
 */
export function resolveRelativePath(rawUrl: string, basePath: string): string | null {
  const baseDir = dirname(basePath)

  const pathOnly = rawUrl.split(/[?#]/)[0]
  if (!pathOnly) return null

  const resolved = pathOnly.startsWith('/')
    ? pathOnly.slice(1) // root-relative: strip leading /
    : joinPaths(baseDir, pathOnly)

  // Reject escaped or empty results
  if (!resolved || resolved.startsWith('../')) return null

  return resolved
}
