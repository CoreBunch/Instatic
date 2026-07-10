import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { DataRow } from '@core/data/schemas'
import { useContentWorkspace } from '../useContentWorkspace'

const originalFetch = globalThis.fetch

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  window.history.replaceState({}, '', '/')
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function table(id: string, name: string) {
  return {
    id,
    name,
    slug: id,
    kind: 'postType',
    routeBase: `/${id}`,
    singularLabel: name,
    pluralLabel: name,
    primaryFieldId: 'title',
    fields: [],
    system: false,
    rowCount: 0,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  }
}

function row(id: string, tableId: string, title: string): DataRow {
  return {
    id,
    tableId,
    cells: { title, slug: id },
    slug: id,
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

describe('useContentWorkspace document navigation', () => {
  it('finishes loading when a deep link targets the fallback collection', async () => {
    const post = row('post-1', 'posts', 'Post')
    window.history.replaceState({}, '', '/admin/content?table=posts&row=post-1')
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/admin/api/cms/data/tables' && method === 'GET') {
        return json({ tables: [table('posts', 'Posts')] })
      }
      if (url === '/admin/api/cms/data/tables/posts/rows' && method === 'GET') {
        return json({ rows: [post] })
      }
      return json({ error: `Unhandled ${method} ${url}` }, 500)
    }) as typeof fetch

    const view = renderHook(() => useContentWorkspace({ loadAuthors: false }))

    await waitFor(() => expect(view.result.current.selectedEntry?.id).toBe('post-1'))
    expect(view.result.current.contentLoading).toBe(false)
  })

  it('opens a cross-collection document before its collection list finishes loading', async () => {
    const post = row('post-1', 'posts', 'Post')
    const firstArticle = row('article-1', 'articles', 'First article')
    const requestedArticle = row('article-2', 'articles', 'Requested article')
    let resolveArticleList: ((response: Response) => void) | null = null
    const articleList = new Promise<Response>((resolve) => {
      resolveArticleList = resolve
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === '/admin/api/cms/data/tables' && method === 'GET') {
        return json({ tables: [table('posts', 'Posts'), table('articles', 'Articles')] })
      }
      if (url === '/admin/api/cms/data/tables/posts/rows' && method === 'GET') {
        return json({ rows: [post] })
      }
      if (url === '/admin/api/cms/data/tables/articles/rows' && method === 'GET') {
        return articleList
      }
      return json({ error: `Unhandled ${method} ${url}` }, 500)
    }) as typeof fetch

    const view = renderHook(() => useContentWorkspace({ loadAuthors: false }))
    await waitFor(() => expect(view.result.current.selectedEntry?.id).toBe('post-1'))

    let opened = false
    await act(async () => {
      // These calls intentionally share one React turn: the bridge must not
      // depend on the collection list effect committing between them.
      view.result.current.selectCollection('articles')
      opened = view.result.current.openEntry(requestedArticle)
    })

    expect(opened).toBe(true)
    expect(view.result.current.selectedCollectionId).toBe('articles')
    expect(view.result.current.selectedEntry?.id).toBe('article-2')

    await act(async () => {
      // The requested row disappeared before the list completed. Because it
      // was not changed during this request, the server response is authoritative.
      resolveArticleList?.(json({ rows: [firstArticle] }))
      await articleList
    })
    await waitFor(() => expect(view.result.current.entries).toHaveLength(1))

    expect(view.result.current.entries.map((entry) => entry.id)).toEqual(['article-1'])
    expect(view.result.current.selectedEntry?.id).toBe('article-1')
  })
})
