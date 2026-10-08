/** Private binary preview capabilities. Nothing here writes a published slot. */
import { randomBytes } from 'node:crypto'
import type { SiteFile } from '@core/files/schemas'
import type { PublicFileReferences } from '@core/files/references'
import { PublicAssetValidationError } from '@core/files/publicAssets'
import { compilePublicSiteAssets, type CompiledPublicSiteAsset } from './publicSiteAssets'

export const PUBLIC_FILE_PREVIEW_PREFIX = '/admin/api/cms/runtime/files/'
const MAX_BUILDS = 32
const MAX_BYTES = 128 * 1024 * 1024
const LIFETIME_MS = 15 * 60 * 1000

interface FilePreviewBuild {
  ownerId: string
  expiresAt: number
  bytes: number
  assets: Map<string, CompiledPublicSiteAsset>
}

const builds = new Map<string, FilePreviewBuild>()

function pruneBuilds(now: number): void {
  for (const [id, build] of builds) if (build.expiresAt <= now) builds.delete(id)
  let bytes = [...builds.values()].reduce((sum, build) => sum + build.bytes, 0)
  while (builds.size > MAX_BUILDS || bytes > MAX_BYTES) {
    const oldest = builds.keys().next().value
    if (oldest === undefined) break
    bytes -= builds.get(oldest)!.bytes
    builds.delete(oldest)
  }
}

/** URLs are owner-scoped, short-lived and served through the normal admin read floor. */
export function registerPublicFilePreview(
  ownerId: string,
  files: readonly SiteFile[],
  now = Date.now(),
): PublicFileReferences {
  const assets = compilePublicSiteAssets(files.filter((file) => file.type === 'asset' && file.blob))
  if (assets.length === 0) return {}
  const bytes = assets.reduce((sum, asset) => sum + asset.byteLength, 0)
  if (bytes > MAX_BYTES) throw new PublicAssetValidationError('files', 'Public file preview exceeds the 128 MB memory limit')
  const buildId = randomBytes(24).toString('base64url')
  const byId = new Map(assets.map((asset) => [asset.fileId, asset]))
  builds.set(buildId, { ownerId, expiresAt: now + LIFETIME_MS, bytes, assets: byId })
  pruneBuilds(now)
  const references: PublicFileReferences = Object.create(null)
  for (const file of files) {
    if (file.type !== 'asset') continue
    const asset = byId.get(file.id)
    if (!asset) continue
    references[file.id] = {
      id: file.id,
      path: file.path,
      url: `${PUBLIC_FILE_PREVIEW_PREFIX}${buildId}/${encodeURIComponent(file.id)}`,
      mimeType: asset.mimeType,
    }
  }
  return references
}

export function readPublicFilePreview(
  ownerId: string,
  pathname: string,
  now = Date.now(),
): CompiledPublicSiteAsset | null {
  if (!pathname.startsWith(PUBLIC_FILE_PREVIEW_PREFIX)) return null
  pruneBuilds(now)
  const segments = pathname.slice(PUBLIC_FILE_PREVIEW_PREFIX.length).split('/')
  if (segments.length !== 2 || !/^[A-Za-z0-9_-]{32}$/.test(segments[0])) return null
  const build = builds.get(segments[0])
  if (!build || build.ownerId !== ownerId) return null
  try {
    return build.assets.get(decodeURIComponent(segments[1])) ?? null
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}

/** Test seam. */
export function resetPublicFilePreviews(): void {
  builds.clear()
}
