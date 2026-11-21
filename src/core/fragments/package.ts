/**
 * Fragment and theme packages — the files fragments and themes travel in.
 *
 * A package is a zip holding its manifest (`fragment.json` or `theme.json`)
 * plus every media file under the path its `media[].src` names
 * (`media/<sha256>.<ext>` as written by `extractFragment` / `extractTheme`).
 * Media entries are stored uncompressed: images, video and fonts are already
 * compressed, and storing keeps packing cheap.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { FragmentParseError, parseSiteFragment, type FragmentMedia, type SiteFragment } from './schema'
import { parseSiteTheme, type SiteTheme } from './themeSchema'

export const FRAGMENT_PACKAGE_MANIFEST = 'fragment.json'
export const THEME_PACKAGE_MANIFEST = 'theme.json'

/** Reads the bytes of one media item, or null when its `src` is not inside the package. */
type PackageMediaReader = (media: FragmentMedia) => Uint8Array | null

export interface FragmentPackage {
  fragment: SiteFragment
  readMedia: PackageMediaReader
}

export interface ThemePackage {
  theme: SiteTheme
  readMedia: PackageMediaReader
}

/** A `src` that names a file inside the package (not a URL, no traversal). */
function isPackagePath(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/') && !src.split('/').includes('..')
}

/**
 * Zip a fragment with its media. `mediaBytes` is keyed by fragment media id
 * (what `extractFragment` returns). Every media item whose `src` is a package
 * path must have bytes.
 */
export function writeFragmentPackage(
  fragment: SiteFragment,
  mediaBytes: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  return writePackage(FRAGMENT_PACKAGE_MANIFEST, fragment, fragment.media, mediaBytes)
}

/** Unzip and validate a fragment package. Throws `FragmentParseError` when it is not one. */
export function readFragmentPackage(bytes: Uint8Array): FragmentPackage {
  const { value, readMedia } = readPackage(bytes, FRAGMENT_PACKAGE_MANIFEST, parseSiteFragment)
  return { fragment: value, readMedia }
}

/** Zip a theme with its media (`extractTheme`'s `mediaBytes`, keyed by media id). */
export function writeThemePackage(theme: SiteTheme, mediaBytes: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return writePackage(THEME_PACKAGE_MANIFEST, theme, theme.media, mediaBytes)
}

/** Unzip and validate a theme package. Throws `FragmentParseError` when it is not one. */
export function readThemePackage(bytes: Uint8Array): ThemePackage {
  const { value, readMedia } = readPackage(bytes, THEME_PACKAGE_MANIFEST, parseSiteTheme)
  return { theme: value, readMedia }
}

function writePackage(
  manifestName: string,
  manifest: unknown,
  media: readonly FragmentMedia[],
  mediaBytes: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const entries: Zippable = {
    [manifestName]: [strToU8(JSON.stringify(manifest)), { level: 6 }],
  }
  for (const item of media) {
    if (!isPackagePath(item.src)) continue
    const bytes = mediaBytes.get(item.id)
    if (!bytes) {
      throw new FragmentParseError(`media.${item.id}`, `no bytes for ${item.filename} (${item.src})`)
    }
    entries[item.src] = [bytes, { level: 0 }]
  }
  return zipSync(entries)
}

function readPackage<T extends { media: FragmentMedia[] }>(
  bytes: Uint8Array,
  manifestName: string,
  parse: (raw: unknown) => T,
): { value: T; readMedia: PackageMediaReader } {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (err) {
    throw new FragmentParseError('package', `not a zip archive (${err instanceof Error ? err.message : String(err)})`)
  }
  const manifest = entries[manifestName]
  if (!manifest) throw new FragmentParseError('package', `${manifestName} is missing`)

  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(manifest))
  } catch {
    throw new FragmentParseError(manifestName, 'not valid JSON')
  }
  const value = parse(raw)
  value.media.forEach((media, index) => {
    if (isPackagePath(media.src) && !entries[media.src]) {
      throw new FragmentParseError(`media.${index}.src`, `${media.src} is not in the package`)
    }
  })
  return {
    value,
    readMedia: (media) => (isPackagePath(media.src) ? entries[media.src] ?? null : null),
  }
}
