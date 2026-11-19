/**
 * Previews of plugin loop sources on the canvas.
 *
 * Several loops share one answer per source, filters and limit. A loop that
 * stays on screen must still see a failed answer retried, a good answer
 * refreshed, and every answer asked for again when the plugins change: the
 * mounted hook follows the store, never a copy it took earlier.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_RETRY_MS,
  PREVIEW_TTL_MS,
  refreshRemoteLoopPreviews,
  resetRemoteLoopPreviews,
} from '@site/canvas/remoteLoopPreviews'
import { useRemoteLoopPreview } from '@site/canvas/useRemoteLoopPreview'

const SOURCE = 'acme.shop.offers'
const realFetch = globalThis.fetch

type Answer = { status: number; body: unknown }
let answers: Answer[] = []
let requests: Array<{ sourceId: string; filters: Record<string, unknown>; limit: number }> = []

function items(...titles: string[]): Answer {
  return { status: 200, body: { items: titles.map((title, i) => ({ id: String(i), fields: { title } })) } }
}

/** Let the pending request and the store's reaction to it finish. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms)
  })
  await settle()
}

beforeEach(() => {
  jest.useFakeTimers()
  answers = []
  requests = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    const answer = answers.shift() ?? items('default')
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  resetRemoteLoopPreviews()
  jest.useRealTimers()
  globalThis.fetch = realFetch
})

describe('useRemoteLoopPreview', () => {
  it('stays idle and asks nothing for a loop that is not on a plugin source', async () => {
    const { result } = renderHook(() => useRemoteLoopPreview(null, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS * 2)
    expect(result.current).toEqual({ status: 'idle' })
    expect(requests).toEqual([])
  })

  it('asks once for loops that share a source, filters and limit', async () => {
    answers = [items('Sample')]
    const first = renderHook(() => useRemoteLoopPreview(SOURCE, { currency: 'eur' }, 3))
    const second = renderHook(() => useRemoteLoopPreview(SOURCE, { currency: 'eur' }, 3))
    expect(first.result.current).toEqual({ status: 'loading' })

    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests).toEqual([{ sourceId: SOURCE, filters: { currency: 'eur' }, limit: 3 }])
    expect(first.result.current).toEqual({ status: 'ready', items: [{ id: '0', fields: { title: 'Sample' } }] })
    expect(second.result.current).toBe(first.result.current)
  })

  it('does not ask for a filter value that was typed over before the wait ended', async () => {
    const { rerender } = renderHook(({ currency }) => useRemoteLoopPreview(SOURCE, { currency }, 3), {
      initialProps: { currency: 'e' },
    })
    await advance(PREVIEW_DEBOUNCE_MS / 2)
    rerender({ currency: 'eu' })
    await advance(PREVIEW_DEBOUNCE_MS / 2)
    rerender({ currency: 'eur' })
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests.map((request) => request.filters.currency)).toEqual(['eur'])
  })

  it('retries a failed preview by itself while the loop is on screen', async () => {
    answers = [{ status: 502, body: { error: 'The plugin\'s preview() failed.' } }, items('Recovered')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current).toEqual({ status: 'failed', error: 'The plugin\'s preview() failed.' })

    await advance(PREVIEW_RETRY_MS)
    expect(requests).toHaveLength(2)
    expect(result.current).toEqual({ status: 'ready', items: [{ id: '0', fields: { title: 'Recovered' } }] })
  })

  it('asks again when an answer has aged, with the loop still on screen', async () => {
    answers = [items('Old'), items('New')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current).toMatchObject({ status: 'ready', items: [{ fields: { title: 'Old' } }] })

    await advance(PREVIEW_TTL_MS - 1)
    expect(requests).toHaveLength(1)
    await advance(1)
    expect(requests).toHaveLength(2)
    expect(result.current).toMatchObject({ status: 'ready', items: [{ fields: { title: 'New' } }] })
  })

  it('gives a mounted loop the new answer when the plugins changed', async () => {
    answers = [items('Version 1'), items('Version 2')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current).toMatchObject({ status: 'ready', items: [{ fields: { title: 'Version 1' } }] })

    // Same source id, upgraded plugin: no timer has run out, the loop never unmounted.
    act(() => refreshRemoteLoopPreviews())
    await settle()
    expect(requests).toHaveLength(2)
    expect(result.current).toMatchObject({ status: 'ready', items: [{ fields: { title: 'Version 2' } }] })
  })

  it('stops asking once no loop shows the preview', async () => {
    answers = [items('Sample')]
    const { unmount } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    unmount()
    await advance(PREVIEW_TTL_MS * 3)
    expect(requests).toHaveLength(1)
  })
})
