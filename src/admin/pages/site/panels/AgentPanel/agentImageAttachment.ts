import {
  AI_USER_IMAGE_MAX_BYTES,
  AI_USER_IMAGE_MAX_EDGE,
  AI_USER_IMAGE_MAX_PIXELS,
  AI_USER_IMAGE_MAX_SOURCE_BYTES,
  AI_USER_IMAGE_MAX_SOURCE_EDGE,
  AI_USER_IMAGE_MAX_SOURCE_PIXELS,
  isAiUserImageSourceMimeType,
  type AiUserImageBlock,
} from '@core/ai'

const JPEG_QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58] as const
const MIN_RESIZE_SCALE = 0.5

export interface AgentImageSize {
  width: number
  height: number
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

/** Fit an image inside both the long-edge and total-pixel policy. */
export function fitAgentImageSize(width: number, height: number): AgentImageSize {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('Image has invalid dimensions.')
  }
  const edgeScale = Math.min(1, AI_USER_IMAGE_MAX_EDGE / Math.max(width, height))
  const pixelScale = Math.min(1, Math.sqrt(AI_USER_IMAGE_MAX_PIXELS / (width * height)))
  const scale = Math.min(edgeScale, pixelScale)
  return {
    // Floor so rounding can never put the output one pixel beyond the server's
    // edge or area ceiling (notably a square at sqrt(MAX_PIXELS)).
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/** Decode, resize, strip metadata, and encode one clipboard image as JPEG. */
export async function normaliseAgentImage(
  file: File,
  signal?: AbortSignal,
): Promise<AiUserImageBlock> {
  signal?.throwIfAborted()
  if (!isAiUserImageSourceMimeType(file.type)) {
    throw new Error('Use a PNG, JPEG, or WebP image.')
  }
  if (file.size > AI_USER_IMAGE_MAX_SOURCE_BYTES) {
    throw new Error(`Source image must be smaller than ${formatMegabytes(AI_USER_IMAGE_MAX_SOURCE_BYTES)} MB.`)
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer())
  signal?.throwIfAborted()
  const sourceSize = readAgentImageSourceSize(sourceBytes, file.type)
  if (
    sourceSize.width > AI_USER_IMAGE_MAX_SOURCE_EDGE
    || sourceSize.height > AI_USER_IMAGE_MAX_SOURCE_EDGE
    || sourceSize.width * sourceSize.height > AI_USER_IMAGE_MAX_SOURCE_PIXELS
  ) {
    throw new Error(
      `Source image dimensions exceed the ${AI_USER_IMAGE_MAX_SOURCE_EDGE}px / ${AI_USER_IMAGE_MAX_SOURCE_PIXELS.toLocaleString()}px limit.`,
    )
  }
  const decodeSize = fitAgentImageSize(sourceSize.width, sourceSize.height)
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
    resizeWidth: decodeSize.width,
    resizeHeight: decodeSize.height,
    resizeQuality: 'high',
  })
  if (signal?.aborted) {
    bitmap.close()
    signal.throwIfAborted()
  }
  try {
    let size = fitAgentImageSize(bitmap.width, bitmap.height)
    for (let resizeAttempt = 0; resizeAttempt < 3; resizeAttempt += 1) {
      const canvas = drawBitmap(bitmap, size)
      let lastBlob: Blob | null = null
      for (const quality of JPEG_QUALITIES) {
        signal?.throwIfAborted()
        const blob = await canvasToJpeg(canvas, quality)
        signal?.throwIfAborted()
        lastBlob = blob
        if (blob.size <= AI_USER_IMAGE_MAX_BYTES) {
          if (blob.type !== 'image/jpeg') {
            throw new Error('This browser could not encode the pasted image as JPEG.')
          }
          const data = await blobToBase64(blob, signal)
          signal?.throwIfAborted()
          return {
            kind: 'image',
            mimeType: 'image/jpeg',
            data,
          }
        }
      }

      if (!lastBlob) break
      const scale = Math.max(
        MIN_RESIZE_SCALE,
        Math.sqrt(AI_USER_IMAGE_MAX_BYTES / lastBlob.size) * 0.9,
      )
      size = {
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      }
    }
  } finally {
    bitmap.close()
  }

  throw new Error(`Image could not be reduced below ${formatMegabytes(AI_USER_IMAGE_MAX_BYTES)} MB.`)
}

/** Read raster dimensions from bounded source bytes before allocating a decoder. */
export function readAgentImageSourceSize(
  bytes: Uint8Array,
  mimeType: string,
): AgentImageSize {
  const size = mimeType === 'image/png'
    ? readPngSize(bytes)
    : mimeType === 'image/jpeg'
      ? readJpegSize(bytes)
      : mimeType === 'image/webp'
        ? readWebpSize(bytes)
        : null
  if (!size || size.width < 1 || size.height < 1) {
    throw new Error('Image dimensions could not be read safely.')
  }
  return size
}

