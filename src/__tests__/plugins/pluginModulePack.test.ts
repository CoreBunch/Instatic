import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  activatePluginModulePack,
  activateSandboxedPluginModulePack,
  deactivatePluginModulePack,
  listPluginRegisteredModuleIds,
  resetPluginModulePacks,
  type SandboxedModulePack,
} from '@core/plugins/modulePackLoader'
import {
  pluginModuleToHostModule,
  validatePluginModuleId,
  PluginModuleValidationError,
} from '@core/plugins/moduleAdapter'
import { registry } from '@core/module-engine'
import type { PluginManifest } from '@core/plugin-sdk'

const sampleManifest: PluginManifest = {
  id: 'acme.canvas',
  name: 'Canvas Pack',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['modules.register'],
  grantedPermissions: ['modules.register'],
  resources: [],
  adminPages: [],
}

const counterDefinition = {
  id: 'acme.canvas.counter',
  name: 'Counter',
  category: 'Acme Pack',
  version: '1.0.0',
  defaults: { count: 0 },
  schema: {
    count: { type: 'number' as const, label: 'Count', min: 0 },
  },
  render: (props: Record<string, unknown>) => ({
    html: `<div class="counter">${String(props.count ?? 0)}</div>`,
  }),
}

beforeEach(() => {
  resetPluginModulePacks()
})

afterEach(() => {
  resetPluginModulePacks()
})

function makeStubPack(pluginId: string, onDispose: () => void): SandboxedModulePack {
  return {
    pluginId,
    modules: [
      {
        id: 'acme.canvas.counter',
        name: 'Counter',
        category: 'Acme Pack',
        version: '1.0.0',
        defaults: {},
        schema: {},
        hasPreview: false,
      },
    ],
    render: () => ({ html: '' }),
    preview: () => ({ html: '' }),
    dispose: onDispose,
  }
}

// ISS-033: server-side QuickJS module-pack contexts must be disposed on every
// lifecycle teardown, otherwise each activate/upgrade/restart cycle leaks a
// native context for the host-process lifetime.
describe('sandboxed module-pack VM disposal', () => {
  it('disposes the VM on deactivate', () => {
    let disposed = 0
    activateSandboxedPluginModulePack(sampleManifest, makeStubPack('acme.canvas', () => { disposed++ }))
    deactivatePluginModulePack('acme.canvas')
    expect(disposed).toBe(1)
  })

  it('disposes the prior VM when the pack is re-activated', () => {
    let disposedFirst = 0
    activateSandboxedPluginModulePack(sampleManifest, makeStubPack('acme.canvas', () => { disposedFirst++ }))
    activateSandboxedPluginModulePack(sampleManifest, makeStubPack('acme.canvas', () => {}))
    expect(disposedFirst).toBe(1)
  })

  it('disposes every VM on reset', () => {
    let disposed = 0
    activateSandboxedPluginModulePack(sampleManifest, makeStubPack('acme.canvas', () => { disposed++ }))
    resetPluginModulePacks()
    expect(disposed).toBe(1)
  })
})

