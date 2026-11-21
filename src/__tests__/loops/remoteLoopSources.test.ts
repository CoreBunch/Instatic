/**
 * Plugin loop sources in the editor's registry.
 *
 * The editor registers what the server lists as `remote` sources. Readers of
 * the registry (the Source picker, field bindings, import warnings) must see
 * them like any other source, hear about every change, and never lose a
 * built-in source to a plugin's descriptor.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import '@core/loops/sources'
import { loopSourceRegistry, replaceRemoteLoopSources, type RemoteLoopSource } from '@core/loops'
import { warningsForNode } from '@core/htmlImport/importWarnings'

function remote(id: string, label = id): RemoteLoopSource {
  return {
    id,
    label,
    filterSchema: {},
    orderByOptions: [{ id: 'name', label: 'Name' }],
    fields: [{ id: 'title', label: 'Title' }],
    provider: { pluginId: 'acme.shop', pluginName: 'Acme Shop' },
    revision: 'r1',
  }
}

afterEach(() => {
  replaceRemoteLoopSources([])
})

describe('replaceRemoteLoopSources', () => {
  it('registers a plugin source as a remote source with its provider', () => {
    replaceRemoteLoopSources([remote('acme.shop.offers', 'Offers')])
    expect(loopSourceRegistry.get('acme.shop.offers')).toEqual({
      ...remote('acme.shop.offers', 'Offers'),
      kind: 'remote',
    })
  })

  it('drops the sources the server no longer lists and keeps the built-in ones', () => {
    const builtIn = loopSourceRegistry.list().filter((source) => source.kind !== 'remote').map((source) => source.id)
    replaceRemoteLoopSources([remote('acme.shop.offers'), remote('acme.shop.invoices')])
    replaceRemoteLoopSources([remote('acme.shop.invoices')])
    expect(loopSourceRegistry.has('acme.shop.offers')).toBe(false)
    expect(loopSourceRegistry.has('acme.shop.invoices')).toBe(true)
    replaceRemoteLoopSources([])
    expect(loopSourceRegistry.list().map((source) => source.id)).toEqual(builtIn)
  })

  it('never lets a plugin descriptor replace an in-process source', () => {
    const dataRows = loopSourceRegistry.get('data.rows')
    replaceRemoteLoopSources([remote('data.rows', 'Not the real one')])
    expect(loopSourceRegistry.get('data.rows')).toBe(dataRows)
  })

  it('makes a plugin source a known source for pasted HTML', () => {
    const props = { sourceId: 'acme.shop.offers', filters: {}, orderBy: 'name' }
    expect(warningsForNode('n1', 'base.loop', props, 1).map((w) => w.kind)).toEqual(['unknown-loop-source'])
    replaceRemoteLoopSources([remote('acme.shop.offers')])
    expect(warningsForNode('n1', 'base.loop', props, 1)).toEqual([])
  })

  it('tells subscribers about every change, and only about changes', () => {
    let calls = 0
    const unsubscribe = loopSourceRegistry.subscribe(() => { calls += 1 })
    const before = loopSourceRegistry.getSnapshot()

    replaceRemoteLoopSources([remote('acme.shop.offers')])
    expect(calls).toBe(1)
    const after = loopSourceRegistry.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.map((source) => source.id)).toContain('acme.shop.offers')

    // Nothing changed: no call, and the very same snapshot.
    loopSourceRegistry.unregister('acme.shop.never-registered')
    expect(calls).toBe(1)
    expect(loopSourceRegistry.getSnapshot()).toBe(after)

    unsubscribe()
    replaceRemoteLoopSources([])
    expect(calls).toBe(1)
  })
})