function readPngSize(bytes: Uint8Array): AgentImageSize | null {
  if (
    bytes.length < 24
    || bytes[0] !== 0x89
    || bytes[1] !== 0x50
    || bytes[2] !== 0x4e
    || bytes[3] !== 0x47
    || ascii(bytes, 12, 4) !== 'IHDR'
  ) return null
  const view = dataView(bytes)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

function readJpegSize(bytes: Uint8Array): AgentImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const view = dataView(bytes)
  let offset = 2
  let orientation = 1
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (bytes[offset] === 0xff) offset += 1
    const marker = bytes[offset]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1
      continue
    }
    if (offset + 2 >= bytes.length) return null
    const segmentLength = view.getUint16(offset + 1)
    if (segmentLength < 2 || offset + 1 + segmentLength > bytes.length) return null
    if (marker === 0xe1) {
      orientation = readExifOrientation(bytes, offset + 3, segmentLength - 2) ?? orientation
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) return null
      const size = {
        height: view.getUint16(offset + 4),
        width: view.getUint16(offset + 6),
      }
      return orientation >= 5 && orientation <= 8
        ? { width: size.height, height: size.width }
        : size
    }
    offset += segmentLength + 1
  }
  return null
}

function readExifOrientation(
  bytes: Uint8Array,
  payloadOffset: number,
  payloadLength: number,
): number | null {
  if (payloadLength < 14 || ascii(bytes, payloadOffset, 6) !== 'Exif\0\0') return null
  const tiffOffset = payloadOffset + 6
  const littleEndian = ascii(bytes, tiffOffset, 2) === 'II'
  if (!littleEndian && ascii(bytes, tiffOffset, 2) !== 'MM') return null
  const view = dataView(bytes)
  if (view.getUint16(tiffOffset + 2, littleEndian) !== 42) return null
  const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian)
  const directoryOffset = tiffOffset + ifdOffset
  const payloadEnd = payloadOffset + payloadLength
  if (directoryOffset + 2 > payloadEnd) return null
  const entryCount = view.getUint16(directoryOffset, littleEndian)
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = directoryOffset + 2 + index * 12
    if (entryOffset + 12 > payloadEnd) return null
    if (
      view.getUint16(entryOffset, littleEndian) === 0x0112
      && view.getUint16(entryOffset + 2, littleEndian) === 3
      && view.getUint32(entryOffset + 4, littleEndian) === 1
    ) {
      const orientation = view.getUint16(entryOffset + 8, littleEndian)
      return orientation >= 1 && orientation <= 8 ? orientation : null
    }
  }
  return null
}

function readWebpSize(bytes: Uint8Array): AgentImageSize | null {
  if (
    bytes.length < 20
    || ascii(bytes, 0, 4) !== 'RIFF'
    || ascii(bytes, 8, 4) !== 'WEBP'
  ) return null
  const view = dataView(bytes)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const kind = ascii(bytes, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const dataOffset = offset + 8
    if (dataOffset + chunkSize > bytes.length) return null

    if (kind === 'VP8X' && chunkSize >= 10) {
      return {
        width: readUint24Le(bytes, dataOffset + 4) + 1,
        height: readUint24Le(bytes, dataOffset + 7) + 1,
      }
    }
    if (
      kind === 'VP8 '
      && chunkSize >= 10
      && bytes[dataOffset + 3] === 0x9d
      && bytes[dataOffset + 4] === 0x01
      && bytes[dataOffset + 5] === 0x2a
    ) {
      return {
        width: view.getUint16(dataOffset + 6, true) & 0x3fff,
        height: view.getUint16(dataOffset + 8, true) & 0x3fff,
      }
    }
    if (kind === 'VP8L' && chunkSize >= 5 && bytes[dataOffset] === 0x2f) {
      const b1 = bytes[dataOffset + 1]!
      const b2 = bytes[dataOffset + 2]!
      const b3 = bytes[dataOffset + 3]!
      const b4 = bytes[dataOffset + 4]!
      return {
        width: 1 + ((b1 | (b2 << 8)) & 0x3fff),
        height: 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff),
      }
    }
    offset = dataOffset + chunkSize + (chunkSize % 2)
  }
  return null
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function drawBitmap(bitmap: ImageBitmap, size: AgentImageSize): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot prepare image attachments.')
  // JPEG has no alpha channel. A white matte keeps transparent mockups legible.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size.width, size.height)
  context.drawImage(bitmap, 0, 0, size.width, size.height)
  return canvas
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('This browser could not encode the pasted image.'))
    }, 'image/jpeg', quality)
  })
}

async function blobToBase64(blob: Blob, signal?: AbortSignal): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  signal?.throwIfAborted()
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    signal?.throwIfAborted()
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}
