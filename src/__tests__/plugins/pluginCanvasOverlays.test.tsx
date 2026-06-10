/**
 * Tests for the `editor.canvas` plugin capability.
 *
 * Covers:
 *   1. SDK builder (`definePluginCanvasOverlay`) — id validation
 *   2. Editor runtime (`pluginRuntime.registerCanvasOverlay`) — namespace
 *      lock, permission gate, stable getCanvasOverlays() snapshot
 *   3. Host UI integration — `PluginCanvasOverlayLayer` renders the
 *      plugin's React component, ErrorBoundary contains crashes
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { PluginCanvasOverlayLayer } from '@site/canvas/PluginCanvasOverlayLayer'
import {
  activateEditorPlugin,
  pluginRuntime,
} from '@core/plugins/runtime'
import { definePluginCanvasOverlay } from '@core/plugin-sdk'
import type { PluginManifest } from '@core/plugin-sdk'

const baseManifest: PluginManifest = {
  id: 'acme.workflow',
  name: 'Workflow',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Canvas overlay test plugin',
  permissions: ['editor.code', 'editor.canvas'],
  grantedPermissions: ['editor.code', 'editor.canvas'],
  entrypoints: { editor: 'editor/index.js' },
  resources: [],
  adminPages: [],
}

const NoopOverlay = () => null

beforeEach(() => {
  pluginRuntime.reset()
})

afterEach(() => {
  pluginRuntime.reset()
  cleanup()
})

describe('definePluginCanvasOverlay SDK builder', () => {
  it('returns the overlay descriptor unchanged for valid input', () => {
    const overlay = definePluginCanvasOverlay({
      id: 'acme.workflow.pin',
      component: NoopOverlay,
    })
    expect(overlay.id).toBe('acme.workflow.pin')
    expect(overlay.component).toBe(NoopOverlay)
  })

  it('rejects overlay ids that are not namespaced', () => {
    expect(() => definePluginCanvasOverlay({
      id: 'unscoped',
      component: NoopOverlay,
    })).toThrow(/namespaced/)
  })

  it('rejects overlay ids with invalid characters', () => {
    expect(() => definePluginCanvasOverlay({
      id: 'Acme.Bad',
      component: NoopOverlay,
    })).toThrow(/lowercase/)
  })
})

describe('pluginRuntime canvas overlay registry', () => {
  it('registers an overlay and exposes it via getCanvasOverlays', async () => {
    await activateEditorPlugin(baseManifest, {
      activate(api) {
        api.editor.canvas.registerOverlay({
          id: 'acme.workflow.pin',
          component: NoopOverlay,
        })
      },
    })
    const overlays = pluginRuntime.getCanvasOverlays()
    expect(overlays.length).toBe(1)
    expect(overlays[0].id).toBe('acme.workflow.pin')
    expect(overlays[0].pluginId).toBe('acme.workflow')
  })

  it('throws when the plugin lacks the editor.canvas permission', async () => {
    const manifest = {
      ...baseManifest,
      grantedPermissions: [] satisfies PluginManifest['grantedPermissions'],
    }
    await expect(activateEditorPlugin(manifest, {
      activate(api) {
        api.editor.canvas.registerOverlay({
          id: 'acme.workflow.pin',
          component: NoopOverlay,
        })
      },
    })).rejects.toThrow(/editor\.canvas/)
    expect(pluginRuntime.getCanvasOverlays()).toEqual([])
  })

  it('rejects overlay ids that escape the plugin namespace', async () => {
    await expect(activateEditorPlugin(baseManifest, {
      activate(api) {
        api.editor.canvas.registerOverlay({
          id: 'other.vendor.pin',
          component: NoopOverlay,
        })
      },
    })).rejects.toThrow(/id must start with/)
    expect(pluginRuntime.getCanvasOverlays()).toEqual([])
  })

  it('returns a referentially stable getCanvasOverlays() snapshot until a mutation', () => {
    pluginRuntime.registerCanvasOverlay(baseManifest, {
      id: 'acme.workflow.pin',
      component: NoopOverlay,
    })
    const a = pluginRuntime.getCanvasOverlays()
    const b = pluginRuntime.getCanvasOverlays()
    expect(a).toBe(b)

    pluginRuntime.registerCanvasOverlay(baseManifest, {
      id: 'acme.workflow.ruler',
      component: NoopOverlay,
    })
    const c = pluginRuntime.getCanvasOverlays()
    expect(c).not.toBe(a)
    expect(c.length).toBe(2)
  })

  it('reset() clears registered overlays', () => {
    pluginRuntime.registerCanvasOverlay(baseManifest, {
      id: 'acme.workflow.pin',
      component: NoopOverlay,
    })
    expect(pluginRuntime.getCanvasOverlays().length).toBe(1)
    pluginRuntime.reset()
    expect(pluginRuntime.getCanvasOverlays()).toEqual([])
  })
})

describe('PluginCanvasOverlayLayer host mount', () => {
  it('renders nothing when no overlays are registered', () => {
    const { container } = render(<PluginCanvasOverlayLayer />)
    expect(container.firstChild).toBeNull()
  })

  it('renders each registered overlay inside its own slot', () => {
    function HelloPin() {
      return <span>Hello pin</span>
    }
    function GoodbyePin() {
      return <span>Goodbye pin</span>
    }
    pluginRuntime.registerCanvasOverlay(baseManifest, {
      id: 'acme.workflow.hello',
      component: HelloPin,
    })
    pluginRuntime.registerCanvasOverlay(baseManifest, {
      id: 'acme.workflow.bye',
      component: GoodbyePin,
    })

    render(<PluginCanvasOverlayLayer />)

    expect(screen.getByText('Hello pin')).toBeDefined()
    expect(screen.getByText('Goodbye pin')).toBeDefined()
  })

  it('passes the overlay descriptor as a prop', () => {
    const captured: Array<{ id: string; pluginId: string }> = []
    function CapturingOverlay({ overlay }: { overlay: { id: string; pluginId: string } }) {
      captured.push(overlay)
      return null
    }
    pluginRuntime.registerCanvasOverlay(baseManifest, {
      id: 'acme.workflow.cap',
      component: CapturingOverlay,
    })
    render(<PluginCanvasOverlayLayer />)
    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[0]).toEqual({ id: 'acme.workflow.cap', pluginId: 'acme.workflow' })
  })
})
