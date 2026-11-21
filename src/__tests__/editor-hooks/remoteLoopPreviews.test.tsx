/**
 * Previews of plugin loop sources on the canvas.
 *
 * A preview is sample data fetched from the plugin's sandbox, so the editor
 * asks as rarely as it can: once per source, filters and limit, never on a
 * timer, and only for a filter value that was left standing. A loop that has
 * items keeps them while a new answer is on its way and when asking again
 * fails. These tests drive the mounted hook with a stubbed server.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { replaceRemoteLoopSources, resetRemoteLoopSourcesForTests } from '@core/loops'
import {
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_MAX_RETRIES,
  PREVIEW_RETRY_MS,
  syncRemoteLoopPreviews,
  resetRemoteLoopPreviews,
  retryRemoteLoopPreview,
} from '@site/canvas/remoteLoopPreviews'
import { useRemoteLoopPreview } from '@site/canvas/useRemoteLoopPreview'

const SOURCE = 'acme.shop.offers'
const realFetch = globalThis.fetch

type Answer = { status: number; body: unknown; headers?: Record<string, string> } | 'never'
interface Sent { sourceId: string; filters: Record<string, unknown>; limit: number; signal: AbortSignal | null }
let answers: Answer[] = []
let requests: Sent[] = []

function items(...titles: string[]): Answer {
  return { status: 200, body: { items: titles.map((title, i) => ({ id: String(i), fields: { title } })) } }
}
const failure: Answer = { status: 502, body: { error: 'The plugin\'s preview() failed.' } }
const busy: Answer = {
  status: 429,
  body: { error: 'Previews of this plugin are busy.', code: 'preview_busy' },
  headers: { 'retry-after': '3' },
}
/** The source as the editor lists it, under one load (revision) of its plugin. */
function listSource(revision: string): void {
  replaceRemoteLoopSources([{
    id: SOURCE,
    label: 'Offers',
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'title', label: 'Title' }],
    provider: { pluginId: 'acme.shop', pluginName: 'Acme Shop' },
    revision,
  }])
}
const titles = (list: Array<{ fields: Record<string, unknown> }>) => list.map((item) => item.fields.title)

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
  listSource('r1')
  answers = []
  requests = []
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null
    requests.push({ ...JSON.parse(String(init?.body)), signal })
    const answer = answers.shift() ?? items('default')
    if (answer === 'never') {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }
    return Promise.resolve(new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...answer.headers },
    }))
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  resetRemoteLoopPreviews()
  resetRemoteLoopSourcesForTests()
  jest.useRealTimers()
  globalThis.fetch = realFetch
})

