/** Native binary SiteFiles, compiled once and emitted with the page generation. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Type, type Static } from '@sinclair/typebox'
import type { SiteFile } from '@core/files/schemas'
import {
  assertPublicAssetFile,
  parseSiteFileBlob,
  publicAssetRequestPath,
  publicAssetUrl,
  PublicAssetValidationError,
} from '@core/files/publicAssets'
import { safeParseJson } from '@core/utils/jsonValidate'
import { sanitizeSvgBytes } from '../handlers/cms/svgSanitize'
import { binaryResponse } from '../binary'
import { readActivePublishSlot, writeStaticAsset } from './staticArtefact'

const PublicAssetMetadataSchema = Type.Object({
  fileId: Type.String(),
  mimeType: Type.String(),
  byteLength: Type.Integer({ minimum: 0 }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
})
type PublicAssetMetadata = Static<typeof PublicAssetMetadataSchema>
const PublicAssetIndexSchema = Type.Record(Type.String(), PublicAssetMetadataSchema)
const INDEX_PATH = '/_instatic/public-assets.json'

export interface CompiledPublicSiteAsset extends PublicAssetMetadata {
  publicPath: string
  bytes: Uint8Array
}

function byteHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Match filesystem-equivalent names without changing the authored URL. */
function portablePathIdentity(publicPath: string): string {
  return decodeURIComponent(publicPath).normalize('NFC').toLowerCase()
}

/** Incremental row publication must respect the same public URL ownership. */
export function assertPublicAssetRouteAvailable(files: readonly SiteFile[], routePath: string): void {
  const route = portablePathIdentity(routePath)
  for (const file of files) {
    if (file.type !== 'asset') continue
    const path = portablePathIdentity(publicAssetUrl(file.path))
    if (route === path || route.startsWith(`${path}/`)) {
      throw new PublicAssetValidationError(file.path, `The public asset conflicts with route "${routePath}".`)
    }
  }
}

/** Validate all assets before the publish transaction; incomplete assets fail explicitly. */
export function compilePublicSiteAssets(
  files: readonly SiteFile[],
  pagePaths: readonly string[] = [],
): CompiledPublicSiteAsset[] {
  const assets: CompiledPublicSiteAsset[] = []
  const paths = new Set<string>()
  const ids = new Set<string>()
  const routes = new Set(pagePaths.map(portablePathIdentity))
  for (const file of files) {
    if (file.type !== 'asset') continue
    if (ids.has(file.id)) throw new PublicAssetValidationError(file.path, 'Public asset IDs must be unique.')
    ids.add(file.id)
    assertPublicAssetFile(file)
    const publicPath = publicAssetUrl(file.path)
    const foldedPath = portablePathIdentity(publicPath)
    if (paths.has(foldedPath) || routes.has(foldedPath)
      || [...routes].some((route) => route.startsWith(`${foldedPath}/`))) {
      throw new PublicAssetValidationError(file.path, 'The public asset URL collides with another asset or page.')
    }
    paths.add(foldedPath)
    const blob = parseSiteFileBlob(file.blob, file.path)
    let bytes: Uint8Array = new Uint8Array(Buffer.from(blob.base64, 'base64'))
    if (blob.mimeType.split(';', 1)[0] === 'image/svg+xml') {
      bytes = sanitizeSvgBytes(bytes)
      if (bytes.byteLength === 0) throw new PublicAssetValidationError(file.path, 'The SVG payload contains no valid image.')
    }
    assets.push({
      fileId: file.id,
      publicPath,
      mimeType: blob.mimeType,
      byteLength: bytes.byteLength,
      sha256: byteHash(bytes),
      bytes,
    })
  }
  for (const path of paths) {
    const segments = path.split('/')
    for (let index = 2; index < segments.length; index++) {
      if (paths.has(segments.slice(0, index).join('/'))) {
        throw new PublicAssetValidationError(path, 'A public asset cannot also be another asset’s directory.')
      }
    }
  }
  return assets
}

/** Bytes and their MIME/hash index are staged in the same inactive slot. */
export async function writePublicSiteAssets(slotDir: string, assets: readonly CompiledPublicSiteAsset[]): Promise<void> {
  const index: Record<string, PublicAssetMetadata> = {}
  for (const asset of assets) {
    await writeStaticAsset(slotDir, asset.publicPath, asset.bytes)
    index[asset.publicPath] = {
      fileId: asset.fileId,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
    }
  }
  await writeStaticAsset(slotDir, INDEX_PATH, new TextEncoder().encode(JSON.stringify(index)))
}

/** Never reads arbitrary slot files: only declared asset URLs from the native index. */
export async function readPublicSiteAsset(
  uploadsDir: string,
  pathname: string,
): Promise<CompiledPublicSiteAsset | null> {
  const publicPath = publicAssetRequestPath(pathname)
  if (!publicPath) return null
  return readActivePublishSlot(uploadsDir, async (slotDir) => {
    const parsed = safeParseJson(await readFile(join(slotDir, INDEX_PATH.slice(1)), 'utf-8'), PublicAssetIndexSchema)
    if (!parsed.ok) throw new Error('The published public-asset index is invalid', { cause: parsed.error })
    const metadata = parsed.value[publicPath]
    if (!metadata) return null
    parseSiteFileBlob({ mimeType: metadata.mimeType, base64: '' }, `${publicPath}.mimeType`)
    // Both reads use this exact slot. A following publish may recycle it;
    // verify byte identity and retry the current pointer if that happened.
    const bytes = new Uint8Array(await readFile(join(slotDir, decodeURIComponent(publicPath.slice(1)))))
    if (metadata.byteLength !== bytes.byteLength || metadata.sha256 !== byteHash(bytes)) {
      const error: NodeJS.ErrnoException = new Error('The public asset generation changed while reading')
      error.code = 'ESTALE'
      throw error
    }
    return { publicPath, ...metadata, bytes }
  })
}

/** Stable author-chosen URLs revalidate; preview bytes never enter visitor caches. */
export function publicSiteAssetResponse(
  req: Request,
  asset: CompiledPublicSiteAsset,
  preview = false,
): Response {
  const etag = `"${asset.sha256}"`
  const headers = new Headers({
    'content-type': asset.mimeType,
    'content-length': String(asset.byteLength),
    'cache-control': preview ? 'private, no-store' : 'no-cache',
    'etag': etag,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'vary': 'cookie',
  })
  if (preview) {
    headers.set('x-robots-tag', 'noindex')
  }
  // Unknown document formats download; passive images/media/fonts and data
  // retain their declared MIME for normal resource consumers.
  const baseMime = asset.mimeType.split(';', 1)[0]
  if (!/^(?:image|audio|video|font)\//.test(baseMime)
    && baseMime !== 'text/plain' && !/^application\/(?:[a-z0-9.+-]*\+)?json$/.test(baseMime)) {
    headers.set('content-disposition', 'attachment')
  }
  const matches = (req.headers.get('if-none-match') ?? '').split(',')
    .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
  if (matches && !preview) {
    headers.delete('content-length')
    return new Response(null, { status: 304, headers })
  }
  return req.method === 'HEAD'
    ? new Response(null, { headers })
    : binaryResponse(asset.bytes, { headers })
}
