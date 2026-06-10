import { describe, expect, it } from 'bun:test'
import {
  installCmsPluginManifest,
  listCmsPlugins,
  removeCmsPlugin,
  setCmsPluginEnabled,
} from '@core/persistence/cmsPlugins'
import type { PluginManifest } from '@core/plugin-sdk'

const mapManifest: PluginManifest = {
  id: 'local.map',
  name: 'Map Studio',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [],
  resources: [],
  adminPages: [{
    id: 'overview',
    title: 'Map Studio',
    navLabel: 'Map',
    icon: 'map',
    route: '/admin/plugins/local.map/overview',
    content: {
      kind: 'map',
      heading: 'Store Map',
      body: 'Track important locations.',
      centerLabel: 'Prague',
      pins: [{ label: 'HQ', detail: 'Main office', x: 42, y: 55 }],
    },
  }],
}

describe('CMS plugins client', () => {
  it('lists installed plugins with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const payload = await listCmsPlugins(async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        plugins: [{
          id: mapManifest.id,
          name: mapManifest.name,
          version: mapManifest.version,
          enabled: true,
          manifest: mapManifest,
          installedAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
        }],
        adminPages: [{
          pluginId: mapManifest.id,
          pluginName: mapManifest.name,
          ...mapManifest.adminPages[0],
        }],
      }), { status: 200 })
    })

    expect(payload.plugins[0].id).toBe('local.map')
    expect(payload.adminPages[0].route).toBe('/admin/plugins/local.map/overview')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/plugins',
      init: { method: 'GET', credentials: 'include' },
    })
  })

  it('installs, disables, and removes plugins through the CMS API', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    await installCmsPluginManifest(mapManifest, [], async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ plugin: { id: mapManifest.id, manifest: mapManifest }, adminPages: [] }), {
        status: 201,
      })
    })

    await setCmsPluginEnabled('local.map', false, async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ plugin: { id: mapManifest.id, enabled: false }, adminPages: [] }), {
        status: 200,
      })
    })

    await removeCmsPlugin('local.map', false, async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/plugins',
      init: {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify(mapManifest))
    expect(calls[1]).toMatchObject({
      input: '/admin/api/cms/plugins/local.map',
      init: {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      },
    })
    expect(calls[1].init?.body).toBe(JSON.stringify({ enabled: false }))
    expect(calls[2]).toMatchObject({
      input: '/admin/api/cms/plugins/local.map',
      init: { method: 'DELETE', credentials: 'include' },
    })
  })

  it('surfaces plugin API errors from the response body', async () => {
    await expect(
      listCmsPlugins(async () =>
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })),
    ).rejects.toThrow('Unauthorized')
  })
})
