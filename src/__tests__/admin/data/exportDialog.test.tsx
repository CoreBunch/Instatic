/**
 * ExportDialog — the granular "full site export" dialog (a sibling of the Site
 * Import modal: a left category navigator + a right detail pane).
 *
 * Covers the new interaction surface:
 *   1.  Initial state — full export: theme & settings on, footer says "Full export"
 *   2.  Toggling the active category's switch flips its aria-checked
 *   3.  Selecting the Media category shows its switch (on by default = full export)
 *   4.  "Select none" disables Download and updates the footer summary
 *   5.  Download starts — form body carries every include* flag (full export)
 *   6.  Download start error — inline alert shown, error toast pushed, onClose NOT called
 *   7.  Cancel calls onClose
 *   8.  Estimate is fetched and shrinks when media is toggled OFF
 *   9.  Row scope — initialScope='selected' shows the Selected segment, pressed
 *   10. An empty category (count 0 from the summary) is disabled
 */

import { makeContentLocalization } from '../../fixtures/localization'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DataTableListItem } from '@core/data/schemas'
import { subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { ExportDialog } from '@admin/pages/data/components/ExportDialog/ExportDialog'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const POSTS_TABLE: DataTableListItem = {
  id: 'posts',
  name: 'Posts',
  slug: 'posts',
  kind: 'postType',
  singularLabel: 'Post',
  pluralLabel: 'Posts',
  routeBase: '/posts',
  primaryFieldId: 'title',
  fields: [],
  system: true,
  rowCount: 5,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const PAGES_TABLE: DataTableListItem = {
  id: 'pages',
  name: 'Pages',
  slug: 'pages',
  kind: 'page',
  singularLabel: 'Page',
  pluralLabel: 'Pages',
  routeBase: '',
  primaryFieldId: 'title',
  fields: [],
  system: true,
  rowCount: 3,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Default mock: serves the summary + estimate endpoints so the dialog settles. */
function defaultFetch(summary = { media: 2, mediaFolders: 1, redirects: 1 }, bytes = 12_000) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/admin/api/cms/export/summary')) return jsonResponse(summary)
    if (url === '/admin/api/cms/export/estimate') return jsonResponse({ bytes })
    return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
  }
}

/** Click a category's nav row, then return its detail-pane include Switch. */
function openCategory(label: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label, 'i') }))
  return screen.getByRole('switch', { name: new RegExp(`include ${label} in export`, 'i') })
}

// ── Global state saved for restore ───────────────────────────────────────────

const originalFetch = globalThis.fetch
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL
let savedAnchorClick: typeof HTMLAnchorElement.prototype.click
let savedFormSubmit: typeof HTMLFormElement.prototype.submit

