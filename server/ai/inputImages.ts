import sharp from 'sharp'
import {
  AI_USER_IMAGE_MAX_BYTES,
  AI_USER_IMAGE_MAX_EDGE,
  AI_USER_IMAGE_MAX_PIXELS,
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  type AiContentBlock,
  type AiUserContentBlock,
  type AiUserImageBlock,
} from '@core/ai'

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SERVER_JPEG_QUALITIES = [85, 74, 64, 55] as const

export class AiImageInputError extends Error {
  readonly status: 400 | 413

  constructor(message: string, status: 400 | 413 = 400, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AiImageInputError'
    this.status = status
  }
}

export interface AiUserContentPreflight {
  readonly text: string
  readonly images: readonly AiUserImageBlock[]
  readonly imageBytes: readonly Buffer[]
}

/**
 * Validate and canonicalise one user-authored turn before persistence.
 * The request schema limits the vocabulary; this layer enforces cross-block
 * invariants and verifies that an alleged JPEG is real, bounded image data.
 */
export async function validateAiUserContent(
  content: readonly AiUserContentBlock[],
  signal?: AbortSignal,
): Promise<AiContentBlock[]> {
  return canonicaliseAiUserContent(preflightAiUserContent(content), signal)
}

/** Cheap structural/byte checks that never invoke an image decoder. */
export function preflightAiUserContent(
  content: readonly AiUserContentBlock[],
): AiUserContentPreflight {
  const textBlocks = content.filter((block) => block.kind === 'text')
  const imageBlocks = content.filter((block) => block.kind === 'image')

  if (textBlocks.length > 1) {
    throw new AiImageInputError('A message can contain at most one text block.')
  }
  if (imageBlocks.length > AI_USER_IMAGE_MAX_PER_MESSAGE) {
    throw new AiImageInputError(
      `A message can contain at most ${AI_USER_IMAGE_MAX_PER_MESSAGE} images.`,
    )
  }

  const text = textBlocks[0]?.text.trim() ?? ''
  if (!text && imageBlocks.length === 0) {
    throw new AiImageInputError('Message must contain text or an image.')
  }

  const imageBytes = imageBlocks.map(preflightAiUserImage)
  return { text, images: imageBlocks, imageBytes }
}

/** Full decoder boundary + canonical block reconstruction after admission gates. */
export async function canonicaliseAiUserContent(
  preflight: AiUserContentPreflight,
  signal?: AbortSignal,
): Promise<AiContentBlock[]> {
  // Text precedes the image in the canonical provider-facing order. This also
  // removes whitespace-only text so no driver emits an empty text part and
  // reconstructs the image so request-only extra fields cannot be persisted.
  const canonical: AiContentBlock[] = []
  if (preflight.text) canonical.push({ kind: 'text', text: preflight.text })
  // Decode sequentially. Eight concurrent Sharp pipelines would multiply the
  // per-request memory peak for no user-visible benefit.
  for (const bytes of preflight.imageBytes) {
    signal?.throwIfAborted()
    canonical.push(await canonicaliseAiUserImage(bytes, signal))
    // Sharp cannot be interrupted safely mid-pipeline. Check again after the
    // active decode so a disconnected request never starts the next image.
    signal?.throwIfAborted()
  }
  return canonical
}

export async function validateAiUserImage(
  image: AiUserImageBlock,
  signal?: AbortSignal,
): Promise<AiUserImageBlock> {
  return canonicaliseAiUserImage(preflightAiUserImage(image), signal)
}

function preflightAiUserImage(image: AiUserImageBlock): Buffer {
  const bytes = decodeCanonicalBase64(image.data)
  if (bytes.byteLength > AI_USER_IMAGE_MAX_BYTES) {
    throw new AiImageInputError(
      `Image exceeds the ${formatMegabytes(AI_USER_IMAGE_MAX_BYTES)} MB limit.`,
      413,
    )
  }

  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new AiImageInputError('Image data is not a JPEG.')
  }
  return bytes
}

async function canonicaliseAiUserImage(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<AiUserImageBlock> {
  signal?.throwIfAborted()
  let metadata: sharp.Metadata
  try {
    metadata = await sharp(bytes).metadata()
  } catch (err) {
    throw new AiImageInputError('Image data could not be decoded.', 400, { cause: err })
  }
  signal?.throwIfAborted()

  if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) {
    throw new AiImageInputError('Image data is not a valid JPEG.')
  }
  if (
    metadata.width > AI_USER_IMAGE_MAX_EDGE
    || metadata.height > AI_USER_IMAGE_MAX_EDGE
    || metadata.width * metadata.height > AI_USER_IMAGE_MAX_PIXELS
  ) {
    throw new AiImageInputError(
      `Image dimensions exceed the ${AI_USER_IMAGE_MAX_EDGE}px / ${AI_USER_IMAGE_MAX_PIXELS.toLocaleString()}px limit.`,
      413,
    )
  }

  const canonicalBytes = await canonicaliseJpeg(
    bytes,
    metadata.width,
    metadata.height,
    signal,
  )
  return {
    kind: 'image',
    mimeType: 'image/jpeg',
    data: canonicalBytes.toString('base64'),
  }
}

/**
 * Fully decode and re-encode the image before persistence. Sharp strips source
 * metadata by default; `failOn: 'warning'` also rejects truncated JPEGs whose
 * headers are readable but whose pixel data is incomplete.
 */
async function canonicaliseJpeg(
  bytes: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  let width = sourceWidth
  let height = sourceHeight
  let lastSize = bytes.byteLength

  try {
    for (let resizeAttempt = 0; resizeAttempt < 3; resizeAttempt += 1) {
      for (const quality of SERVER_JPEG_QUALITIES) {
        signal?.throwIfAborted()
        let pipeline = sharp(bytes, {
          failOn: 'warning',
          limitInputPixels: AI_USER_IMAGE_MAX_PIXELS,
        })
          .rotate()
          .flatten({ background: { r: 255, g: 255, b: 255 } })

        if (resizeAttempt > 0) {
          pipeline = pipeline.resize({
            width,
            height,
            fit: 'inside',
            withoutEnlargement: true,
          })
        }

        const output = await pipeline.jpeg({ quality }).toBuffer()
        // Sharp does not expose an abortable encode. Stop immediately after
        // the active pipeline instead of beginning another quality/resize.
        signal?.throwIfAborted()
        lastSize = output.byteLength
        if (output.byteLength <= AI_USER_IMAGE_MAX_BYTES) return output
      }

      const scale = Math.max(
        0.5,
        Math.sqrt(AI_USER_IMAGE_MAX_BYTES / lastSize) * 0.9,
      )
      width = Math.max(1, Math.floor(width * scale))
      height = Math.max(1, Math.floor(height * scale))
    }
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err
    throw new AiImageInputError('Image data could not be fully decoded.', 400, { cause: err })
  }

  throw new AiImageInputError(
    `Image could not be reduced below the ${formatMegabytes(AI_USER_IMAGE_MAX_BYTES)} MB limit.`,
    413,
  )
}

function decodeCanonicalBase64(data: string): Buffer {
  if (!data || data.length % 4 !== 0 || !CANONICAL_BASE64.test(data)) {
    throw new AiImageInputError('Image data must be canonical base64.')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) {
    throw new AiImageInputError('Image data must be canonical base64.')
  }
  return bytes
}

function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}
