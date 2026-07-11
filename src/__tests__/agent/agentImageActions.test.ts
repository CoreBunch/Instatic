import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  agentImageFilename,
  copyAgentImageToClipboard,
  downloadAgentImage,
  isAgentImageMediaSavePending,
  readAgentImageBlob,
  saveAgentImageToMedia,
} from '@site/panels/AgentPanel/agentImageActions'
import type { AgentPreviewImage } from '@site/panels/AgentPanel/agentImageTypes'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function image(overrides: Partial<AgentPreviewImage> = {}): AgentPreviewImage {
  return {
    id: 'image-1',
    src: '/image-1',
    alt: 'Test image',
    filename: 'Reference source.png',
    ...overrides,
  }
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

describe('agent image actions', () => {
  it('reads only non-empty image responses and derives a MIME-correct safe filename', async () => {
    const blob = await readAgentImageBlob(image(), {
      fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg' },
      }),
    })

    expect(blob.type).toBe('image/jpeg')
    expect(agentImageFilename(image(), blob)).toBe('Reference-source.jpg')

    await expect(readAgentImageBlob(image(), {
      fetchImpl: async () => new Response('not an image', {
        headers: { 'content-type': 'text/plain' },
      }),
    })).rejects.toThrow('not an image')
  })

  it('passes promised PNG bytes to the clipboard in the initiating call stack', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')
    const canvasPrototype = Object.getPrototypeOf(document.createElement('canvas')) as object
    const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
    const contextDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'getContext')
    const toBlobDescriptor = Object.getOwnPropertyDescriptor(canvasPrototype, 'toBlob')
    const itemPayloads: Array<Record<string, Blob | Promise<Blob>>> = []
    const write = mock(async (_items: ClipboardItem[]) => {})
    const closeBitmap = mock(() => {})
    class TestClipboardItem {
      constructor(payload: Record<string, Blob | Promise<Blob>>) {
        itemPayloads.push(payload)
      }
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: async () => ({ width: 40, height: 30, close: closeBitmap }),
    })
    Object.defineProperty(canvasPrototype, 'getContext', {
      configurable: true,
      value: () => ({ drawImage: () => {} }),
    })
    Object.defineProperty(canvasPrototype, 'toBlob', {
      configurable: true,
      value: (callback: BlobCallback) => {
        callback(new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }))
      },
    })
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/jpeg' },
    })) as typeof fetch

    try {
      await copyAgentImageToClipboard(image())
      expect(write).toHaveBeenCalledTimes(1)
      expect(itemPayloads).toHaveLength(1)
      const png = await itemPayloads[0]?.['image/png']
      expect(png).toBeInstanceOf(Blob)
      expect((png as Blob).type).toBe('image/png')
      expect(closeBitmap).toHaveBeenCalledTimes(1)
    } finally {
      restoreProperty(navigator, 'clipboard', clipboardDescriptor)
      restoreProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor)
      restoreProperty(globalThis, 'createImageBitmap', bitmapDescriptor)
      restoreProperty(canvasPrototype, 'getContext', contextDescriptor)
      restoreProperty(canvasPrototype, 'toBlob', toBlobDescriptor)
    }
  })

  it('downloads with a MIME-correct filename and releases the object URL', async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const clickDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click')
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(window, 'setTimeout')
    const revoke = mock((_url: string) => {})
    let downloadName = ''
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:agent-image',
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revoke,
    })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      value: function click(this: HTMLAnchorElement) {
        downloadName = this.download
      },
    })
    Object.defineProperty(window, 'setTimeout', {
      configurable: true,
      value: (handler: TimerHandler) => {
        if (typeof handler === 'function') handler()
        return 1
      },
    })
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/webp' },
    })) as typeof fetch

    try {
      await downloadAgentImage(image())
      expect(downloadName).toBe('Reference-source.webp')
      expect(revoke).toHaveBeenCalledWith('blob:agent-image')
    } finally {
      restoreProperty(URL, 'createObjectURL', createDescriptor)
      restoreProperty(URL, 'revokeObjectURL', revokeDescriptor)
      restoreProperty(HTMLAnchorElement.prototype, 'click', clickDescriptor)
      restoreProperty(window, 'setTimeout', timeoutDescriptor)
    }
  })

  it('deduplicates concurrent saves of the same image to Media', async () => {
    let resolveUpload!: (response: Response) => void
    const uploadResponse = new Promise<Response>((resolve) => {
      resolveUpload = resolve
    })
    let sourceReads = 0
    let uploads = 0
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/image-1') {
        sourceReads += 1
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          headers: { 'content-type': 'image/jpeg' },
        })
      }
      if (url === '/admin/api/cms/media' && init?.method === 'POST') {
        uploads += 1
        return uploadResponse
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    const target = image()
    const first = saveAgentImageToMedia(target)
    const second = saveAgentImageToMedia(target)
    expect(first).toBe(second)
    expect(isAgentImageMediaSavePending(target)).toBe(true)
    expect(isAgentImageMediaSavePending({ ...target, id: 'another-image' })).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sourceReads).toBe(1)
    expect(uploads).toBe(1)
    resolveUpload(new Response(JSON.stringify({
      asset: {
        id: 'saved-once',
        filename: 'Reference-source.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 4,
        publicPath: '/uploads/reference-source.jpg',
        uploadedByUserId: null,
        createdAt: '2026-07-11T10:00:00.000Z',
      },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }))

    const [firstAsset, secondAsset] = await Promise.all([first, second])
    expect(firstAsset.id).toBe('saved-once')
    expect(secondAsset).toBe(firstAsset)
    expect(isAgentImageMediaSavePending(target)).toBe(false)
  })
})
