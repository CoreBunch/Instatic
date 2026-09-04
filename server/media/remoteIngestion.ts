/**
 * Host-mediated remote media ingestion for scheduled plugins.
 * The caller supplies URL metadata only. Bun downloads, validates, stores,
 * and processes the bytes without carrying them through QuickJS.
 */
import type { RemoteMediaAsset, RemoteMediaUpsertInput, RemoteMediaUpsertResult } from '@core/plugin-sdk'
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
  getPluginRemoteMediaSource,
  savePluginRemoteMediaSource,
} from '../repositories/pluginRemoteMediaSources'
import {
  acceptReplacementMedia,
  acceptUploadedMedia,
  IMAGE_MIMES,
  MAX_MEDIA_BYTES,
} from '../handlers/cms/mediaUpload'
import { downloadRemoteMedia, type RemoteMediaDownloadDeps } from './remoteDownload'

export interface RemoteMediaIngestionArgs {
  pluginId: string
  networkAllowedHosts: ReadonlyArray<string>
  input: RemoteMediaUpsertInput
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

function remoteAsset(asset: MediaAsset): RemoteMediaAsset {
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
    `Remote media import was rejected (HTTP ${response.status}).`,
  )
  return new Error(message)
}

async function updateSyncedMetadata(
  db: DbClient,
  asset: MediaAsset,
  input: RemoteMediaUpsertInput,
): Promise<MediaAsset> {
  let current = asset.deletedAt ? (await restoreMediaAsset(db, asset.id) ?? asset) : asset
  const updated = await updateMediaAssetMetadata(db, current.id, {
    filename: input.filename,
    ...(input.altText !== undefined ? { altText: input.altText } : {}),
  })
  if (updated) current = updated
  return current
}

async function performUpsert(
  db: DbClient,
  args: RemoteMediaIngestionArgs,
  deps: RemoteMediaDownloadDeps,
): Promise<RemoteMediaUpsertResult> {
  const input = args.input
  const existingSource = await getPluginRemoteMediaSource(db, args.pluginId, input.sourceKey)
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
    return { status: 'unchanged', asset: remoteAsset(asset) }
  }

  const bytes = await downloadRemoteMedia(input.sourceUrl, {
    allowlist: args.networkAllowedHosts,
    maxBytes: MAX_MEDIA_BYTES,
    label: `Plugin "${args.pluginId}" remote media`,
  }, deps)
  const contentHash = await sha256Hex(bytes)
  const sourceVersion = input.sourceVersion ?? null

  if (existingSource && existingAsset && contentHash === existingSource.contentHash) {
    await savePluginRemoteMediaSource(db, {
      pluginId: args.pluginId,
      sourceKey: input.sourceKey,
      assetId: existingAsset.id,
      sourceVersion,
      contentHash,
    })
    const asset = await updateSyncedMetadata(db, existingAsset, input)
    return { status: 'unchanged', asset: remoteAsset(asset) }
  }

  const file = new File([bytes], input.filename)
  const accepted = existingAsset
    ? await acceptReplacementMedia(db, existingAsset.id, {
        file,
        maxBytes: MAX_MEDIA_BYTES,
        allowedMimes: IMAGE_MIMES,
        role: 'original',
        uploadedByUserId: null,
        oversizedMessage: 'Remote media exceeds the 50 MB limit',
        unsupportedMessage: 'Remote media must be a supported image',
      })
    : await acceptUploadedMedia(db, {
        file,
        maxBytes: MAX_MEDIA_BYTES,
        allowedMimes: IMAGE_MIMES,
        role: 'original',
        uploadedByUserId: null,
        ...(input.altText !== undefined ? { altText: input.altText } : {}),
        oversizedMessage: 'Remote media exceeds the 50 MB limit',
        unsupportedMessage: 'Remote media must be a supported image',
      })
  if (accepted instanceof Response) throw await responseError(accepted)
  if (!accepted) throw new Error(`Remote media asset "${existingAsset?.id}" no longer exists.`)

  const asset = await updateSyncedMetadata(db, accepted, input)
  await savePluginRemoteMediaSource(db, {
    pluginId: args.pluginId,
    sourceKey: input.sourceKey,
    assetId: asset.id,
    sourceVersion,
    contentHash,
  })
  return {
    status: existingAsset ? 'replaced' : 'created',
    asset: remoteAsset(asset),
  }
}

export async function upsertRemoteMediaAsset(
  db: DbClient,
  args: RemoteMediaIngestionArgs,
  deps: RemoteMediaDownloadDeps = {},
): Promise<RemoteMediaUpsertResult> {
  return withSourceKeyLock(`${args.pluginId}\u0000${args.input.sourceKey}`, () =>
    performUpsert(db, args, deps))
}