describe('pluginModuleToHostModule', () => {
  it('produces a host module definition that delegates render to the plugin', () => {
    const hostModule = pluginModuleToHostModule('acme.canvas', counterDefinition, () => () => null, [])
    expect(hostModule.id).toBe('acme.canvas.counter')
    expect(hostModule.trusted).toBe(false)
    expect(hostModule.render({ count: 5 }, [])).toEqual({
      html: '<div class="counter">5</div>',
    })
  })

  it('rejects module ids that do not start with the plugin id', () => {
    expect(() =>
      pluginModuleToHostModule('acme.canvas', { ...counterDefinition, id: 'evil.canvas.counter' }, () => () => null, []),
    ).toThrow(PluginModuleValidationError)
    expect(() =>
      pluginModuleToHostModule('acme.canvas', { ...counterDefinition, id: 'base.text' }, () => () => null, []),
    ).toThrow(PluginModuleValidationError)
  })

  it('accepts the bare plugin-id as namespace and a kebab-case name segment', () => {
    expect(() =>
      validatePluginModuleId('acme.canvas', 'acme.canvas.fancy-card'),
    ).not.toThrow()
  })

  it('rejects modules without render', () => {
    expect(() =>
      pluginModuleToHostModule('acme.canvas', { ...counterDefinition, render: undefined as unknown as typeof counterDefinition.render }, () => () => null, []),
    ).toThrow(/must export a render/)
  })

  it('drops render() js without the frontend.assets grant and warns once per module', () => {
    const jsDefinition = {
      ...counterDefinition,
      id: 'acme.canvas.jsy',
      render: () => ({ html: '<div></div>', js: '(function(){})();' }),
    }
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    try {
      const hostModule = pluginModuleToHostModule('acme.canvas', jsDefinition, () => () => null, [])
      expect(hostModule.render({}, []).js).toBeUndefined()
      expect(hostModule.render({}, []).js).toBeUndefined()
      expect(warnings.filter((w) => w.includes('frontend.assets')).length).toBe(1)
      expect(warnings[0]).toContain('[plugin-module:acme.canvas.jsy]')
    } finally {
      console.warn = originalWarn
    }
  })

  it('passes render() js through with the frontend.assets grant', () => {
    const jsDefinition = {
      ...counterDefinition,
      id: 'acme.canvas.jsy',
      render: () => ({ html: '<div></div>', js: '(function(){})();' }),
    }
    const hostModule = pluginModuleToHostModule('acme.canvas', jsDefinition, () => () => null, ['frontend.assets'])
    expect(hostModule.render({}, []).js).toBe('(function(){})();')
  })
})

describe('activatePluginModulePack', () => {
  it('registers each module from the pack and tracks them by plugin id', () => {
    activatePluginModulePack(
      sampleManifest,
      { default: [counterDefinition] },
    )

    expect(listPluginRegisteredModuleIds('acme.canvas')).toEqual(['acme.canvas.counter'])
    const registered = registry.get('acme.canvas.counter')
    expect(registered).toBeDefined()
    expect(registered?.render({}, []).html).toBe('<div class="counter">0</div>')
  })

  it('replaces previous registrations on re-activation', () => {
    activatePluginModulePack(sampleManifest, { default: [counterDefinition] })
    activatePluginModulePack(sampleManifest, {
      default: [
        {
          ...counterDefinition,
          id: 'acme.canvas.replaced',
        },
      ],
    })
    expect(listPluginRegisteredModuleIds('acme.canvas')).toEqual(['acme.canvas.replaced'])
    expect(registry.get('acme.canvas.counter')).toBeUndefined()
    expect(registry.get('acme.canvas.replaced')).toBeDefined()
  })

  it('deactivates a pack and unregisters every module from the canvas registry', () => {
    activatePluginModulePack(sampleManifest, { default: [counterDefinition] })
    deactivatePluginModulePack('acme.canvas')
    expect(registry.get('acme.canvas.counter')).toBeUndefined()
    expect(listPluginRegisteredModuleIds('acme.canvas')).toEqual([])
  })

  it('refuses to activate when modules.register is not granted', () => {
    expect(() =>
      activatePluginModulePack(
        { ...sampleManifest, grantedPermissions: [] },
        { default: [counterDefinition] },
      ),
    ).toThrow(/requires permission "modules.register"/)
  })

  it('accepts a function entrypoint that returns module definitions', () => {
    activatePluginModulePack(sampleManifest, {
      default: ({ pluginId }) => [
        {
          ...counterDefinition,
          id: `${pluginId}.counter`,
        },
      ],
    })
    expect(listPluginRegisteredModuleIds('acme.canvas')).toEqual(['acme.canvas.counter'])
  })
})
