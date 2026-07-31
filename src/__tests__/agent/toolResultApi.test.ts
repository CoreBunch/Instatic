import { describe, expect, it } from 'bun:test'
import { postToolResult } from '@admin/ai/toolResultApi'

function abortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = implementation
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

describe('postToolResult', () => {
  it('rejects an active 404 bridge failure with the server error', async () => {
    const controller = new AbortController()

    await withFetch(
      (async () => new Response(
        JSON.stringify({ error: 'The active tool bridge no longer exists.' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch,
      async () => {
        await expect(postToolResult(
          'bridge-1',
          'request-1',
          { ok: true },
          controller.signal,
        )).rejects.toThrow('The active tool bridge no longer exists.')
      },
    )
  })

  it('rejects other failures while the bridge is active', async () => {
    const controller = new AbortController()

    await withFetch(
      (async () => new Response(
        JSON.stringify({ error: 'Tool-result storage failed.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch,
      async () => {
        await expect(postToolResult(
          'bridge-1',
          'request-1',
          { ok: true },
          controller.signal,
        )).rejects.toThrow('Tool-result storage failed.')
      },
    )
  })

  it('keeps an already-aborted teardown quiet', async () => {
    const controller = new AbortController()
    controller.abort()

    await withFetch(
      (async () => {
        throw abortError()
      }) as typeof fetch,
      async () => {
        await expect(postToolResult(
          'bridge-1',
          'request-1',
          { ok: true },
          controller.signal,
        )).resolves.toBeUndefined()
      },
    )
  })

  it('does not hide an abort failure while the bridge remains active', async () => {
    const controller = new AbortController()

    await withFetch(
      (async () => {
        throw abortError()
      }) as typeof fetch,
      async () => {
        await expect(postToolResult(
          'bridge-1',
          'request-1',
          { ok: true },
          controller.signal,
        )).rejects.toThrow('The operation was aborted.')
      },
    )
  })
})