describe('useRemoteLoopPreview', () => {
  it('stays idle and asks nothing for a loop that is not on a plugin source', async () => {
    const { result } = renderHook(() => useRemoteLoopPreview(null, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS * 2)
    expect(result.current.preview).toEqual({ status: 'idle' })
    expect(requests).toEqual([])
  })

  it('asks once for loops that share a source, filters and limit', async () => {
    answers = [items('Sample')]
    const first = renderHook(() => useRemoteLoopPreview(SOURCE, { currency: 'eur' }, 3))
    const second = renderHook(() => useRemoteLoopPreview(SOURCE, { currency: 'eur' }, 3))
    expect(first.result.current.preview).toEqual({ status: 'loading' })

    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ sourceId: SOURCE, filters: { currency: 'eur' }, limit: 3 })
    expect(titles(first.result.current.items)).toEqual(['Sample'])
    expect(second.result.current.items).toBe(first.result.current.items)
  })

  it('sends one request for a filter value typed a key at a time', async () => {
    const typed = 'a fairly long currency filter value, 42 chars'
    const { rerender } = renderHook(({ currency }) => useRemoteLoopPreview(SOURCE, { currency }, 3), {
      initialProps: { currency: '' },
    })
    for (let i = 1; i <= typed.length; i++) {
      rerender({ currency: typed.slice(0, i) })
      // Slower than a fast typist, faster than the wait.
      await advance(450)
    }
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests.map((request) => request.filters.currency)).toEqual([typed])
  })

  it('cancels a request that was overtaken while on its way', async () => {
    answers = ['never', items('Second')]
    const { rerender, result } = renderHook(({ currency }) => useRemoteLoopPreview(SOURCE, { currency }, 3), {
      initialProps: { currency: 'eur' },
    })
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.signal?.aborted).toBe(false)

    rerender({ currency: 'usd' })
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests[0]!.signal?.aborted).toBe(true)
    expect(requests.map((request) => request.filters.currency)).toEqual(['eur', 'usd'])
    expect(titles(result.current.items)).toEqual(['Second'])
  })

  it('never asks again by itself: an editor left alone makes no requests', async () => {
    answers = [items('Sample')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    await advance(60 * 60 * 1000)
    expect(requests).toHaveLength(1)
    expect(titles(result.current.items)).toEqual(['Sample'])
  })

  it('answers a loop that comes back with what it already knows', async () => {
    answers = [items('Sample')]
    const first = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    first.unmount()

    const second = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS * 2)
    expect(requests).toHaveLength(1)
    expect(titles(second.result.current.items)).toEqual(['Sample'])
  })

  it('keeps the items on screen while a changed filter is loading, and if that answer fails', async () => {
    answers = [items('Euro offer'), failure, failure, failure, failure]
    const { rerender, result } = renderHook(({ currency }) => useRemoteLoopPreview(SOURCE, { currency }, 3), {
      initialProps: { currency: 'eur' },
    })
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(titles(result.current.items)).toEqual(['Euro offer'])

    rerender({ currency: 'usd' })
    expect(result.current.preview.status).toBe('loading')
    expect(titles(result.current.items)).toEqual(['Euro offer'])

    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current.preview.status).toBe('failed')
    expect(titles(result.current.items)).toEqual(['Euro offer'])
  })

  it('keeps a loop\'s items when asking again fails', async () => {
    answers = [items('Version 1'), failure, failure, failure, failure]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)

    // The plugin was loaded again and the preview is asked for again, without luck.
    act(() => { listSource('r2'); syncRemoteLoopPreviews() })
    await settle()
    for (let i = 0; i < PREVIEW_MAX_RETRIES; i++) await advance(PREVIEW_RETRY_MS * 2 ** i)
    expect(requests).toHaveLength(2 + PREVIEW_MAX_RETRIES)
    expect(result.current.preview.status).toBe('ready')
    expect(titles(result.current.items)).toEqual(['Version 1'])
  })

  it('gives a mounted loop the new answer when its plugin was loaded again', async () => {
    answers = [items('Version 1'), items('Version 2')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(titles(result.current.items)).toEqual(['Version 1'])

    // The same list again asks nothing.
    act(() => syncRemoteLoopPreviews())
    await settle()
    expect(requests).toHaveLength(1)

    // Same source id and descriptor, upgraded plugin: no timer has run out,
    // the loop never unmounted.
    act(() => { listSource('r2'); syncRemoteLoopPreviews() })
    await settle()
    expect(requests).toHaveLength(2)
    expect(titles(result.current.items)).toEqual(['Version 2'])
  })

  it('asks again for a loop that comes back after its plugin was upgraded meanwhile', async () => {
    answers = [items('Version 1'), items('Version 2')]
    const first = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    first.unmount()

    // Nobody shows the preview while the plugin is upgraded: the old sample is forgotten.
    act(() => { listSource('r2'); syncRemoteLoopPreviews() })
    const second = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    expect(second.result.current.items).toEqual([])
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(requests).toHaveLength(2)
    expect(titles(second.result.current.items)).toEqual(['Version 2'])
  })

  it('leaves another loop\'s newer question alone when an older holder lets go', async () => {
    answers = [failure, failure, failure, failure, items('Fresh')]
    const first = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    for (let i = 0; i < PREVIEW_MAX_RETRIES; i++) await advance(PREVIEW_RETRY_MS * 2 ** i)
    // The failed question is dropped while still held, and asked afresh by a second loop.
    act(() => resetRemoteLoopPreviews())
    const second = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    first.unmount()
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(titles(second.result.current.items)).toEqual(['Fresh'])
  })

  it('waits out a busy answer for as long as the server says, without calling it a failure', async () => {
    answers = [busy, items('Sample')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current.preview).toEqual({ status: 'busy' })

    await advance(2_999)
    expect(requests).toHaveLength(1)
    await advance(1)
    expect(requests).toHaveLength(2)
    expect(titles(result.current.items)).toEqual(['Sample'])
  })

  it('does not start the retries over because another loop shows the same failed preview', async () => {
    answers = [failure, failure, failure, failure]
    const first = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    for (let i = 0; i < PREVIEW_MAX_RETRIES; i++) await advance(PREVIEW_RETRY_MS * 2 ** i)
    expect(first.result.current.preview).toMatchObject({ status: 'failed', final: true })

    const second = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(60 * 1000)
    expect(requests).toHaveLength(1 + PREVIEW_MAX_RETRIES)
    expect(second.result.current.preview).toMatchObject({ status: 'failed', final: true })
  })

  it('caps a wait the server asks for at a minute', async () => {
    answers = [{ ...(busy as Exclude<Answer, 'never'>), headers: { 'retry-after': '999999999' } }, items('Sample')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current.preview).toEqual({ status: 'busy' })
    await advance(60_000)
    expect(titles(result.current.items)).toEqual(['Sample'])
  })

  it('retries a failure a few times, then stops until the author asks', async () => {
    answers = [failure, failure, failure, failure, items('Recovered')]
    const { result } = renderHook(() => useRemoteLoopPreview(SOURCE, {}, 3))
    await advance(PREVIEW_DEBOUNCE_MS)
    expect(result.current.preview).toEqual({
      status: 'failed', error: 'The plugin\'s preview() failed.', final: false,
    })

    for (let i = 0; i < PREVIEW_MAX_RETRIES; i++) await advance(PREVIEW_RETRY_MS * 2 ** i)
    expect(requests).toHaveLength(1 + PREVIEW_MAX_RETRIES)
    expect(result.current.preview).toMatchObject({ status: 'failed', final: true })

    // Nothing more by itself, however long the loop stays on screen.
    await advance(60 * 60 * 1000)
    expect(requests).toHaveLength(1 + PREVIEW_MAX_RETRIES)

    act(() => retryRemoteLoopPreview({ sourceId: SOURCE, filters: {}, limit: 3 }))
    await settle()
    expect(titles(result.current.items)).toEqual(['Recovered'])
  })
})
