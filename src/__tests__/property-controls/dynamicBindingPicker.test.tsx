/**
 * dynamicBindingPicker.test.tsx
 *
 * Tests for the shared DataBindingPicker UX inside DynamicBindingControl.
 * Uses globalThis.fetch mocking (same pattern as templatePreviewBindings.test.tsx)
 * to intercept the DataMeta API call.
 *
 * The picker is a `role="menu"` popover (ContextMenu primitive). Clicks on
 * field rows fire `onPick` immediately — no Confirm step. In insert mode
 * the popover stays open after each pick so authors can insert multiple
 * tokens; in bind mode the parent closes the popover after a single pick.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DynamicBindingControl } from '@site/property-controls/DynamicBindingControl'
import { clearDataMetaCache } from '@admin/shared/DataBindingPicker/cache'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import type { DynamicPropBinding } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const postsTable = {
  id: 'posts-id',
  slug: 'posts',
  name: 'Posts',
  kind: 'postType',
  singularLabel: 'Post',
  pluralLabel: 'Posts',
  primaryFieldId: 'title',
  routable: true,
  versioned: true,
  system: true,
  fields: [
    { id: 'title', label: 'Title', type: 'text' },
    { id: 'slug', label: 'Slug', type: 'text' },
    { id: 'body', label: 'Body', type: 'richText' },
    { id: 'featuredMedia', label: 'Featured media', type: 'media', mediaKind: 'image' },
    { id: 'seoTitle', label: 'SEO title', type: 'text' },
  ],
}

const productsTable = {
  id: 'products-id',
  slug: 'products',
  name: 'Products',
  kind: 'data',
  singularLabel: 'Product',
  pluralLabel: 'Products',
  primaryFieldId: 'name',
  routable: false,
  versioned: false,
  system: false,
  fields: [
    { id: 'name', label: 'Name', type: 'text' },
    { id: 'price', label: 'Price', type: 'number' },
    { id: 'thumbnail', label: 'Thumbnail', type: 'media', mediaKind: 'image' },
  ],
}

const mockDataMeta = {
  meta: { tables: [postsTable, productsTable] },
}

const productRow = {
  id: 'product-row-1',
  tableId: 'products-id',
  cells: { name: 'Featured product', price: 42, thumbnail: null },
  slug: '',
  status: 'published',
  seq: 1,
  authorUserId: null,
  createdByUserId: null,
  updatedByUserId: null,
  publishedByUserId: null,
  author: null,
  createdBy: null,
  updatedBy: null,
  publishedBy: null,
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  publishedAt: '2026-08-14T00:00:00.000Z',
  scheduledPublishAt: null,
  deletedAt: null,
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

beforeEach(() => {
  clearDataMetaCache()
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('/data/_meta')) {
      return new Response(JSON.stringify(mockDataMeta), { status: 200 })
    }
    if (String(input).includes('/data/tables/products-id/rows')) {
      return new Response(JSON.stringify({ rows: [productRow] }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  cleanup()
  clearDataMetaCache()
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBinding(
  props: {
    control?: DynamicBindingControl extends { props: infer P } ? Partial<P> : never
    onSet?: (b: DynamicPropBinding) => void
    onClear?: () => void
    binding?: DynamicPropBinding
  } = {},
) {
  const onSet = props.onSet ?? (() => {})
  const onClear = props.onClear ?? (() => {})
  return render(
    <DynamicBindingControl
      propKey="text"
      label="Text"
      control={{ type: 'text', label: 'Text' }}
      onSet={onSet}
      onClear={onClear}
      binding={props.binding}
    >
      <input aria-label="Text" />
    </DynamicBindingControl>,
  )
}

function loadTemplatePageInStore(tableSlug = 'posts') {
  const root = makeNode({ id: 'root', moduleId: 'base.body', children: ['text-1'] })
  const text = makeNode({ id: 'text-1', moduleId: 'base.text', props: { text: 'Hello', tag: 'p' } })
  const page = makePage({
    id: 'page-1',
    slug: 'posts-template',
    rootNodeId: 'root',
    nodes: { root, 'text-1': text },
    template: {
      enabled: true,
      target: { kind: 'postTypes', tableSlugs: [tableSlug] },
      priority: 100,
    },
  })
  useEditorStore.setState({
    site: makeSite({ pages: [page] }),
    activePageId: page.id,
  } as Parameters<typeof useEditorStore.setState>[0])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DynamicBindingControl picker', () => {
  it('renders the binding affordance button in unbound state', () => {
    renderBinding()
    expect(screen.getByRole('button', { name: /bind text/i })).toBeDefined()
  })

  it('opens the popover menu when the affordance button is clicked', async () => {
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => {
      expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined()
    })
  })

  it('offers custom data rows globally while keeping post-type fields scoped', async () => {
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => {
      expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined()
    })
    // Post-type fields still need a currentEntry scope.
    expect(screen.queryByText(/Posts fields/i)).toBeNull()
    // Plain custom data rows are stable global sources on any page.
    await waitFor(() => {
      expect(screen.getByText('Products — Featured product')).toBeDefined()
    })
    expect(screen.getByText('Name')).toBeDefined()
    expect(screen.getByText('Price')).toBeDefined()
    // The footer still explains how to reach the scoped Posts fields.
    await waitFor(() => {
      expect(screen.getByText(/Wrap in a Loop or open a postType template/i)).toBeDefined()
    })
  })

  it('does not expose internal page or site bookkeeping fields', async () => {
    loadTemplatePageInStore('posts')
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined())
    await waitFor(() => expect(screen.getByText('Page title')).toBeDefined())

    expect(screen.queryByText('Page id')).toBeNull()
    expect(screen.queryByText('Site id')).toBeNull()
    expect(screen.queryByText('Is template')).toBeNull()
    expect(screen.queryByText('Template table slug')).toBeNull()
  })

  it('shows post-type fields directly when auto-scoped to a template page', async () => {
    // Auto-scope: a template page is bound to the `posts` table, so the
    // picker leads with that table's fields.
    loadTemplatePageInStore('posts')
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => {
      expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined()
    })
    await waitFor(() => {
      expect(screen.getByText('Title')).toBeDefined()
    })
    // The Posts group header is rendered with the table name.
    expect(screen.getByText(/Posts fields/i)).toBeDefined()
    // Posts-specific field labels (not duplicated by system sources).
    expect(screen.getByText('SEO title')).toBeDefined()
    // "Slug" exists in both Posts and the Page system source — use
    // getAllByText since the single-pane layout now surfaces both.
    expect(screen.getAllByText('Slug').length).toBeGreaterThanOrEqual(1)
  })

  it('hides media fields when control type is text (auto-scoped)', async () => {
    loadTemplatePageInStore('posts')
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined())
    await waitFor(() => expect(screen.getByText('Title')).toBeDefined())

    expect(screen.queryByText('Featured media')).toBeNull()
  })

  it('calls onSet immediately when a field row is clicked (bind mode, auto-scoped)', async () => {
    // Bind mode: image-control case is the canonical single-shot path
    // because text controls run insert-mode. We simulate bind mode here
    // by using an image control whose first compatible field is Featured
    // media — clicking it should commit the binding without any Confirm
    // step.
    let result: DynamicPropBinding | undefined
    loadTemplatePageInStore('posts')
    render(
      <DynamicBindingControl
        propKey="src"
        label="Image"
        control={{ type: 'image', label: 'Image' }}
        onSet={(b) => { result = b }}
        onClear={() => {}}
      >
        <input aria-label="Image" />
      </DynamicBindingControl>,
    )

    fireEvent.click(screen.getByRole('button', { name: /bind image/i }))
    await waitFor(() => expect(screen.getByRole('menu', { name: /bind image/i })).toBeDefined())
    await waitFor(() => expect(screen.getByText('Featured media')).toBeDefined())

    // Click the Featured media field — should fire onSet immediately.
    const featuredBtn = screen.getAllByRole('button').find((b) =>
      b.textContent?.includes('Featured media'),
    )
    fireEvent.click(featuredBtn!)

    expect(result).toMatchObject({
      source: 'currentEntry',
      field: 'featuredMedia',
      format: 'media',
    })
  })

  it('shows the auto-scope chip and surfaces table fields when the page targets a post type', async () => {
    loadTemplatePageInStore('posts')
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined())
    await waitFor(() => expect(screen.getByText('Title')).toBeDefined())

    // Auto-scope chip should appear
    expect(screen.getByText(/Current row — Posts/i)).toBeDefined()
    // The single-pane layout no longer renders source buttons.
    expect(screen.queryByRole('button', { name: /^Posts$/i })).toBeNull()
  })

  it('renders loop synthetic fields as a group when availableFields are provided', async () => {
    render(
      <DynamicBindingControl
        propKey="text"
        label="Text"
        control={{ type: 'text', label: 'Text' }}
        onSet={() => {}}
        onClear={() => {}}
        availableFields={[
          { id: 'postTitle', label: 'Post title' },
          { id: 'postSlug', label: 'Post slug' },
        ]}
        sourceLabel="Posts loop"
      >
        <input aria-label="Text" />
      </DynamicBindingControl>,
    )
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined())

    // Loop fields appear as a group header with the source label
    await waitFor(() => {
      expect(screen.getByText(/Posts loop fields/i)).toBeDefined()
    })
    // And the synthetic fields are individually clickable rows.
    expect(screen.getByText('Post title')).toBeDefined()
    expect(screen.getByText('Post slug')).toBeDefined()
  })

  it('toggles the popover closed when the affordance button is clicked again', async () => {
    renderBinding()
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => expect(screen.getByRole('menu', { name: /bind text/i })).toBeDefined())
    // Re-query the affordance button before clicking again: opening the picker
    // re-creates its DOM node, so a reference captured before opening is detached
    // and never receives the click. Clicking the fresh node toggles it closed.
    fireEvent.click(screen.getByRole('button', { name: /bind text/i }))
    await waitFor(() => expect(screen.queryByRole('menu', { name: /bind text/i })).toBeNull())
  })
})
