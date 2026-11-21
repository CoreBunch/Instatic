/**
 * Media an import would upload that the library already holds.
 *
 * Re-importing a bundle used to upload every image and font again (`-2`
 * copies). The wizard now hashes each planned asset (`hashImportAssets`), asks
 * the server which hashes the library already has, and turns the matches into
 * `MediaConflict`s (`detectMediaConflicts`) that default to reusing the
 * existing asset. `buildImportPlan` stays pure and synchronous; this is the one
 * plan step that needs the server, so it runs after it.
 */

import { sha256HexBytes } from '@core/utils/sha256'
import type { ImportAsset, ImportPlan } from './types'
import type { MediaConflict } from './conflictTypes'

/** An existing library asset whose bytes match a planned import asset. */
export interface ExistingMediaMatch {
  contentHash: string
  id: string
  publicPath: string
  filename: string
}

/**
 * SHA-256 (lowercase hex) of a file's bytes: the same digest the server stores
 * as `media_assets.content_hash` for the bytes it received. Uses WebCrypto when
 * the page is a secure context and the dependency-free implementation
 * otherwise (the admin is often reached over plain `http://` on a LAN, where
 * `crypto.subtle` is undefined).
 */
export async function hashAssetBytes(bytes: Uint8Array): Promise<string> {
  const cached = hashByBytes.get(bytes)
  if (cached) return cached
  const subtle = globalThis.crypto?.subtle
  let hex = ''
  if (subtle) {
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes.slice()))
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  } else {
    hex = sha256HexBytes(bytes)
  }
  hashByBytes.set(bytes, hex)
  return hex
}

/**
 * The wizard rebuilds the plan on every stylesheet-mode flip and every added
 * file; the FileMap's byte arrays survive those rebuilds, so their hashes are
 * computed once.
 */
const hashByBytes = new WeakMap<Uint8Array, string>()

/** `sourcePath → content hash` for every planned asset. */
export async function hashImportAssets(assets: ImportAsset[]): Promise<Map<string, string>> {
  const hashBySource = new Map<string, string>()
  for (const asset of assets) hashBySource.set(asset.sourcePath, await hashAssetBytes(asset.bytes))
  return hashBySource
}

/**
 * Record every planned asset whose bytes the library already holds as a
 * `MediaConflict` on the plan, defaulting to reuse (`skip` the upload).
 */
export function detectMediaConflicts(
  plan: ImportPlan,
  hashBySource: ReadonlyMap<string, string>,
  matches: ExistingMediaMatch[],
): ImportPlan {
  const matchByHash = new Map<string, ExistingMediaMatch>()
  for (const match of matches) {
    if (!matchByHash.has(match.contentHash)) matchByHash.set(match.contentHash, match)
  }
  const media: MediaConflict[] = []
  for (const asset of plan.assets) {
    const hash = hashBySource.get(asset.sourcePath)
    const match = hash ? matchByHash.get(hash) : undefined
    if (!match) continue
    media.push({
      sourcePath: asset.sourcePath,
      existingAssetId: match.id,
      existingUrl: match.publicPath,
      existingFilename: match.filename,
      defaultResolution: { action: 'skip' },
    })
  }
  return { ...plan, conflicts: { ...plan.conflicts, media } }
}
