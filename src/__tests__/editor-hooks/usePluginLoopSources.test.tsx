/**
 * The editor's list of plugin loop sources and when it is fetched again.
 *
 * Nothing is pushed from the server, so the editor asks: when it mounts, when
 * its own tab changed the plugins, when the tab is shown again, and when a
 * preview is refused because nobody provides the source any more.
 */
import '@core/loops/sources'
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  loopSourceRegistry,
  resetRemoteLoopSourcesForTests,
  type RemoteLoopSource,
} from '@core/loops'
import { CMS_PLUGINS_CHANGED_EVENT } from '@plugins/utils/pluginEvents'
import { LOOP_SOURCES_STALE_EVENT } from '@site/canvas/loopSourceEvents'
import { PREVIEW_DEBOUNCE_MS, resetRemoteLoopPreviews } from '@site/canvas/remoteLoopPreviews'
import { useRemoteLoopPreview } from '@site/canvas/useRemoteLoopPreview'
import { usePluginLoopSources } from '@site/hooks/usePluginLoopSources'

const OFFERS = 'acme.shop.offers'
const realFetch = globalThis.fetch

function remote(label = 'Offers', revision = 'r1'): RemoteLoopSource {
  return {
    id: OFFERS,
    label,
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'title', label: 'Title' }],
    provider: { pluginId: 'acme.shop', pluginName: 'Acme Shop' },
    revision,
  }
}

let listed: RemoteLoopSource[] = []
let listRequests = 0
let previewRequests = 0
let previewStatus = 200
let sample = 'Sample'

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  resetRemoteLoopSourcesForTests()
  listed = [remote()]
  listRequests = 0
  previewRequests = 0
  previewStatus = 200
  sample = 'Sample'
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const json = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    if (String(input).endsWith('/loop-sources/preview')) {
      previewRequests += 1
      return previewStatus === 200
        ? json(200, { items: [{ id: '1', fields: { title: sample } }] })
        : json(previewStatus, { error: 'No running plugin provides this loop source.' })
    }
    listRequests += 1
    return json(200, { sources: listed })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  resetRemoteLoopPreviews()
  resetRemoteLoopSourcesForTests()
  jest.useRealTimers()
  globalThis.fetch = realFetch
})

describe('usePluginLoopSources', () => {
  it('registers what the server lists when the editor mounts', async () => {
    renderHook(() => usePluginLoopSources())
    await settle()
    expect(listRequests).toBe(1)
    expect(loopSourceRegistry.get(OFFERS)).toMatchObject({ kind: 'remote', label: 'Offers' })
  })

  it('fetches again when this tab changed the plugins and when the tab is shown again', async () => {
    renderHook(() => usePluginLoopSources())
    await settle()

    listed = []
    act(() => { window.dispatchEvent(new Event(CMS_PLUGINS_CHANGED_EVENT)) })
    await settle()
    expect(listRequests).toBe(2)
    expect(loopSourceRegistry.has(OFFERS)).toBe(false)

    listed = [remote('Plans')]
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(listRequests).toBe(3)
    expect(loopSourceRegistry.get(OFFERS)?.label).toBe('Plans')
  })

  it('tells nobody when the same list comes back', async () => {
    renderHook(() => usePluginLoopSources())
    await settle()
    const before = loopSourceRegistry.getSnapshot()
    let changes = 0
    const stop = loopSourceRegistry.subscribe(() => { changes += 1 })

    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    stop()
    expect(listRequests).toBe(2)
    expect(changes).toBe(0)
    expect(loopSourceRegistry.getSnapshot()).toBe(before)
  })

  it('fetches the list again when a preview is refused because nobody provides the source', async () => {
    renderHook(() => usePluginLoopSources())
    await settle()

    // The plugin was disabled elsewhere: the server has no such source any more.
    listed = []
    previewStatus = 404
    let staleEvents = 0
    const count = () => { staleEvents += 1 }
    window.addEventListener(LOOP_SOURCES_STALE_EVENT, count)

    renderHook(() => useRemoteLoopPreview(OFFERS, {}, 3))
    await act(async () => { jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    await settle()
    window.removeEventListener(LOOP_SOURCES_STALE_EVENT, count)

    expect(previewRequests).toBe(1)
    expect(staleEvents).toBe(1)
    // The fetch follows a moment later, so refusals close together share it.
    expect(listRequests).toBe(1)
    await act(async () => { jest.advanceTimersByTime(100) })
    await settle()
    expect(listRequests).toBe(2)
    expect(loopSourceRegistry.has(OFFERS)).toBe(false)

    // A worker that restarted registers its sources again within moments, so
    // the list is fetched once more shortly after, and then left alone.
    listed = [remote('Offers', 'r2')]
    previewStatus = 200
    await act(async () => { jest.advanceTimersByTime(2_000) })
    await settle()
    expect(listRequests).toBe(3)
    expect(loopSourceRegistry.has(OFFERS)).toBe(true)
    await act(async () => { jest.advanceTimersByTime(60_000) })
    await settle()
    expect(listRequests).toBe(3)
  })

  it('fetches the list once when every loop of a page is refused at once', async () => {
    renderHook(() => usePluginLoopSources())
    await settle()
    act(() => {
      for (let i = 0; i < 12; i++) window.dispatchEvent(new Event(LOOP_SOURCES_STALE_EVENT))
    })
    await act(async () => { jest.advanceTimersByTime(100) })
    await settle()
    expect(listRequests).toBe(2)
    // And once more shortly after, not twelve times.
    await act(async () => { jest.advanceTimersByTime(2_000) })
    await settle()
    expect(listRequests).toBe(3)
  })

  it('asks a shown preview again only when its plugin was loaded again', async () => {
    renderHook(() => usePluginLoopSources())
    await settle()
    const shown = renderHook(() => useRemoteLoopPreview(OFFERS, {}, 3))
    await act(async () => { jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    await settle()
    expect(previewRequests).toBe(1)

    // The same list: nothing to ask.
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(previewRequests).toBe(1)

    // An upgrade: the descriptor is the same, the revision and the samples are new.
    listed = [remote('Offers', 'r2')]
    sample = 'Sample from version 2'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(previewRequests).toBe(2)
    expect(shown.result.current.items.map((item) => item.fields.title)).toEqual(['Sample from version 2'])
  })

  it('shows new samples after an upgrade that happened while the editor was closed', async () => {
    const editor = renderHook(() => usePluginLoopSources())
    await settle()
    const loop = renderHook(() => useRemoteLoopPreview(OFFERS, {}, 3))
    await act(async () => { jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    await settle()
    expect(loop.result.current.items.map((item) => item.fields.title)).toEqual(['Sample'])

    // The author leaves the Site editor; the plugin is upgraded; they come back.
    loop.unmount()
    editor.unmount()
    listed = [remote('Offers', 'r2')]
    sample = 'Sample from version 2'
    renderHook(() => usePluginLoopSources())
    await settle()
    const again = renderHook(() => useRemoteLoopPreview(OFFERS, {}, 3))
    await act(async () => { jest.advanceTimersByTime(PREVIEW_DEBOUNCE_MS) })
    await settle()
    expect(again.result.current.items.map((item) => item.fields.title)).toEqual(['Sample from version 2'])
  })
})
