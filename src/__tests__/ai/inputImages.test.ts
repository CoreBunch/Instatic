import { beforeAll, describe, expect, test } from 'bun:test'
import sharp from 'sharp'
import {
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  AI_USER_IMAGE_MAX_BYTES,
  AI_USER_IMAGE_MAX_EDGE,
  AI_USER_IMAGE_MAX_PIXELS,
  type AiUserImageBlock,
} from '@core/ai'
import {
  AiImageInputError,
  canonicaliseAiUserContent,
  preflightAiUserContent,
  validateAiUserContent,
  validateAiUserImage,
} from '../../../server/ai/inputImages'

let smallJpegBase64 = ''

beforeAll(async () => {
  smallJpegBase64 = (await makeImage(24, 16, 'jpeg')).toString('base64')
})

function imageBlock(data = smallJpegBase64): AiUserImageBlock {
  return { kind: 'image', mimeType: 'image/jpeg', data }
}

function makeImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png',
): Promise<Buffer> {
  const source = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 45, g: 90, b: 135 },
    },
  })
  return format === 'jpeg' ? source.jpeg().toBuffer() : source.png().toBuffer()
}

describe('validateAiUserContent', () => {
  test('normalises mixed content to trimmed text followed by every image', async () => {
    const content = await validateAiUserContent([
      imageBlock(),
      { kind: 'text', text: '  Describe this screenshot.  ' },
      imageBlock(),
    ])

    expect(content[0]).toEqual({ kind: 'text', text: 'Describe this screenshot.' })
    expect(content[1]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
    expect((content[1] as AiUserImageBlock).data.length).toBeGreaterThan(0)
    expect(content[2]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
  })

  test('accepts image-only content and removes whitespace-only text beside it', async () => {
    const imageOnly = await validateAiUserContent([imageBlock()])
    const besideWhitespace = await validateAiUserContent([
      { kind: 'text', text: '   \n  ' },
      imageBlock(),
    ])

    expect(imageOnly).toHaveLength(1)
    expect(imageOnly[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
    expect(besideWhitespace).toHaveLength(1)
    expect(besideWhitespace[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' })
  })

  test('stops before the next decode when cancellation lands between images', async () => {
    const corruptButPreflightValid = Buffer.from([0xff, 0xd8, 0xff, 0x00])
    const preflight = preflightAiUserContent([
      imageBlock(),
      imageBlock(corruptButPreflightValid.toString('base64')),
    ])
    let abortChecks = 0
    const signal = {
      throwIfAborted() {
        abortChecks += 1
        // Outer per-image check, metadata checks, then the first JPEG encode's
        // before/after checks. Abort immediately after that active pipeline.
        if (abortChecks === 5) throw new DOMException('Request aborted', 'AbortError')
      },
    } as AbortSignal

    await expect(canonicaliseAiUserContent(preflight, signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    // Reaching either another quality attempt or the corrupt second image
    // would throw AiImageInputError instead.
    expect(abortChecks).toBe(5)
  })

  test('rejects an empty turn, duplicate text, and more than eight images', async () => {
    await expect(validateAiUserContent([
      { kind: 'text', text: '   ' },
    ])).rejects.toMatchObject({
      name: 'AiImageInputError',
      status: 400,
      message: 'Message must contain text or an image.',
    })

    await expect(validateAiUserContent([
      { kind: 'text', text: 'one' },
      { kind: 'text', text: 'two' },
    ])).rejects.toMatchObject({
      status: 400,
      message: 'A message can contain at most one text block.',
    })

    await expect(validateAiUserContent([
      ...Array.from({ length: AI_USER_IMAGE_MAX_PER_MESSAGE + 1 }, () => imageBlock()),
    ])).rejects.toMatchObject({
      status: 400,
      message: `A message can contain at most ${AI_USER_IMAGE_MAX_PER_MESSAGE} images.`,
    })
  })
})

describe('validateAiUserImage', () => {
  test('fully decodes and returns a bounded canonical JPEG', async () => {
    const canonical = await validateAiUserImage(imageBlock())
    const bytes = Buffer.from(canonical.data, 'base64')
    const metadata = await sharp(bytes).metadata()

    expect(canonical.mimeType).toBe('image/jpeg')
    expect(bytes.byteLength).toBeLessThanOrEqual(AI_USER_IMAGE_MAX_BYTES)
    expect(metadata).toMatchObject({ format: 'jpeg', width: 24, height: 16 })
  })

  test('rejects malformed and non-canonical base64', async () => {
    for (const data of ['!!!!', 'A===', `${smallJpegBase64} `]) {
      await expect(validateAiUserImage(imageBlock(data))).rejects.toMatchObject({
        name: 'AiImageInputError',
        status: 400,
        message: 'Image data must be canonical base64.',
      })
    }
  })

  test('rejects bytes whose real format does not match the JPEG contract', async () => {
    const png = await makeImage(16, 16, 'png')
    await expect(validateAiUserImage(imageBlock(png.toString('base64')))).rejects.toMatchObject({
      status: 400,
      message: 'Image data is not a JPEG.',
    })
  })

  test('rejects corrupt data even when it starts with the JPEG signature', async () => {
    const corrupt = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03])
    await expect(validateAiUserImage(imageBlock(corrupt.toString('base64')))).rejects.toBeInstanceOf(
      AiImageInputError,
    )
  })

  test('rejects a truncated JPEG whose header metadata is still readable', async () => {
    const complete = await makeImage(24, 16, 'jpeg')
    const truncated = complete.subarray(0, complete.byteLength - 2)
    expect((await sharp(truncated).metadata()).format).toBe('jpeg')

    await expect(validateAiUserImage(imageBlock(truncated.toString('base64'))))
      .rejects.toMatchObject({ status: 400, message: 'Image data could not be fully decoded.' })
  })

  test('strips source metadata before persistence', async () => {
    const tagged = await sharp({
      create: {
        width: 24,
        height: 16,
        channels: 3,
        background: { r: 45, g: 90, b: 135 },
      },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer()
    expect((await sharp(tagged).metadata()).exif).toBeDefined()

    const canonical = await validateAiUserImage(imageBlock(tagged.toString('base64')))
    const metadata = await sharp(Buffer.from(canonical.data, 'base64')).metadata()

    expect(metadata.exif).toBeUndefined()
    expect(metadata.orientation).toBeUndefined()
  })

  test('rejects decoded bytes over the image budget with 413 semantics', async () => {
    const oversized = Buffer.alloc(AI_USER_IMAGE_MAX_BYTES + 1)
    oversized[0] = 0xff
    oversized[1] = 0xd8
    oversized[2] = 0xff

    await expect(validateAiUserImage(imageBlock(oversized.toString('base64')))).rejects.toMatchObject({
      status: 413,
      message: 'Image exceeds the 1.5 MB limit.',
    })
  })

  test('rejects an excessive edge or pixel area with 413 semantics', async () => {
    const tooWide = await makeImage(AI_USER_IMAGE_MAX_EDGE + 1, 1, 'jpeg')
    await expect(validateAiUserImage(imageBlock(tooWide.toString('base64')))).rejects.toMatchObject({
      status: 413,
    })

    const areaWidth = 1500
    const areaHeight = Math.floor(AI_USER_IMAGE_MAX_PIXELS / areaWidth) + 1
    const tooManyPixels = await makeImage(areaWidth, areaHeight, 'jpeg')
    await expect(validateAiUserImage(imageBlock(tooManyPixels.toString('base64')))).rejects.toMatchObject({
      status: 413,
    })
  })
})
