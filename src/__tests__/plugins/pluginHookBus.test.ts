import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { canonicalPluginEventName, hookBus, OWNER_ONLY_HOOK_EVENTS } from '@core/plugins/hookBus'

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

    await hookBus.emit('publish.before', { siteId: 's1', pageId: 'p1' }, 'everyone')
    expect(calls).toEqual([
      'acme:{"siteId":"s1","pageId":"p1"}',
      'zeta:{"siteId":"s1","pageId":"p1"}',
    ])
  })

  it('runs filters in order, threading the previous handler\'s output', async () => {
    hookBus.filter('plugin.a', 'publish.html', (value) => `${value}-a`)
    hookBus.filter('plugin.b', 'publish.html', (value) => `${value}-b`)
    expect(await hookBus.applyFilter('publish.html', 'base', {}, 'everyone')).toBe('base-a-b')
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

  it('falls back to the previous HTML if a filter returns null', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      hookBus.filter('plugin.bad', 'publish.html', () => null)
      hookBus.filter('plugin.good', 'publish.html', (value) => `${value}-good`)

      expect(await hookBus.applyFilter('publish.html', '<main>page</main>', {}, 'everyone')).toBe(
        '<main>page</main>-good',
      )
      expect(errorLog).toHaveBeenCalledWith(
        '[plugin:plugin.bad] filter "publish.html" returned a different value type; keeping the previous value.',
      )
    } finally {
      errorLog.mockRestore()
    }
  })

  it('delivers host emits of core events to listeners on the bare core name', async () => {
    const seen: unknown[] = []
    hookBus.on('acme.x', 'publish.after', (payload) => {
      seen.push(payload)
    })
    await hookBus.emit('publish.after', { siteId: 's1' }, 'everyone')
    expect(seen).toEqual([{ siteId: 's1' }])
  })

  it('emitTo runs only the named plugin\'s listeners', async () => {
    const heard: string[] = []
    hookBus.on('acme.owner', 'settings.changed', () => {
      heard.push('owner')
    })
    hookBus.on('acme.other', 'settings.changed', () => {
      heard.push('other')
    })
    await hookBus.emitTo('acme.owner', 'settings.changed', { pluginId: 'acme.owner' })
    expect(heard).toEqual(['owner'])
  })

  it('emitTo refuses a payload that carries more than the event allows', async () => {
    const heard: unknown[] = []
    hookBus.on('acme.owner', 'settings.changed', (payload) => {
      heard.push(payload)
    })
    await expect(
      hookBus.emitTo('acme.owner', 'settings.changed', { pluginId: 'acme.owner', settings: { apiKey: 'sk' } }),
    ).rejects.toThrow('"settings.changed" payload may not carry: settings')
    // Told about another plugin's settings: refused too.
    await expect(
      hookBus.emitTo('acme.owner', 'settings.changed', { pluginId: 'acme.other' }),
    ).rejects.toThrow('goes to it alone')
    await expect(hookBus.emitTo('acme.owner', 'mail.failed', 'text')).rejects.toThrow('payload must be an object')
    expect(heard).toEqual([])
  })

  it('refuses to broadcast an event that is for one plugin only', async () => {
    const heard: string[] = []
    for (const event of OWNER_ONLY_HOOK_EVENTS) {
      hookBus.on('acme.other', event, () => {
        heard.push(event)
      })
      // The type already refuses these names; a cast must not get past it.
      const emitAnything = hookBus.emit.bind(hookBus) as (event: string, payload: unknown) => Promise<void>
      await expect(emitAnything(event, { pluginId: 'acme.owner' })).rejects.toThrow(
        `"${event}" is for one plugin only`,
      )
    }
    expect(heard).toEqual([])
  })

  it('refuses a guarded send that does not name its recipients, however the bus is typed', async () => {
    const heard: string[] = []
    // A value typed more loosely than the bus gets past the overloads.
    const loose: {
      emit(event: string, payload: unknown, recipients?: unknown): Promise<void>
      applyFilter(name: string, value: unknown, context?: unknown, recipients?: unknown): Promise<unknown>
    } = hookBus
    for (const event of ['content.entry.updated', 'content.entry.created', 'content.entry.deleted', 'member.created', 'member.tagged']) {
      hookBus.on('acme.other', event, () => {
        heard.push(event)
      })
      await expect(loose.emit(event, { secret: true })).rejects.toThrow('must be sent with a recipient check')
      await expect(loose.emit(event, { secret: true }, 'everyone')).rejects.toThrow('must be sent with a recipient check')
    }
    hookBus.on('acme.other', 'publish.after', () => {
      heard.push('publish.after')
    })
    await expect(loose.emit('publish.after', {})).rejects.toThrow("must say who it is for")

    hookBus.filter('acme.other', 'content.entry.cells', (cells) => {
      heard.push('cells')
      return cells
    })
    hookBus.filter('acme.other', 'publish.html', (html) => {
      heard.push('html')
      return html
    })
    await expect(loose.applyFilter('content.entry.cells', {}, {})).rejects.toThrow('must be sent with a recipient check')
    await expect(loose.applyFilter('content.entry.cells', {}, {}, 'everyone')).rejects.toThrow('recipient check')
    await expect(loose.applyFilter('publish.html', '', {})).rejects.toThrow('must say who it is for')
    expect(heard).toEqual([])

    // With recipients named, the sends go through.
    await loose.emit('content.entry.updated', {}, () => true)
    await loose.emit('publish.after', {}, 'everyone')
    await loose.applyFilter('content.entry.cells', {}, {}, () => true)
    expect(heard).toEqual(['content.entry.updated', 'publish.after', 'cells'])
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
