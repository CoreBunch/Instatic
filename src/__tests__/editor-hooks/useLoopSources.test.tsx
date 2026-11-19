/**
 * The editor's loop source hooks follow the registry.
 *
 * A plugin's sources reach the editor after it has rendered, and leave again
 * when the plugin is disabled. A component that asked `useLoopSources`,
 * `useLoopSource` or `useLoopSourceMissing` must be given the new answer each
 * time, with no remount: these tests keep one rendered hook and move the
 * registry under it.
 */
import '@core/loops/sources'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import {
  replaceRemoteLoopSources,
  resetRemoteLoopSourcesForTests,
  type RemoteLoopSource,
} from '@core/loops'
import {
  loopSourceLabel,
  useLoopSource,
  useLoopSourceMissing,
  useLoopSources,
} from '@site/hooks/useLoopSources'

const OFFERS = 'acme.shop.offers'

function remote(id: string, label: string): RemoteLoopSource {
  return {
    id,
    label,
    filterSchema: {},
    orderByOptions: [],
    fields: [{ id: 'title', label: 'Title' }],
    provider: { pluginId: 'acme.shop', pluginName: 'Acme Shop' },
    revision: 'r1',
  }
}

beforeEach(() => {
  resetRemoteLoopSourcesForTests()
})

afterEach(() => {
  cleanup()
  resetRemoteLoopSourcesForTests()
})

describe('useLoopSources', () => {
  it('lists a plugin source that arrives after the first render, after the built-in ones', () => {
    const { result } = renderHook(() => useLoopSources())
    const builtIn = result.current.map((source) => source.id)
    expect(builtIn).toContain('data.rows')
    expect(builtIn).not.toContain(OFFERS)

    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Offers')]))
    expect(result.current.map((source) => source.id)).toEqual([...builtIn, OFFERS])
    expect(loopSourceLabel(result.current.at(-1)!)).toBe('Acme Shop: Offers')
  })

  it('follows a replaced source and a removed one', () => {
    const { result } = renderHook(() => useLoopSources())
    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Offers')]))
    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Plans')]))
    expect(result.current.find((source) => source.id === OFFERS)?.label).toBe('Plans')

    act(() => replaceRemoteLoopSources([]))
    expect(result.current.some((source) => source.id === OFFERS)).toBe(false)
  })
})

describe('useLoopSource', () => {
  it('finds a source once it is registered, with the id unchanged, and loses it when it goes', () => {
    const { result } = renderHook(() => useLoopSource(OFFERS))
    expect(result.current).toBeUndefined()

    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Offers')]))
    expect(result.current?.label).toBe('Offers')

    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Plans')]))
    expect(result.current?.label).toBe('Plans')

    act(() => replaceRemoteLoopSources([]))
    expect(result.current).toBeUndefined()
  })
})

describe('useLoopSourceMissing', () => {
  it('waits for the server\'s list before calling a source missing', () => {
    const { result } = renderHook(() => useLoopSourceMissing(OFFERS))
    // The list has not arrived: the source may still be on its way.
    expect(result.current).toBe(false)

    // The list arrives late and has the source.
    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Offers')]))
    expect(result.current).toBe(false)

    // The plugin is disabled: now it is missing.
    act(() => replaceRemoteLoopSources([]))
    expect(result.current).toBe(true)

    // And enabled again.
    act(() => replaceRemoteLoopSources([remote(OFFERS, 'Offers')]))
    expect(result.current).toBe(false)
  })

  it('calls a source missing when the list arrives without it', () => {
    const { result } = renderHook(() => useLoopSourceMissing(OFFERS))
    act(() => replaceRemoteLoopSources([]))
    expect(result.current).toBe(true)
  })

  it('never calls an unset source or a built-in one missing', () => {
    const unset = renderHook(() => useLoopSourceMissing(''))
    const builtIn = renderHook(() => useLoopSourceMissing('data.rows'))
    act(() => replaceRemoteLoopSources([]))
    expect(unset.result.current).toBe(false)
    expect(builtIn.result.current).toBe(false)
  })
})