beforeEach(() => {
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  savedAnchorClick = HTMLAnchorElement.prototype.click
  savedFormSubmit = HTMLFormElement.prototype.submit
  URL.createObjectURL = (_obj: Blob | MediaSource) => 'blob:mock-url'
  URL.revokeObjectURL = (_url: string) => {}
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {}
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {}
  globalThis.fetch = defaultFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
  HTMLAnchorElement.prototype.click = savedAnchorClick
  HTMLFormElement.prototype.submit = savedFormSubmit
  cleanup()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ExportDialog', () => {
  it('initial state — full export: theme & settings on, footer says full export', () => {
    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE, PAGES_TABLE]} />)

    expect(screen.getByRole('dialog')).toBeTruthy()

    // Theme & settings is the default-active category; its switch is on.
    const shellSwitch = screen.getByRole('switch', { name: /include theme & settings in export/i })
    expect(shellSwitch.getAttribute('aria-checked')).toBe('true')

    // Everything is selected → the footer announces a full export.
    expect(screen.getByText(/re-imports into a fresh instance identically/i)).toBeTruthy()
    expect(screen.getByText(/estimated size/i)).toBeTruthy()
  })

  it("toggling the active category's switch flips its aria-checked", () => {
    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE]} />)

    const sw = screen.getByRole('switch', { name: /include theme & settings in export/i })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('selecting the Media category shows its switch, on by default', () => {
    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE]} />)

    const mediaSwitch = openCategory('Media library')
    expect(mediaSwitch.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(mediaSwitch)
    expect(mediaSwitch.getAttribute('aria-checked')).toBe('false')
  })

  it('"Select none" disables Download and updates the footer summary', () => {
    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE, PAGES_TABLE]} />)

    fireEvent.click(screen.getByRole('button', { name: /select none/i }))

    const downloadBtn = screen.getByRole('button', { name: /download bundle/i }) as HTMLButtonElement
    expect(downloadBtn.disabled).toBe(true)
    expect(screen.getByText(/0 of \d+ categories selected/i)).toBeTruthy()
  })

  it('download starts — form body carries every include flag (full export)', async () => {
    let onCloseCalled = false
    let submittedForm: HTMLFormElement | null = null
    let exportFetchCalled = false

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/admin/api/cms/export/summary')) return jsonResponse({ media: 2, mediaFolders: 1, redirects: 1 })
      if (url === '/admin/api/cms/export/estimate') return jsonResponse({ bytes: 1000 })
      if (url === '/admin/api/cms/export') {
        exportFetchCalled = true
        return jsonResponse({ error: 'Export downloads must not go through fetch' }, 500)
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      submittedForm = Array.from(document.forms).find((form) => form.target === this.target) ?? null
    }

    let capturedToasts: Toast[] = []
    const unsub = subscribeToasts((snapshot) => { capturedToasts = [...snapshot] })

    try {
      render(
        <ExportDialog
          open={true}
          onClose={() => { onCloseCalled = true }}
          tables={[POSTS_TABLE, PAGES_TABLE]}
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: /download bundle/i }))

      await waitFor(() => { expect(onCloseCalled).toBe(true) })

      expect(exportFetchCalled).toBe(false)
      expect(submittedForm).not.toBeNull()
      expect(submittedForm!.method.toLowerCase()).toBe('post')
      expect(submittedForm!.action.endsWith('/admin/api/cms/export')).toBe(true)
      expect(submittedForm!.target).toBeTruthy()
      expect(document.querySelector(`iframe[name="${submittedForm!.target}"]`)).toBeTruthy()

      const input = submittedForm!.querySelector('input[name="exportRequest"]') as HTMLInputElement | null
      expect(input).not.toBeNull()
      const body = JSON.parse(input!.value) as {
        tables: { tableId: string; rowIds?: string[] }[]
        includeMedia: boolean
        includeSite: boolean
        includeMediaFolders: boolean
        includeRedirects: boolean
      }
      // Full export → every table listed with no row subset (whole table).
      const ids = body.tables.map((t) => t.tableId)
      expect(ids).toContain('posts')
      expect(ids).toContain('pages')
      expect(body.tables.every((t) => t.rowIds === undefined)).toBe(true)
      expect(body.includeSite).toBe(true)
      expect(body.includeMedia).toBe(true)
      expect(body.includeMediaFolders).toBe(true)
      expect(body.includeRedirects).toBe(true)

      expect(capturedToasts.some((t) => t.kind === 'success' && t.title === 'Export started')).toBe(true)
    } finally {
      unsub()
    }
  })

  it('download start error — inline alert shown, error toast pushed, onClose NOT called', async () => {
    let onCloseCalled = false

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/admin/api/cms/export/summary')) return jsonResponse({ media: 0, mediaFolders: 0, redirects: 0 })
      if (url === '/admin/api/cms/export/estimate') return jsonResponse({ bytes: 1000 })
      return jsonResponse({ error: `Unexpected: ${url}` }, 500)
    }
    HTMLFormElement.prototype.submit = function () {
      throw new Error('Browser refused to start the download')
    }

    let capturedToasts: Toast[] = []
    const unsub = subscribeToasts((snapshot) => { capturedToasts = [...snapshot] })

    try {
      render(<ExportDialog open={true} onClose={() => { onCloseCalled = true }} tables={[POSTS_TABLE]} />)

      fireEvent.click(screen.getByRole('button', { name: /download bundle/i }))

      await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
      expect(onCloseCalled).toBe(false)
      expect(capturedToasts.some((t) => t.kind === 'error' && t.title === 'Export failed')).toBe(true)
    } finally {
      unsub()
    }
  })

  it('Cancel button calls onClose', () => {
    let onCloseCalled = false
    render(<ExportDialog open={true} onClose={() => { onCloseCalled = true }} tables={[POSTS_TABLE]} />)

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCloseCalled).toBe(true)
  })

  it('estimate is fetched and shrinks when media is toggled OFF', async () => {
    // Media is ON by default (full export), so the initial estimate is the large
    // one; turning media off re-requests and the estimate drops.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/admin/api/cms/export/summary')) return jsonResponse({ media: 2, mediaFolders: 1, redirects: 1 })
      if (url === '/admin/api/cms/export/estimate') {
        const body = JSON.parse((init?.body as string) ?? '{}') as { includeMedia?: boolean }
        return jsonResponse({ bytes: body.includeMedia ? 5_000_000 : 12_000 })
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE]} />)

    await waitFor(() => { expect(screen.getByText(/~4\.8 MB/i)).toBeTruthy() })

    const mediaSwitch = openCategory('Media library')
    fireEvent.click(mediaSwitch)
    await waitFor(() => { expect(screen.getByText(/~12 KB/i)).toBeTruthy() })
  })

  it("initialScope='selected' pre-narrows the active table to the grid selection", () => {
    render(
      <ExportDialog
        open={true}
        onClose={() => {}}
        tables={[POSTS_TABLE, PAGES_TABLE]}
        selectedRowIds={['r1', 'r2']}
        activeTableId="posts"
        initialScope="selected"
      />,
    )

    // Opens on the Posts table, pre-narrowed to the 2 selected rows of 5.
    expect(screen.getByText(/2 of 5 entries selected/i)).toBeTruthy()
  })

  it('content table detail lists rows as a checklist; toggling updates the count + request', async () => {
    let submittedForm: HTMLFormElement | null = null
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/admin/api/cms/export/summary')) return jsonResponse({ media: 0, mediaFolders: 0, redirects: 0 })
      if (url === '/admin/api/cms/export/estimate') return jsonResponse({ bytes: 1000 })
      if (url.includes('/data/tables/posts/rows')) {
        return jsonResponse({
          rows: [
            { id: 'p1', tableId: 'posts', localeId: 'default', sharedCells: {}, localization: makeContentLocalization('p1', { slug: 'first' }), publicPath: null, cells: { title: 'First' }, slug: 'first', status: 'published', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', publishedAt: null, scheduledPublishAt: null, deletedAt: null, authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null, author: null, createdBy: null, updatedBy: null, publishedBy: null },
            { id: 'p2', tableId: 'posts', localeId: 'default', sharedCells: {}, localization: makeContentLocalization('p2', { slug: 'second' }), publicPath: null, cells: { title: 'Second' }, slug: 'second', status: 'draft', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', publishedAt: null, scheduledPublishAt: null, deletedAt: null, authorUserId: null, createdByUserId: null, updatedByUserId: null, publishedByUserId: null, author: null, createdBy: null, updatedBy: null, publishedBy: null },
          ],
        })
      }
      if (url === '/admin/api/cms/export') return jsonResponse({ error: 'Export downloads must not go through fetch' }, 500)
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
      submittedForm = Array.from(document.forms).find((form) => form.target === this.target) ?? null
    }

    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE]} />)

    // Open the Posts table — its rows load as a checklist.
    fireEvent.click(screen.getByRole('button', { name: /posts/i }))
    const firstRow = await screen.findByRole('checkbox', { name: /include first/i })
    expect((firstRow as HTMLInputElement).checked).toBe(true)

    // Untick one row → header reflects 1 of 2, and the export request carries
    // an explicit rowIds subset for the posts table.
    fireEvent.click(firstRow)
    await waitFor(() => { expect(screen.getByText(/1 of 2 entries selected/i)).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: /download bundle/i }))
    await waitFor(() => { expect(submittedForm).not.toBeNull() })
    const input = submittedForm!.querySelector('input[name="exportRequest"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    const body = JSON.parse(input!.value) as { tables: { tableId: string; rowIds?: string[] }[] }
    const posts = body.tables.find((t) => t.tableId === 'posts')
    expect(posts?.rowIds).toEqual(['p2'])
  })

  it('an empty category (summary count 0) is disabled', async () => {
    globalThis.fetch = defaultFetch({ media: 0, mediaFolders: 3, redirects: 0 })

    render(<ExportDialog open={true} onClose={() => {}} tables={[POSTS_TABLE]} />)

    // Open the Media category, then wait for the summary to mark it empty.
    fireEvent.click(screen.getByRole('button', { name: /media library/i }))
    await waitFor(() => { expect(screen.getByText(/no media uploaded yet/i)).toBeTruthy() })

    const mediaSwitch = screen.getByRole('switch', { name: /include media library in export/i }) as HTMLButtonElement
    expect(mediaSwitch.disabled).toBe(true)
    expect(mediaSwitch.getAttribute('aria-checked')).toBe('false')
  })
})
