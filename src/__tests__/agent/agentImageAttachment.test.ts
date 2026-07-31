import { afterEach, describe, expect, it, mock } from 'bun:test'
import sharp from 'sharp'
import {
  AI_USER_IMAGE_MAX_EDGE,
  AI_USER_IMAGE_MAX_PIXELS,
} from '@core/ai'
import {
  fitAgentImageSize,
  normaliseAgentImage,
  readAgentImageSourceSize,
} from '@site/panels/AgentPanel/agentImageAttachment'

interface BrowserImageMocks {
  close: ReturnType<typeof mock>
  createImageBitmap: ReturnType<typeof mock>
  drawImage: ReturnType<typeof mock>
  fillRect: ReturnType<typeof mock>
  restore(): void
}

let activeMocks: BrowserImageMocks | null = null

function installBrowserImageMocks(blob: Blob | null = new Blob(
  [new Uint8Array([1, 2, 3])],
  { type: 'image/jpeg' },
)): BrowserImageMocks {
  activeMocks?.restore()
  const canvasPrototype = Object.getPrototypeOf(document.createElement('canvas')) as object
  const createBitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  const getContextDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'getContext')
  const toBlobDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'toBlob')
  const close = mock(() => {})
  const drawImage = mock(() => {})
  const fillRect = mock(() => {})
  const createImageBitmap = mock(async () => ({
    width: 2000,
    height: 1000,
    close,
  } as unknown as ImageBitmap))

  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: createImageBitmap,
  })
  Object.defineProperty(canvasPrototype, 'getContext', {
    configurable: true,
    value: () => ({ fillStyle: '', fillRect, drawImage }),
  })
  Object.defineProperty(canvasPrototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => callback(blob),
  })

  const installed: BrowserImageMocks = {
    close,
    createImageBitmap,
    drawImage,
    fillRect,
    restore() {
      restoreProperty(globalThis, 'createImageBitmap', createBitmapDescriptor)
      restoreProperty(canvasPrototype, 'getContext', getContextDescriptor)
      restoreProperty(canvasPrototype, 'toBlob', toBlobDescriptor)
    },
  }
  activeMocks = installed
  return installed
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

describe('agent image attachment preparation', () => {
  afterEach(() => {
    activeMocks?.restore()
    activeMocks = null
  })

  it('does not upscale images that already fit the policy', () => {
    expect(fitAgentImageSize(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it('fits wide images inside both the long-edge and pixel limits', () => {
    const size = fitAgentImageSize(4000, 2000)
    expect(size).toEqual({ width: AI_USER_IMAGE_MAX_EDGE, height: AI_USER_IMAGE_MAX_EDGE / 2 })
    expect(size.width * size.height).toBeLessThanOrEqual(AI_USER_IMAGE_MAX_PIXELS)
  })

  it('never rounds a pixel-limited image back above the pixel budget', () => {
    const size = fitAgentImageSize(2000, 2000)
    expect(size.width * size.height).toBeLessThanOrEqual(AI_USER_IMAGE_MAX_PIXELS)
  })

  it('rejects invalid dimensions before allocating a canvas', () => {
    expect(() => fitAgentImageSize(0, 100)).toThrow('Image has invalid dimensions.')
    expect(() => fitAgentImageSize(Number.NaN, 100)).toThrow('Image has invalid dimensions.')
  })

  it('normalises a pasted image to a bounded JPEG and closes the decoded bitmap', async () => {
    const browser = installBrowserImageMocks()
    const block = await normaliseAgentImage(
      new File([pngHeader(2000, 1000)], 'reference.png', { type: 'image/png' }),
    )

    expect(block).toEqual({ kind: 'image', mimeType: 'image/jpeg', data: 'AQID' })
    expect(browser.fillRect).toHaveBeenCalledTimes(1)
    expect(browser.drawImage).toHaveBeenCalledTimes(1)
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(browser.createImageBitmap.mock.calls[0]?.[1]).toMatchObject({
      imageOrientation: 'from-image',
      resizeWidth: 1568,
      resizeHeight: 784,
      resizeQuality: 'high',
    })
  })

  it('closes the decoded bitmap when browser encoding fails', async () => {
    const browser = installBrowserImageMocks(null)
    await expect(normaliseAgentImage(
      new File([pngHeader(2000, 1000)], 'reference.png', { type: 'image/png' }),
    )).rejects.toThrow('This browser could not encode the pasted image.')
    expect(browser.close).toHaveBeenCalledTimes(1)
  })

  it('closes a decoded bitmap and skips encoding when preparation is cancelled', async () => {
    const browser = installBrowserImageMocks()
    const decoded = deferred<ImageBitmap>()
    browser.createImageBitmap.mockImplementation(() => decoded.promise)
    const controller = new AbortController()
    const preparing = normaliseAgentImage(
      new File([pngHeader(2000, 1000)], 'reference.png', { type: 'image/png' }),
      controller.signal,
    )

    while (browser.createImageBitmap.mock.calls.length === 0) await Promise.resolve()
    controller.abort()
    decoded.resolve({
      width: 1568,
      height: 784,
      close: browser.close,
    } as unknown as ImageBitmap)

    await expect(preparing).rejects.toHaveProperty('name', 'AbortError')
    expect(browser.close).toHaveBeenCalledTimes(1)
    expect(browser.drawImage).not.toHaveBeenCalled()
  })

  it('reads bounded PNG dimensions before decoding and rejects decompression bombs', async () => {
    expect(readAgentImageSourceSize(pngHeader(640, 480), 'image/png'))
      .toEqual({ width: 640, height: 480 })
    const browser = installBrowserImageMocks()

    await expect(normaliseAgentImage(
      new File([pngHeader(20_000, 20_000)], 'bomb.png', { type: 'image/png' }),
    )).rejects.toThrow('Source image dimensions exceed')
    expect(browser.createImageBitmap).not.toHaveBeenCalled()
  })

  it('reads real JPEG and WebP dimensions without a full browser decode', async () => {
    const source = sharp({
      create: {
        width: 321,
        height: 123,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    })
    const [jpeg, webp] = await Promise.all([
      source.clone().jpeg().toBuffer(),
      source.clone().webp().toBuffer(),
    ])

    expect(readAgentImageSourceSize(jpeg, 'image/jpeg')).toEqual({ width: 321, height: 123 })
    expect(readAgentImageSourceSize(webp, 'image/webp')).toEqual({ width: 321, height: 123 })
  })

  it('uses EXIF display orientation when sizing a JPEG decode target', async () => {
    const oriented = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 30, g: 60, b: 90 },
      },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer()

    expect(readAgentImageSourceSize(oriented, 'image/jpeg'))
      .toEqual({ width: 300, height: 400 })
  })

  it('rejects unsupported clipboard formats before decoding', async () => {
    const createImageBitmap = mock(async () => {
      throw new Error('should not decode')
    })
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: createImageBitmap,
    })
    try {
      await expect(normaliseAgentImage(
        new File([new Uint8Array([1])], 'animation.gif', { type: 'image/gif' }),
      )).rejects.toThrow('Use a PNG, JPEG, or WebP image.')
      expect(createImageBitmap).not.toHaveBeenCalled()
    } finally {
      restoreProperty(globalThis, 'createImageBitmap', descriptor)
    }
  })
})

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
