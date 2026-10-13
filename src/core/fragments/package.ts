/**
 * Fragment packages — the file a fragment travels in.
 *
 * A package is a zip holding `fragment.json` plus every media file under the
 * path its `media[].src` names (`media/<sha256>.<ext>` as written by
 * `extractFragment`). Media entries are stored uncompressed: images, video and
 * fonts are already compressed, and storing keeps packing cheap.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { FragmentParseError, parseSiteFragment, type FragmentMedia, type SiteFragment } from './schema'

export const FRAGMENT_PACKAGE_MANIFEST = 'fragment.json'

export interface FragmentPackage {
  fragment: SiteFragment
  /** Bytes of one media item, or null when its `src` is not inside the package. */
  readMedia(media: FragmentMedia): Uint8Array | null
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
  const entries: Zippable = {
    [FRAGMENT_PACKAGE_MANIFEST]: [strToU8(JSON.stringify(fragment)), { level: 6 }],
  }
  for (const media of fragment.media) {
    if (!isPackagePath(media.src)) continue
    const bytes = mediaBytes.get(media.id)
    if (!bytes) {
      throw new FragmentParseError(`media.${media.id}`, `no bytes for ${media.filename} (${media.src})`)
    }
    entries[media.src] = [bytes, { level: 0 }]
  }
  return zipSync(entries)
}

/** Unzip and validate a package. Throws `FragmentParseError` when it is not one. */
export function readFragmentPackage(bytes: Uint8Array): FragmentPackage {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (err) {
    throw new FragmentParseError('package', `not a zip archive (${err instanceof Error ? err.message : String(err)})`)
  }
  const manifest = entries[FRAGMENT_PACKAGE_MANIFEST]
  if (!manifest) throw new FragmentParseError('package', `${FRAGMENT_PACKAGE_MANIFEST} is missing`)

  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(manifest))
  } catch {
    throw new FragmentParseError(FRAGMENT_PACKAGE_MANIFEST, 'not valid JSON')
  }
  const fragment = parseSiteFragment(raw)
  fragment.media.forEach((media, index) => {
    if (isPackagePath(media.src) && !entries[media.src]) {
      throw new FragmentParseError(`media.${index}.src`, `${media.src} is not in the package`)
    }
  })
  return {
    fragment,
    readMedia: (media) => (isPackagePath(media.src) ? entries[media.src] ?? null : null),
  }
}
