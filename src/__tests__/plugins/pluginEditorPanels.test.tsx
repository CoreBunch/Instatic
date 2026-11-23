/**
 * Tests for the `editor.panels` plugin capability.
 *
 * Covers three layers:
 *   1. SDK builder (`definePluginPanel`) — id validation + identity wrap
 *   2. Editor runtime (`pluginRuntime.registerPanel`) — namespace lock,
 *      permission gate, settings snapshot
 *   3. Host UI integration — `PluginEditorPanel` mount renders the plugin's
 *      React component, "unavailable" fallback when panel id is unknown,
 *      error boundary swallows render-time crashes
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PluginEditorPanel } from '@site/panels/PluginEditorPanel'
import { useEditorStore } from '@site/store/store'
import {
  activateEditorPlugin,
  pluginRuntime,
} from '@core/plugins/runtime'
import { definePluginPanel } from '@core/plugin-sdk'
import type { PluginManifest } from '@core/plugin-sdk'

const baseManifest: PluginManifest = {
  id: 'acme.workflow',
  name: 'Workflow',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Editor panel test plugin',
  permissions: ['editor.panels'],
  grantedPermissions: ['editor.panels'],
  entrypoints: { editor: 'editor/index.js' },
  resources: [],
  adminPages: [],
}

const NoopPanel = () => null

beforeEach(() => {
  pluginRuntime.reset()
})

afterEach(() => {
  pluginRuntime.reset()
  cleanup()
})

describe('definePluginPanel SDK builder', () => {
  it('returns the panel descriptor unchanged for valid input', () => {
    const panel = definePluginPanel({
      id: 'acme.workflow.review',
      label: 'Review',
      iconName: 'box-stack',
      accent: 'mint',
      component: NoopPanel,
    })
    expect(panel.id).toBe('acme.workflow.review')
    expect(panel.label).toBe('Review')
    expect(panel.iconName).toBe('box-stack')
    expect(panel.accent).toBe('mint')
    expect(panel.component).toBe(NoopPanel)
  })

  it('rejects panel ids that are not namespaced (no dot)', () => {
    expect(() => definePluginPanel({
      id: 'unscoped',
      label: 'X',
      iconName: 'box',
      component: NoopPanel,
    })).toThrow(/namespaced/)
  })

  it('rejects panel ids with invalid characters', () => {
    expect(() => definePluginPanel({
      id: 'Acme.Bad',
      label: 'X',
      iconName: 'box',
      component: NoopPanel,
    })).toThrow(/lowercase/)
  })

  it('rejects empty iconName', () => {
    expect(() => definePluginPanel({
      id: 'acme.x.panel',
      label: 'X',
      iconName: '   ',
      component: NoopPanel,
    })).toThrow(/iconName/)
  })
})

describe('pluginRuntime panel registry', () => {
  it('registers a panel and exposes it via getPanels / getPanel', async () => {
    await activateEditorPlugin(baseManifest, {
      activate(api) {
        api.editor.panels.register({
          id: 'acme.workflow.review',
          label: 'Review',
          iconName: 'box-stack',
          component: NoopPanel,
        })
      },
    })
    const panels = pluginRuntime.getPanels()
    expect(panels.length).toBe(1)
    expect(panels[0].id).toBe('acme.workflow.review')
    expect(panels[0].pluginId).toBe('acme.workflow')
    expect(pluginRuntime.getPanel('acme.workflow.review')?.label).toBe('Review')
    expect(pluginRuntime.getPanelManifest('acme.workflow.review')?.id).toBe('acme.workflow')
  })

  it('throws when the plugin lacks the editor.panels permission', async () => {
    const manifest = { ...baseManifest, grantedPermissions: [] satisfies PluginManifest['grantedPermissions'] }
    await expect(activateEditorPlugin(manifest, {
      activate(api) {
        api.editor.panels.register({
          id: 'acme.workflow.review',
          label: 'Review',
          iconName: 'box-stack',
          component: NoopPanel,
        })
      },
    })).rejects.toThrow(/editor\.panels/)
    expect(pluginRuntime.getPanels()).toEqual([])
  })

  it('rejects panel ids that escape the plugin namespace', async () => {
    await expect(activateEditorPlugin(baseManifest, {
      activate(api) {
        api.editor.panels.register({
          id: 'other.vendor.review',
          label: 'X',
          iconName: 'box',
          component: NoopPanel,
        })
      },
    })).rejects.toThrow(/id must start with/)
    expect(pluginRuntime.getPanels()).toEqual([])
  })

  it('returns a referentially stable getPanels() snapshot until a mutation invalidates it', () => {
    // Regression: PanelRail subscribes to pluginRuntime via useSyncExternalStore.
    // React requires the snapshot reference to stay equal across reads when
    // nothing has changed; a fresh `[...]` per call would tear the subscriber
    // and infinite-loop the editor on mount.
    pluginRuntime.registerPanel(baseManifest, {
      id: 'acme.workflow.review',
      label: 'Review',
      iconName: 'box',
      component: NoopPanel,
    })
    const a = pluginRuntime.getPanels()
    const b = pluginRuntime.getPanels()
    expect(a).toBe(b)

    pluginRuntime.registerPanel(baseManifest, {
      id: 'acme.workflow.history',
      label: 'History',
      iconName: 'box',
      component: NoopPanel,
    })
    const c = pluginRuntime.getPanels()
    expect(c).not.toBe(a)
    expect(c.length).toBe(2)
  })

  it('reset() clears registered panels and emits to subscribers', () => {
    pluginRuntime.registerPanel(baseManifest, {
      id: 'acme.workflow.review',
      label: 'Review',
      iconName: 'box',
      component: NoopPanel,
    })
    let emits = 0
    const unsubscribe = pluginRuntime.subscribe(() => { emits += 1 })
    pluginRuntime.reset()
    expect(pluginRuntime.getPanels()).toEqual([])
    expect(emits).toBeGreaterThanOrEqual(1)
    unsubscribe()
  })

  it('keeps a per-plugin settings snapshot accessible to panel api factories', () => {
    pluginRuntime.setPluginSettings('acme.workflow', { apiKey: 'secret', sample: 100 })
    expect(pluginRuntime.getPluginSettings('acme.workflow')).toEqual({
      apiKey: 'secret',
      sample: 100,
    })
    // Returns a fresh snapshot each call — mutating it shouldn't bleed back.
    const snapshot = pluginRuntime.getPluginSettings('acme.workflow')
    snapshot.apiKey = 'tampered'
    expect(pluginRuntime.getPluginSettings('acme.workflow').apiKey).toBe('secret')
  })
})

describe('PluginEditorPanel host mount', () => {
  it('renders the plugin\'s React component inside host-owned chrome', () => {
    function HelloPanel() {
      return <p>Hello from plugin</p>
    }
    pluginRuntime.registerPanel(baseManifest, {
      id: 'acme.workflow.review',
      label: 'Review',
      iconName: 'box-stack',
      component: HelloPanel,
    })

    render(<PluginEditorPanel panelId="acme.workflow.review" />)

    // Host-rendered PanelHeader owns the title and close button.
    expect(screen.getByText('Review')).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Close Review panel' }),
    ).toBeDefined()
    // Plugin's body content is rendered alongside the header chrome.
    expect(screen.getByText('Hello from plugin')).toBeDefined()
  })

  it('clicking the host-rendered close button clears activePluginPanelId', () => {
    pluginRuntime.registerPanel(baseManifest, {
      id: 'acme.workflow.review',
      label: 'Review',
      iconName: 'box-stack',
      component: NoopPanel,
    })
    // Mount with the panel open in the store — close button should clear it.
    const { setActivePluginPanel } = useEditorStore.getState()
    setActivePluginPanel('acme.workflow.review')
    expect(useEditorStore.getState().activePluginPanelId).toBe('acme.workflow.review')

    render(<PluginEditorPanel panelId="acme.workflow.review" />)
    fireEvent.click(screen.getByRole('button', { name: 'Close Review panel' }))

    expect(useEditorStore.getState().activePluginPanelId).toBeNull()
  })

  it('shows the unavailable fallback when the panel id is not registered', () => {
    render(<PluginEditorPanel panelId="acme.missing.panel" />)
    expect(screen.getByText(/not currently registered/)).toBeDefined()
  })
})
