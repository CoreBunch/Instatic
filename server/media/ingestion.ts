/** Host-mediated managed-media ingestion for plugins. */
import { readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaUpsertInput, MediaUpsertResult, UpsertedMediaAsset } from '@core/plugin-sdk'
import { responseErrorMessage } from '@core/http'
import type { DbClient } from '../db/client'
import { sha256Hex } from '../binary'
import {
  getMediaAsset,
  restoreMediaAsset,
  updateMediaAssetMetadata,
  type MediaAsset,
} from '../repositories/media'
import {
  getPluginMediaSource,
  savePluginMediaSource,
} from '../repositories/pluginMediaSources'
import {
  acceptReplacementMedia,
  acceptUploadedMedia,
  IMAGE_MIMES,
  MAX_MEDIA_BYTES,
} from '../handlers/cms/mediaUpload'
import { downloadRemoteMedia, type RemoteMediaDownloadDeps } from './remoteDownload'
import { assertPathWithin } from '../util/pathWithin'

export interface MediaIngestionArgs {
  pluginId: string
  networkAllowedHosts: ReadonlyArray<string>
  pluginAssetRoot: string
  input: MediaUpsertInput
}

const keyTails = new Map<string, Promise<void>>()

async function withSourceKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = keyTails.get(key) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => current)
  keyTails.set(key, tail)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (keyTails.get(key) === tail) keyTails.delete(key)
  }
}

function upsertedAsset(asset: MediaAsset): UpsertedMediaAsset {
  return {
    id: asset.id,
    filename: asset.filename,
    publicPath: asset.publicPath,
    mimeType: asset.mimeType,
    altText: asset.altText,
    width: asset.width,
    height: asset.height,
  }
}

async function responseError(response: Response): Promise<Error> {
  const message = await responseErrorMessage(
    response,
    `Media import was rejected (HTTP ${response.status}).`,
  )
  return new Error(message)
}

async function updateSyncedMetadata(
  db: DbClient,
  asset: MediaAsset,
  input: MediaUpsertInput,
): Promise<MediaAsset> {
  let current = asset.deletedAt ? (await restoreMediaAsset(db, asset.id) ?? asset) : asset
  const updated = await updateMediaAssetMetadata(db, current.id, {
    filename: input.filename,
    ...(input.altText !== undefined ? { altText: input.altText } : {}),
  })
  if (updated) current = updated
  return current
}

async function readPluginAsset(
  rootPath: string,
  relativePath: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const candidatePath = join(rootPath, relativePath)
  assertPathWithin(rootPath, candidatePath)

  // Resolve both sides before reading so a package symlink cannot escape its
  // installed root even when the lexical path itself looks contained.
  const [realRootPath, realAssetPath] = await Promise.all([
    realpath(rootPath),
    realpath(candidatePath),
  ])
  assertPathWithin(realRootPath, realAssetPath)
  const info = await stat(realAssetPath)
  if (!info.isFile()) {
    throw new Error(`Plugin media source "${relativePath}" is not a file.`)
  }
  if (info.size > MAX_MEDIA_BYTES) {
    throw new Error('Plugin media source exceeds the 50 MB limit.')
  }
  const fileBytes = await readFile(realAssetPath)
  if (fileBytes.byteLength === 0) {
    throw new Error(`Plugin media source "${relativePath}" is empty.`)
  }
  if (fileBytes.byteLength > MAX_MEDIA_BYTES) {
    throw new Error('Plugin media source exceeds the 50 MB limit.')
  }
  return new Uint8Array(fileBytes)
}

async function resolveSourceBytes(
  args: MediaIngestionArgs,
  deps: RemoteMediaDownloadDeps,
): Promise<Uint8Array<ArrayBuffer>> {
  if (args.input.source.kind === 'pluginAsset') {
    return readPluginAsset(args.pluginAssetRoot, args.input.source.path)
  }
  return downloadRemoteMedia(args.input.source.url, {
    allowlist: args.networkAllowedHosts,
    maxBytes: MAX_MEDIA_BYTES,
    label: `Plugin "${args.pluginId}" media`,
  }, deps)
}

async function performUpsert(
  db: DbClient,
  args: MediaIngestionArgs,
  deps: RemoteMediaDownloadDeps,
): Promise<MediaUpsertResult> {
  const input = args.input
  const existingSource = await getPluginMediaSource(db, args.pluginId, input.sourceKey)
  const existingAsset = existingSource
    ? await getMediaAsset(db, existingSource.assetId)
    : null

  if (
    existingSource &&
    existingAsset &&
    input.sourceVersion !== undefined &&
    input.sourceVersion === existingSource.sourceVersion
  ) {
    const asset = await updateSyncedMetadata(db, existingAsset, input)
    return { status: 'unchanged', asset: upsertedAsset(asset) }
  }

  const bytes = await resolveSourceBytes(args, deps)
  const contentHash = await sha256Hex(bytes)
  const sourceVersion = input.sourceVersion ?? null

  if (existingSource && existingAsset && contentHash === existingSource.contentHash) {
    await savePluginMediaSource(db, {
      pluginId: args.pluginId,
      sourceKey: input.sourceKey,
      assetId: existingAsset.id,
      sourceVersion,
      contentHash,
    })
    const asset = await updateSyncedMetadata(db, existingAsset, input)
    return { status: 'unchanged', asset: upsertedAsset(asset) }
  }

  const file = new File([bytes], input.filename)
  const accepted = existingAsset
    ? await acceptReplacementMedia(db, existingAsset.id, {
        file,
        maxBytes: MAX_MEDIA_BYTES,
        allowedMimes: IMAGE_MIMES,
        role: 'original',
        uploadedByUserId: null,
        oversizedMessage: 'Media source exceeds the 50 MB limit',
        unsupportedMessage: 'Media source must be a supported image',
      })
    : await acceptUploadedMedia(db, {
        file,
        maxBytes: MAX_MEDIA_BYTES,
        allowedMimes: IMAGE_MIMES,
        role: 'original',
        uploadedByUserId: null,
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        oversizedMessage: 'Media source exceeds the 50 MB limit',
        unsupportedMessage: 'Media source must be a supported image',
      })
  if (accepted instanceof Response) throw await responseError(accepted)
  if (!accepted) throw new Error(`Media asset "${existingAsset?.id}" no longer exists.`)

  const asset = await updateSyncedMetadata(db, accepted, input)
  await savePluginMediaSource(db, {
    pluginId: args.pluginId,
    sourceKey: input.sourceKey,
    assetId: asset.id,
    sourceVersion,
    contentHash,
  })
  return {
    status: existingAsset ? 'replaced' : 'created',
    asset: upsertedAsset(asset),
  }
}

export async function upsertMediaAsset(
  db: DbClient,
  args: MediaIngestionArgs,
  deps: RemoteMediaDownloadDeps = {},
): Promise<MediaUpsertResult> {
  return withSourceKeyLock(`${args.pluginId}\u0000${args.input.sourceKey}`, () =>
    performUpsert(db, args, deps))
}
