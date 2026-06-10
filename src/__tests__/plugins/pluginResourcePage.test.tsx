import { afterEach, describe, expect, it } from 'bun:test'
import React, { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PluginPageRenderer } from '@plugins/components/PluginPageRenderer/PluginPageRenderer'
import type {
  PluginAdminAppComponent,
  PluginAdminPageRoute,
} from '@core/plugin-sdk'
import { usePluginRoutes } from '@admin/plugin-host-hooks'

const originalFetch = globalThis.fetch

const booksPage: PluginAdminPageRoute = {
  pluginId: 'acme.books',
  pluginName: 'Books',
  id: 'books',
  title: 'Books',
  navLabel: 'Books',
  route: '/admin/plugins/acme.books/books',
  content: {
    kind: 'resource',
    heading: 'Books',
    resource: 'books',
  },
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

describe('PluginPageRenderer resource pages', () => {
  it('loads backend records and creates new records through the plugin resource API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      const url = String(input)

      if (url === '/admin/api/cms/plugins/acme.books/resources/books/records' && init?.method === 'GET') {
        return json({
          resource: {
            id: 'books',
            title: 'Books',
            singularLabel: 'Book',
            pluralLabel: 'Books',
            fields: [
              { id: 'title', label: 'Title', type: 'text', required: true },
              { id: 'author', label: 'Author', type: 'text' },
            ],
          },
          records: [{
            id: 'record_1',
            pluginId: 'acme.books',
            resourceId: 'books',
            data: { title: 'Invisible Cities', author: 'Italo Calvino' },
            createdAt: '2026-05-01T10:00:00.000Z',
            updatedAt: '2026-05-01T10:00:00.000Z',
          }],
        })
      }

      if (url === '/admin/api/cms/plugins/acme.books/resources/books/records' && init?.method === 'POST') {
        return json({
          record: {
            id: 'record_2',
            pluginId: 'acme.books',
            resourceId: 'books',
            data: JSON.parse(String(init.body)).data,
            createdAt: '2026-05-01T10:05:00.000Z',
            updatedAt: '2026-05-01T10:05:00.000Z',
          },
        }, 201)
      }

      return json({ error: `Unhandled ${url}` }, 500)
    }

    render(<PluginPageRenderer page={booksPage} />)

    expect(await screen.findByText('Invisible Cities')).toBeDefined()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The Dispossessed' } })
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: 'Ursula K. Le Guin' } })
    fireEvent.click(screen.getByRole('button', { name: /create book/i }))

    await waitFor(() => {
      expect(calls.some((call) =>
        String(call.input) === '/admin/api/cms/plugins/acme.books/resources/books/records' &&
        call.init?.method === 'POST' &&
        call.init.body === JSON.stringify({
          data: {
            title: 'The Dispossessed',
            author: 'Ursula K. Le Guin',
          },
        })
      )).toBe(true)
    })
  })

  it('mounts packaged admin app pages and threads the plugin-scoped CMS API into the SDK render fn', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return json({
        resource: {
          id: 'approvals',
          title: 'Approvals',
          fields: [
            { id: 'pageTitle', label: 'Page Title', type: 'text', required: true },
          ],
        },
        records: [{
          id: 'record_1',
          pluginId: 'acme.demo',
          resourceId: 'approvals',
          data: { pageTitle: 'Home', status: 'approved' },
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
        }],
      })
    }

    function ApprovalsCounter() {
      const routes = usePluginRoutes()
      const [count, setCount] = useState<number | null>(null)
      useEffect(() => {
        let cancelled = false
        void routes
          .fetch('approvals')
          .then((res) => res.json())
          .then((body: { count: number }) => {
            if (!cancelled) setCount(body.count)
          })
        return () => { cancelled = true }
      }, [routes])
      return <strong>{count === null ? 'Loading...' : `Approvals: ${count}`}</strong>
    }

    // Override fetch for the runtime route the plugin component calls.
    const originalFetchScoped = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/plugins/acme.demo/runtime/approvals') {
        return json({ count: 1 })
      }
      return originalFetchScoped(input, init)
    }

    render(
      <PluginPageRenderer
        page={{
          pluginId: 'acme.demo',
          pluginName: 'Demo Plugin',
          id: 'dashboard',
          title: 'Dashboard',
          route: '/admin/plugins/acme.demo/dashboard',
          content: {
            kind: 'app',
            heading: 'Demo Dashboard',
            entry: 'admin/dashboard.js',
            assetPath: '/uploads/plugins/acme.demo/1.0.0',
          },
          pluginGrantedPermissions: ['editor.code'],
        }}
        importModule={async (url) => {
          // The host appends a `?v=<timestamp>` cache-buster — assert the
          // base path matches and ignore the query string.
          expect(url.split('?')[0]).toBe('/uploads/plugins/acme.demo/1.0.0/admin/dashboard.js')
          return { default: ApprovalsCounter }
        }}
      />,
    )

    // Plugin's component called `routes.fetch('approvals')` from
    // `usePluginRoutes()` — the host scoped the URL into the plugin's
    // runtime namespace and resolved with `{ count: 1 }`. If the plugin
    // can render the count, the routes helper is wired correctly.
    expect(await screen.findByText('Approvals: 1')).toBeDefined()
  })

  it('keeps stale async admin app loads from duplicating the visible plugin UI', async () => {
    const appPage: PluginAdminPageRoute = {
      pluginId: 'acme.demo',
      pluginName: 'Demo Plugin',
      id: 'dashboard',
      title: 'Dashboard',
      route: '/admin/plugins/acme.demo/dashboard',
      content: {
        kind: 'app',
        heading: 'Demo Dashboard',
        entry: 'admin/dashboard.js',
        assetPath: '/uploads/plugins/acme.demo/1.0.0',
      },
      pluginGrantedPermissions: ['editor.code'],
    }

    type Resolver = (mod: { default: PluginAdminAppComponent }) => void
    const imports: Resolver[] = []
    const importModule = async () =>
      await new Promise<{ default: PluginAdminAppComponent }>((resolve) => {
        imports.push(resolve)
      })

    const PluginComponent: PluginAdminAppComponent = () => <strong>Plugin dashboard subtree</strong>

    const { rerender } = render(<PluginPageRenderer page={{ ...appPage }} importModule={importModule} />)

    await waitFor(() => {
      expect(imports).toHaveLength(1)
    })

    rerender(<PluginPageRenderer page={{ ...appPage }} importModule={importModule} />)

    await waitFor(() => {
      expect(imports).toHaveLength(2)
    })

    await act(async () => {
      imports[0]({ default: PluginComponent })
      imports[1]({ default: PluginComponent })
    })

    await waitFor(() => {
      expect(screen.getAllByText('Plugin dashboard subtree')).toHaveLength(1)
    })
  })

  it('refuses to import an app page without the editor.code grant and renders the refusal', async () => {
    const appPage: PluginAdminPageRoute = {
      pluginId: 'acme.demo',
      pluginName: 'Demo Plugin',
      id: 'dashboard',
      title: 'Dashboard',
      route: '/admin/plugins/acme.demo/dashboard',
      content: {
        kind: 'app',
        heading: 'Demo Dashboard',
        entry: 'admin/dashboard.js',
        assetPath: '/uploads/plugins/acme.demo/1.0.0',
      },
      // Grant set without `editor.code` — the loader must refuse BEFORE the
      // dynamic import and the page body must show why.
      pluginGrantedPermissions: ['admin.navigation'],
    }

    const imports: string[] = []
    render(
      <PluginPageRenderer
        page={appPage}
        importModule={async (url) => {
          imports.push(url)
          return { default: () => null }
        }}
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('editor.code')
    expect(imports).toHaveLength(0)
  })
})
