import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { DashboardGrid } from '@admin/pages/dashboard/components/DashboardGrid'
import {
  usePluginContext,
  usePluginRoutes,
  usePluginSettings,
} from '@admin/plugin-host-hooks'
import {
  activateEditorPlugin,
  bindDashboardWidgetIconResolver,
  pluginRuntime,
} from '@core/plugins/runtime'
import { dashboardWidgetRegistry } from '@core/dashboard'
import type {
  PixelArtIconComponent,
  PluginDashboardWidget,
  PluginManifest,
} from '@core/plugin-sdk'

const NoopIcon = (() => null) as unknown as PixelArtIconComponent

const manifest: PluginManifest = {
  id: 'acme.analytics',
  name: 'Analytics',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['editor.code', 'dashboard.widgets.register'],
  grantedPermissions: ['editor.code', 'dashboard.widgets.register'],
  entrypoints: { editor: 'editor/index.js' },
  resources: [],
  adminPages: [],
}

let requests: Array<{ input: string; credentials: RequestCredentials | undefined }> = []
let originalFetch: typeof globalThis.fetch

function ContextWidget() {
  const context = usePluginContext()
  const settings = usePluginSettings<{ sampleRate: number }>()
  const routes = usePluginRoutes()
  return (
    <>
      <span data-testid="plugin-widget-context">
        {context.pluginId}|{context.pluginVersion}|{context.surfaceId}|{context.surfaceLabel}|
        {settings.sampleRate}
      </span>
      <button type="button" onClick={() => void routes.fetch('/status')}>
        Load status
      </button>
    </>
  )
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), credentials: init?.credentials })
    return new Response('{}', { status: 200 })
  }
  requests = []
  dashboardWidgetRegistry.reset()
  pluginRuntime.reset()
  bindDashboardWidgetIconResolver(() => NoopIcon)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  dashboardWidgetRegistry.reset()
  pluginRuntime.reset()
  cleanup()
})

describe('plugin dashboard widget context', () => {
  it('provides plugin identity, settings, and scoped routes in the dashboard grid', async () => {
    pluginRuntime.setPluginSettings(manifest.id, { sampleRate: 7 })
    await activateEditorPlugin(manifest, {
      activate(api) {
        api.dashboard.widgets.register({
          id: 'acme.analytics.pageviews',
          name: 'Pageviews',
          description: 'Site-wide pageview chart',
          iconName: 'chart',
          defaultSize: 6,
          tint: 'lilac',
          component: ContextWidget as PluginDashboardWidget['component'],
        })
      },
    })

    const definition = dashboardWidgetRegistry.get('acme.analytics.pageviews')
    expect(definition).toBeDefined()

    render(
      <DndContext>
        <DashboardGrid
          items={[{ id: 'acme.analytics.pageviews', col: 1, row: 1, size: 6, rows: 3 }]}
          definitions={new Map([[definition!.id, definition!]])}
          editing={false}
          onResize={() => {}}
          onResizeRows={() => {}}
          onAddBlock={() => {}}
          gridRef={createRef<HTMLDivElement>()}
          dropTarget={null}
        />
      </DndContext>,
    )

    expect(screen.getByTestId('plugin-widget-context').textContent).toBe(
      'acme.analytics|1.0.0|acme.analytics.pageviews|Pageviews|7',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load status' }))
    await waitFor(() => {
      expect(requests).toEqual([{
        input: '/admin/api/cms/plugins/acme.analytics/runtime/status',
        credentials: 'include',
      }])
    })
  })
})
