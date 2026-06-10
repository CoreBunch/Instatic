import { afterEach, describe, expect, it } from 'bun:test'
import { canonicalPluginEventName, hookBus } from '@core/plugins/hookBus'

afterEach(() => {
  hookBus.reset()
})

describe('hookBus', () => {
  it('fires events to every registered listener in registration order', async () => {
    const calls: string[] = []
    hookBus.on('plugin.acme.x', 'publish.before', (payload) => {
      calls.push(`acme:${JSON.stringify(payload)}`)
    })
    hookBus.on('plugin.zeta.x', 'publish.before', (payload) => {
      calls.push(`zeta:${JSON.stringify(payload)}`)
    })

    await hookBus.emit('publish.before', { siteId: 's1', pageId: 'p1' })
    expect(calls).toEqual([
      'acme:{"siteId":"s1","pageId":"p1"}',
      'zeta:{"siteId":"s1","pageId":"p1"}',
    ])
  })

  it('runs filters in order, threading the previous handler\'s output', async () => {
    hookBus.filter('plugin.a', 'publish.html', (value) => `${value}-a`)
    hookBus.filter('plugin.b', 'publish.html', (value) => `${value}-b`)
    expect(await hookBus.applyFilter('publish.html', 'base')).toBe('base-a-b')
  })

  it('isolates listener errors so other listeners still run', async () => {
    const calls: string[] = []
    hookBus.on('plugin.bad', 'plugin.x.evt', () => {
      throw new Error('boom')
    })
    hookBus.on('plugin.good', 'plugin.x.evt', () => {
      calls.push('good')
    })
    await hookBus.emit('plugin.x.evt', {})
    expect(calls).toEqual(['good'])
  })

  it('falls back to the previous value if a filter throws', async () => {
    hookBus.filter('plugin.bad', 'pipe', () => {
      throw new Error('nope')
    })
    hookBus.filter('plugin.good', 'pipe', (value) => `${value}-good`)
    expect(await hookBus.applyFilter('pipe', 'seed')).toBe('seed-good')
  })

  it('delivers host emits of core events to listeners on the bare core name', async () => {
    const seen: unknown[] = []
    hookBus.on('acme.x', 'settings.changed', (payload) => {
      seen.push(payload)
    })
    await hookBus.emit('settings.changed', { pluginId: 'acme.x' })
    expect(seen).toEqual([{ pluginId: 'acme.x' }])
  })

  it('unregisterPlugin removes both events and filters for that plugin id', async () => {
    hookBus.on('plugin.x', 'evt', () => {})
    hookBus.filter('plugin.x', 'pipe', (v) => v)
    hookBus.on('plugin.y', 'evt', () => {})
    hookBus.unregisterPlugin('plugin.x')

    expect(hookBus.hasListenersFor('evt')).toBe(true) // y still registered
    expect(hookBus.hasFiltersFor('pipe')).toBe(false)
  })
})

describe('canonicalPluginEventName', () => {
  it('namespaces a bare event name to plugin.<id>.<name>', () => {
    expect(canonicalPluginEventName('acme.x', 'sync.done')).toBe('plugin.acme.x.sync.done')
  })

  it('namespaces a reserved core name so it cannot reach core-name listeners', async () => {
    const canonical = canonicalPluginEventName('acme.x', 'content.entry.created')
    expect(canonical).toBe('plugin.acme.x.content.entry.created')

    const coreSeen: unknown[] = []
    const namespacedSeen: unknown[] = []
    hookBus.on('victim.plugin', 'content.entry.created', (payload) => {
      coreSeen.push(payload)
    })
    hookBus.on('observer.plugin', canonical, (payload) => {
      namespacedSeen.push(payload)
    })
    await hookBus.emit(canonical, { forged: true })
    expect(coreSeen).toEqual([])
    expect(namespacedSeen).toEqual([{ forged: true }])
  })

  it('does not double-prefix a name already in the plugin\'s own namespace', () => {
    expect(canonicalPluginEventName('acme.x', 'plugin.acme.x.sync.done')).toBe('plugin.acme.x.sync.done')
  })

  it('rejects a name in another plugin\'s namespace (impersonation)', () => {
    expect(() => canonicalPluginEventName('acme.x', 'plugin.zeta.y.sync.done')).toThrow(
      /Plugin "acme\.x" cannot emit "plugin\.zeta\.y\.sync\.done"/,
    )
  })
})
