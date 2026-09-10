/**
 * Tests for the `dashboard.widgets.register` plugin capability.
 *
 * Covers three layers:
 *   1. Registry (`dashboardWidgetRegistry`) — id namespace lock for plugin
 *      widgets, ownerId-based removal, subscriber notifications.
 *   2. Editor runtime (`pluginRuntime.registerDashboardWidget`) — permission
 *      gate, iconName → component resolution through the host's resolver.
 *   3. Plugin SDK shape — `EditorPluginApi.dashboard.widgets.register` is
 *      reachable from an activated plugin module.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  activateEditorPlugin,
  bindDashboardWidgetIconResolver,
  pluginRuntime,
} from '@core/plugins/runtime'
import { dashboardWidgetRegistry } from '@core/dashboard'
import type { PluginManifest, PluginDashboardWidget, PixelArtIconComponent } from '@core/plugin-sdk'

// A no-op icon component standing in for a real pixel-art icon — the
// registry only stores the reference; it never invokes the icon at
// registration time.
const NoopIcon: PixelArtIconComponent = (() => null) as unknown as PixelArtIconComponent

// A no-op widget body — same reason: the registry doesn't render it
// during registration.
const NoopBody = (() => null) as unknown as PluginDashboardWidget['component']

const baseManifest: PluginManifest = {
  id: 'acme.analytics',
  name: 'Analytics',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Dashboard widget test plugin',
  permissions: ['dashboard.widgets.register'],
  grantedPermissions: ['dashboard.widgets.register'],
  entrypoints: { editor: 'editor/index.js' },
  resources: [],
  adminPages: [],
}

const pluginContext = {
  version: baseManifest.version,
  grantedPermissions: baseManifest.grantedPermissions ?? [],
}

beforeEach(() => {
  dashboardWidgetRegistry.reset()
  pluginRuntime.reset()
  // Bind a stub icon resolver that always returns NoopIcon so the runtime
  // can complete registration without pulling in the admin icon catalog.
  bindDashboardWidgetIconResolver(() => NoopIcon)
})

afterEach(() => {
  dashboardWidgetRegistry.reset()
  pluginRuntime.reset()
})

describe('dashboardWidgetRegistry — namespace + lifecycle', () => {
  it('accepts a first-party widget with an unnamespaced id', () => {
    dashboardWidgetRegistry.register({
      id: 'visitors',
      ownerId: 'core',
      name: 'Visitors',
      description: 'Pageview sparkline',
      icon: NoopIcon,
      defaultSize: 6,
      tint: 'mint',
      render: NoopBody,
    })

    const list = dashboardWidgetRegistry.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('visitors')
  })

  it('rejects a plugin widget whose id is not namespaced under the plugin', () => {
    expect(() =>
      dashboardWidgetRegistry.register({
        id: 'pageviews',
        ownerId: 'acme.analytics',
        pluginContext,
        name: 'Pageviews',
        description: 'Bad — no namespace',
        icon: NoopIcon,
        defaultSize: 6,
        tint: 'mint',
        render: NoopBody,
      }),
    ).toThrow(/must start with "acme\.analytics\."/)
  })

  it('accepts a properly-namespaced plugin widget', () => {
    dashboardWidgetRegistry.register({
      id: 'acme.analytics.pageviews',
      ownerId: 'acme.analytics',
      pluginContext,
      name: 'Pageviews',
      description: 'Site-wide pageview chart',
      icon: NoopIcon,
      defaultSize: 6,
      tint: 'lilac',
      render: NoopBody,
    })

    expect(dashboardWidgetRegistry.get('acme.analytics.pageviews')?.tint).toBe('lilac')
  })

  it('rejects a plugin widget without host context metadata', () => {
    expect(() =>
      dashboardWidgetRegistry.register({
        id: 'acme.analytics.pageviews',
        ownerId: 'acme.analytics',
        name: 'Pageviews',
        description: 'Missing plugin context',
        icon: NoopIcon,
        defaultSize: 6,
        tint: 'lilac',
        render: NoopBody,
      }),
    ).toThrow(/must include its host context metadata/)
  })

  it('drops every widget for a given owner via unregisterByOwner', () => {
    dashboardWidgetRegistry.register({
      id: 'core-only',
      ownerId: 'core',
      name: 'Core',
      description: 'core',
      icon: NoopIcon,
      defaultSize: 3,
      tint: 'sky',
      render: NoopBody,
    })
    dashboardWidgetRegistry.register({
      id: 'acme.analytics.first',
      ownerId: 'acme.analytics',
      pluginContext,
      name: 'First',
      description: 'one',
      icon: NoopIcon,
      defaultSize: 3,
      tint: 'sky',
      render: NoopBody,
    })
    dashboardWidgetRegistry.register({
      id: 'acme.analytics.second',
      ownerId: 'acme.analytics',
      pluginContext,
      name: 'Second',
      description: 'two',
      icon: NoopIcon,
      defaultSize: 3,
      tint: 'sky',
      render: NoopBody,
    })

    expect(dashboardWidgetRegistry.list()).toHaveLength(3)
    dashboardWidgetRegistry.unregisterByOwner('acme.analytics')
    expect(dashboardWidgetRegistry.list().map((w) => w.id)).toEqual(['core-only'])
  })

  it('notifies subscribers on register, unregister, and reset', () => {
    let count = 0
    const off = dashboardWidgetRegistry.subscribe(() => {
      count++
    })

    dashboardWidgetRegistry.register({
      id: 'core-only',
      ownerId: 'core',
      name: 'Core',
      description: 'core',
      icon: NoopIcon,
      defaultSize: 3,
      tint: 'sky',
      render: NoopBody,
    })
    expect(count).toBe(1)

    dashboardWidgetRegistry.unregister('core-only')
    expect(count).toBe(2)

    dashboardWidgetRegistry.reset()
    expect(count).toBe(3)

    off()
  })
})

describe('plugin runtime — dashboard.widgets.register', () => {
  it('exposes register through the activated plugin api', async () => {
    let captured: PluginDashboardWidget | null = null

    await activateEditorPlugin(baseManifest, {
      activate(api) {
        captured = {
          id: 'acme.analytics.pageviews',
          name: 'Pageviews',
          description: 'Static demo',
          iconName: 'chart',
          defaultSize: 6,
          tint: 'mint',
          component: NoopBody,
        }
        api.dashboard.widgets.register(captured)
      },
    })

    expect(captured).not.toBeNull()
    const def = dashboardWidgetRegistry.get('acme.analytics.pageviews')
    expect(def?.ownerId).toBe('acme.analytics')
    expect(def?.pluginContext).toEqual({
      version: '1.0.0',
      grantedPermissions: ['dashboard.widgets.register'],
    })
    expect(def?.tint).toBe('mint')
    expect(def?.icon).toBe(NoopIcon)
  })

  it('rejects registration when the permission is not granted', async () => {
    const manifestWithoutPermission: PluginManifest = {
      ...baseManifest,
      grantedPermissions: [],
    }

    await expect(
      activateEditorPlugin(manifestWithoutPermission, {
        activate(api) {
          api.dashboard.widgets.register({
            id: 'acme.analytics.pageviews',
            name: 'Pageviews',
            description: 'Demo',
            iconName: 'chart',
            defaultSize: 6,
            tint: 'mint',
            component: NoopBody,
          })
        },
      }),
    ).rejects.toThrow(/permission/i)
  })

  it('deactivatePlugin drops widgets the plugin registered', async () => {
    await activateEditorPlugin(baseManifest, {
      activate(api) {
        api.dashboard.widgets.register({
          id: 'acme.analytics.pageviews',
          name: 'Pageviews',
          description: 'Demo',
          iconName: 'chart',
          defaultSize: 6,
          tint: 'mint',
          component: NoopBody,
        })
      },
    })

    expect(dashboardWidgetRegistry.get('acme.analytics.pageviews')).toBeDefined()
    pluginRuntime.deactivatePlugin('acme.analytics')
    expect(dashboardWidgetRegistry.get('acme.analytics.pageviews')).toBeUndefined()
  })
})
