import { describe, expect, it } from 'bun:test'
import {
  createCmsPluginResourceRecord,
  deleteCmsPluginResourceRecord,
  listCmsPluginResourceRecords,
  updateCmsPluginResourceRecord,
} from '@core/persistence/cmsPluginRecords'

describe('CMS plugin records client', () => {
  it('lists and creates plugin resource records with session credentials', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const result = await listCmsPluginResourceRecords('acme.books', 'books', async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        records: [{
          id: 'record_1',
          pluginId: 'acme.books',
          resourceId: 'books',
          data: { title: 'Invisible Cities' },
          uniqueKey: null,
          version: 0,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:00:00.000Z',
        }],
        totalCount: 1,
      }), { status: 200 })
    })

    await createCmsPluginResourceRecord('acme.books', 'books', {
      title: 'The Dispossessed',
    }, async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        record: {
          id: 'record_2',
          pluginId: 'acme.books',
          resourceId: 'books',
          data: { title: 'The Dispossessed' },
          uniqueKey: null,
          version: 0,
          createdAt: '2026-05-01T10:05:00.000Z',
          updatedAt: '2026-05-01T10:05:00.000Z',
        },
      }), { status: 201 })
    })

    expect(result.records[0].data.title).toBe('Invisible Cities')
    expect(result.totalCount).toBe(1)
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/plugins/acme.books/resources/books/records',
      init: { method: 'GET', credentials: 'include' },
    })
    expect(calls[1]).toMatchObject({
      input: '/admin/api/cms/plugins/acme.books/resources/books/records',
      init: {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      },
    })
    expect(calls[1].init?.body).toBe(JSON.stringify({ data: { title: 'The Dispossessed' } }))
  })

  it('encodes filter and orderBy options as query parameters', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const result = await listCmsPluginResourceRecords(
      'acme.books',
      'books',
      async (input, init) => {
        calls.push({ input, init })
        return new Response(JSON.stringify({
          records: [],
          totalCount: 0,
        }), { status: 200 })
      },
      '/admin/api/cms',
      { filter: { status: 'active' }, orderBy: { title: 'asc' }, limit: 20, offset: 5 },
    )

    expect(result.records).toHaveLength(0)
    expect(result.totalCount).toBe(0)
    const url = String(calls[0].input)
    expect(url).toContain('filter=')
    expect(url).toContain('orderBy=')
    expect(url).toContain('limit=20')
    expect(url).toContain('offset=5')
    expect(decodeURIComponent(url)).toContain('"status":"active"')
    expect(decodeURIComponent(url)).toContain('"title":"asc"')
  })

  it('updates and deletes plugin resource records', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []

    const updated = await updateCmsPluginResourceRecord('acme.books', 'books', 'record_1', {
      title: 'Solaris',
    }, async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({
        record: {
          id: 'record_1',
          pluginId: 'acme.books',
          resourceId: 'books',
          data: { title: 'Solaris' },
          uniqueKey: null,
          version: 0,
          createdAt: '2026-05-01T10:00:00.000Z',
          updatedAt: '2026-05-01T10:10:00.000Z',
        },
      }), { status: 200 })
    })

    await deleteCmsPluginResourceRecord('acme.books', 'books', 'record_1', async (input, init) => {
      calls.push({ input, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    expect(updated.data.title).toBe('Solaris')
    expect(calls[0]).toMatchObject({
      input: '/admin/api/cms/plugins/acme.books/resources/books/records/record_1',
      init: {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify({ data: { title: 'Solaris' } }))
    expect(calls[1]).toMatchObject({
      input: '/admin/api/cms/plugins/acme.books/resources/books/records/record_1',
      init: { method: 'DELETE', credentials: 'include' },
    })
  })

  it('surfaces plugin record API errors from the response body', async () => {
    await expect(
      listCmsPluginResourceRecords('acme.books', 'books', async () =>
        new Response(JSON.stringify({ error: 'Plugin resource not found' }), { status: 404 })),
    ).rejects.toThrow('Plugin resource not found')
  })

  it('returns totalCount=0 when server omits it (backward compat)', async () => {
    const result = await listCmsPluginResourceRecords('acme.books', 'books', async () =>
      new Response(JSON.stringify({ records: [] }), { status: 200 }))
    expect(result.totalCount).toBe(0)
    expect(result.records).toHaveLength(0)
  })
})
