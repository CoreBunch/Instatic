import { apiBlobRequest, type FetchLike } from '@core/http'
import {
  uploadCmsMediaAsset,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import { primeCmsMediaAssetCache } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { publishCmsMediaAssetCreated } from '@admin/pages/media/mediaAssetEvents'
import type { AgentPreviewImage } from './agentImageTypes'

interface AgentImageActionOptions {
  fetchImpl?: FetchLike
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

const mediaSavesInFlight = new Map<string, Promise<CmsMediaAsset>>()

function mediaSaveKey(image: AgentPreviewImage): string {
  return `${image.id}\0${image.src}`
}

/** Resolve a data URL or authenticated conversation-image URL to validated image bytes. */
export async function readAgentImageBlob(
  image: AgentPreviewImage,
  options: AgentImageActionOptions = {},
): Promise<Blob> {
  if (!image.src.startsWith('data:')) {
    const url = new URL(image.src, window.location.href)
    if (url.origin !== window.location.origin) {
      throw new Error('Only images from this Instatic site can be saved or copied.')
    }
  }
  const blob = await apiBlobRequest(image.src, {
    credentials: 'include',
    fallbackMessage: 'The image could not be loaded.',
    fetchImpl: options.fetchImpl,
  })
  if (blob.size === 0) throw new Error('The image is empty.')
  const mimeType = blob.type.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  if (!mimeType.startsWith('image/')) {
    throw new Error('The selected resource is not an image.')
  }
  return blob.type === mimeType ? blob : blob.slice(0, blob.size, mimeType)
}

/** Build an honest, filesystem-safe filename from the actual response MIME. */
export function agentImageFilename(image: AgentPreviewImage, blob: Blob): string {
  const mimeType = blob.type.toLowerCase().split(';', 1)[0] ?? ''
  const subtype = mimeType.startsWith('image/')
    ? mimeType.slice('image/'.length).replace(/[^a-z0-9]+/g, '')
    : ''
  const extension = EXTENSION_BY_MIME[mimeType] ?? (subtype || 'img')
  const preferred = image.filename?.trim() || `instatic-image-${image.id}`
  const withoutExtension = preferred.replace(/\.[a-z0-9]{1,10}$/i, '')
  const safeStem = withoutExtension
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 96)
  return `${safeStem || 'instatic-image'}.${extension}`
}

/** Copy the rendered image bytes (not its URL) to the system clipboard. */
export async function copyAgentImageToClipboard(image: AgentPreviewImage): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Image copying is not supported by this browser.')
  }

  // Construct the ClipboardItem and call write synchronously while the menu
  // click still owns browser user activation. Safari accepts the promised PNG
  // bytes and resolves them after the authenticated image read/conversion.
  const png = readAgentImageBlob(image).then((source) =>
    source.type === 'image/png' ? source : convertImageToPng(source),
  )
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/** Start a native browser download; the browser owns the final save location. */
export async function downloadAgentImage(image: AgentPreviewImage): Promise<void> {
  const blob = await readAgentImageBlob(image)
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = agentImageFilename(image, blob)
  link.hidden = true
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
  }
}

/** Upload through the canonical Media pipeline (permissions, sniffing, variants, storage). */
export function isAgentImageMediaSavePending(image: AgentPreviewImage): boolean {
  return mediaSavesInFlight.has(mediaSaveKey(image))
}

export function saveAgentImageToMedia(image: AgentPreviewImage): Promise<CmsMediaAsset> {
  const key = mediaSaveKey(image)
  const existing = mediaSavesInFlight.get(key)
  if (existing) return existing

  const saving = persistAgentImageToMedia(image)
  mediaSavesInFlight.set(key, saving)
  const clearPending = () => {
    if (mediaSavesInFlight.get(key) === saving) {
      mediaSavesInFlight.delete(key)
    }
  }
  void saving.then(clearPending, clearPending)
  return saving
}

async function persistAgentImageToMedia(image: AgentPreviewImage): Promise<CmsMediaAsset> {
  const blob = await readAgentImageBlob(image)
  const file = new File([blob], agentImageFilename(image, blob), {
    type: blob.type,
    lastModified: Date.now(),
  })
  const asset = await uploadCmsMediaAsset(file)
  primeCmsMediaAssetCache(asset)
  publishCmsMediaAssetCreated(asset)
  return asset
}

async function convertImageToPng(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('Image copying is not supported by this browser.')
  }
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The image could not be prepared for copying.')
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png)
        else reject(new Error('The image could not be prepared for copying.'))
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
}
