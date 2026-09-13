import { describe, expect, it, spyOn } from 'bun:test'
import { uploadMediaMcpTool } from './uploadMediaTool'
import type { ToolContext } from '../../runtime/types'

// The handler validates input, the source selector, and the SSRF guard BEFORE
// it ever touches `ctx.db` or the storage layer, so these paths need no real
// db/network/DNS. IP-literal hosts short-circuit DNS resolution, letting us
// exercise the blocklist deterministically.
const baseCtx = {
  db: {} as never,
  userId: 'user-1',
  capabilities: [],
  scope: 'content' as const,
  conversationId: 'conversation-1',
  snapshot: null,
}

function upload(
  input: Record<string, unknown>,
  signal = new AbortController().signal,
): Promise<unknown> {
  const ctx: ToolContext = { ...baseCtx, signal }
  return uploadMediaMcpTool.handler!(input, ctx)
}

describe('media_upload', () => {
  it('requires exactly one of data / sourceUrl', async () => {
    await expect(upload({ filename: 'x.png' })).rejects.toThrow(/exactly one/i)
    await expect(
      upload({ filename: 'x.png', data: 'AAAA', sourceUrl: 'https://example.com/a.png' }),
    ).rejects.toThrow(/exactly one/i)
  })

  it('rejects a non-https sourceUrl', async () => {
    await expect(
      upload({ filename: 'x.png', sourceUrl: 'http://example.com/a.png' }),
    ).rejects.toThrow(/https/i)
  })

  it('refuses SSRF targets in blocked ranges', async () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '[::1]']) {
      await expect(
        upload({ filename: 'x.png', sourceUrl: `https://${host}/a.png` }),
      ).rejects.toThrow(/blocked address/i)
    }
  })

  it('rejects inline bytes that are not a supported image', async () => {
    // "AAAA" decodes to 3 zero bytes — no magic-byte signature matches, so the
    // shared upload core rejects it before any storage/db work.
    await expect(upload({ filename: 'x.png', data: 'AAAA' })).rejects.toThrow(/JPEG|PNG|image/i)
  })

  it('rejects malformed base64 instead of silently decoding it', async () => {
    await expect(upload({ filename: 'x.png', data: '%%%=' })).rejects.toThrow(/valid base64/i)
    await expect(
      upload({ filename: 'x.png', data: 'data:image/png,AAAA' }),
    ).rejects.toThrow(/base64 encoding/i)
  })

  it('propagates request cancellation to a remote image download', async () => {
    const controller = new AbortController()
    let started!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let observedSignal: AbortSignal | null = null
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      observedSignal = init?.signal ?? null
      started()
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(observedSignal?.reason),
          { once: true },
        )
      })
    })

    try {
      const pending = upload(
        { filename: 'x.png', sourceUrl: 'https://8.8.8.8/a.png' },
        controller.signal,
      )
      await fetchStarted
      controller.abort()

      await expect(pending).rejects.toThrow(/abort/i)
      expect(observedSignal?.aborted).toBe(true)
    } finally {
      fetchMock.mockRestore()
    }
  })
})
