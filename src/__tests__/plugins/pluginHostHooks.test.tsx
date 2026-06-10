/**
 * Permission gating for `@instatic/host-hooks`.
 *
 * Plugin React surfaces (editor panels, admin app pages, canvas overlays)
 * mount under a `PluginContext` carrying the operator-granted permission
 * set. `useEditorStore` — the only host hook exposing editor state — must
 * enforce `editor.store.read` against that context: a plugin the operator
 * never granted store access cannot subscribe to editor state just because
 * its code runs in the admin window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { PluginEditorPanel } from '@site/panels/PluginEditorPanel'
import { useEditorStore as useHostEditorStore } from '@site/store/store'
import { useEditorStore } from '@admin/plugin-host-hooks'
import { pluginRuntime } from '@core/plugins/runtime'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'

function manifestWithGrants(granted: PluginPermission[]): PluginManifest {
  return {
    id: 'acme.workflow',
    name: 'Workflow',
    version: '1.0.0',
    apiVersion: 1,
    permissions: ['editor.code', 'editor.panels', 'editor.store.read'],
    grantedPermissions: granted,
    entrypoints: { editor: 'editor/index.js' },
    resources: [],
    adminPages: [],
  }
}

function BreakpointPanel() {
  const breakpointId = useEditorStore((s) => s.activeBreakpointId)
  return <span>breakpoint:{String(breakpointId)}</span>
}

beforeEach(() => {
  pluginRuntime.reset()
})

afterEach(() => {
  pluginRuntime.reset()
  cleanup()
})

describe('useEditorStore permission gate', () => {
  it('returns editor state for a plugin granted editor.store.read', () => {
    useHostEditorStore.setState({ activeBreakpointId: 'desktop' })
    pluginRuntime.registerPanel(
      manifestWithGrants(['editor.code', 'editor.panels', 'editor.store.read']),
      {
        id: 'acme.workflow.review',
        label: 'Review',
        iconName: 'box-stack',
        component: BreakpointPanel,
      },
    )

    render(<PluginEditorPanel panelId="acme.workflow.review" />)

    expect(screen.getByText('breakpoint:desktop')).toBeDefined()
  })

  it('throws a permission error (caught by the boundary) when editor.store.read is not granted', () => {
    pluginRuntime.registerPanel(
      manifestWithGrants(['editor.code', 'editor.panels']),
      {
        id: 'acme.workflow.review',
        label: 'Review',
        iconName: 'box-stack',
        component: BreakpointPanel,
      },
    )

    render(<PluginEditorPanel panelId="acme.workflow.review" />)

    // No editor state leaked; the panel body shows the boundary fallback
    // instead of the plugin subtree.
    expect(screen.queryByText('breakpoint:desktop')).toBeNull()
    expect(
      (document.body.textContent ?? '').includes('failed to load'),
    ).toBe(true)
  })

  it('the thrown error names the plugin and the missing permission', () => {
    pluginRuntime.registerPanel(
      manifestWithGrants(['editor.code', 'editor.panels']),
      {
        id: 'acme.workflow.review',
        label: 'Review',
        iconName: 'box-stack',
        component: BreakpointPanel,
      },
    )

    // Render the panel subtree without relying on the boundary fallback
    // copy (which is environment-dependent) — capture the boundary log.
    const errors: unknown[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')) }
    try {
      render(<PluginEditorPanel panelId="acme.workflow.review" />)
    } finally {
      console.error = originalConsoleError
    }
    expect(errors.some((line) =>
      String(line).includes('[plugin:acme.workflow]')
      && String(line).includes('useEditorStore requires the "editor.store.read" permission'),
    )).toBe(true)
  })

  it('throws when called outside any plugin surface', () => {
    function Bare() {
      useEditorStore((s) => s.activeBreakpointId)
      return null
    }
    expect(() => render(<Bare />)).toThrow(/outside a plugin surface/)
  })

  it('exposes no write-capable accessor (getState/setState/subscribe)', () => {
    // The previous implementation re-exported the raw Zustand hook, which
    // carried `setState` — letting any admin-window plugin mutate editor
    // state without the `editor.store.write` grant. The gated wrapper is a
    // plain function: reads via selector, writes only through
    // `api.editor.store.transaction`.
    const accessor = useEditorStore as unknown as Record<string, unknown>
    expect(accessor.setState).toBeUndefined()
    expect(accessor.getState).toBeUndefined()
    expect(accessor.subscribe).toBeUndefined()
  })
})
