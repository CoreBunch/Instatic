import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SiteExplorerPanel } from '@site/panels/SiteExplorerPanel'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function loadTemplateSite() {
  const homeRoot = makeNode({ id: 'root-home', moduleId: 'base.body' })
  const templateRoot = makeNode({ id: 'root-template', moduleId: 'base.body' })
  templateRoot.dynamicBindings = {
    text: { source: 'currentEntry', field: 'title' },
  }

  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'root-home',
    nodes: { 'root-home': homeRoot },
  })
  const template = makePage({
    id: 'page-template',
    title: 'Post Template',
    slug: 'post-template',
    rootNodeId: 'root-template',
    nodes: { 'root-template': templateRoot },
    template: {
      enabled: true,
      target: { kind: 'postTypes', tableSlugs: ['posts'] },
      priority: 20,
    },
  })

  useEditorStore.setState({
    site: makeSite({ pages: [home, template] }),
    activePageId: home.id,
    activeDocument: { kind: 'page', pageId: home.id },
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

describe('SiteExplorerPanel templates', () => {
  it('shows pages and templates in separate sections', () => {
    loadTemplateSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    const panel = screen.getByTestId('site-explorer-panel')
    const pagesSection = within(panel).getByRole('heading', { name: 'Pages' }).closest('section')!
    const templatesSection = within(panel).getByRole('heading', { name: 'Templates' }).closest('section')!

    expect(within(pagesSection).getByRole('button', { name: /open page home/i })).toBeDefined()
    expect(within(pagesSection).queryByRole('button', { name: /open template post template/i })).toBeNull()
    expect(within(templatesSection).getByRole('button', { name: /open template post template/i })).toBeDefined()
  })

  it('converts a page to a template from the context menu', () => {
    loadTemplateSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /open page home/i }), {
      clientX: 100,
      clientY: 120,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /use as template/i }))

    const dialog = screen.getByRole('dialog', { name: 'Template settings' })
    expect(within(dialog).queryByLabelText('Preview entry ID')).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Priority'), {
      target: { value: '50' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    const page = useEditorStore.getState().site?.pages.find((candidate) => candidate.id === 'page-home')
    expect(page?.template).toMatchObject({
      enabled: true,
      target: { kind: 'everywhere' },
      priority: 50,
    })
  })

  it('targets a chosen post type via the Applies-to selector', async () => {
    let collectionRequests = 0
    globalThis.fetch = async (input: RequestInfo | URL) => {
      if (String(input) === '/admin/api/cms/data/tables') {
        collectionRequests += 1
        return new Response(JSON.stringify({
          tables: [
            {
              id: 'posts',
              name: 'Posts',
              slug: 'posts',
              kind: 'postType',
              routeBase: '/posts',
              singularLabel: 'Post',
              pluralLabel: 'Posts',
              primaryFieldId: 'title',
              fields: [],
              system: true,
              rowCount: 0,
              createdByUserId: null,
              updatedByUserId: null,
              createdAt: '2026-05-01T10:00:00.000Z',
              updatedAt: '2026-05-01T10:00:00.000Z',
            },
            {
              id: 'projects',
              name: 'Projects',
              slug: 'projects',
              kind: 'postType',
              routeBase: '/projects',
              singularLabel: 'Project',
              pluralLabel: 'Projects',
              primaryFieldId: 'title',
              fields: [],
              system: false,
              rowCount: 0,
              createdByUserId: null,
              updatedByUserId: null,
              createdAt: '2026-05-01T10:00:00.000Z',
              updatedAt: '2026-05-01T10:00:00.000Z',
            },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({ error: `Unhandled ${String(input)}` }), { status: 500 })
    }

    loadTemplateSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /open page home/i }), {
      clientX: 100,
      clientY: 120,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /use as template/i }))

    const dialog = screen.getByRole('dialog', { name: 'Template settings' })

    // Switch "Applies to" from Everywhere → Post types (first ArrowDown opens
    // the listbox, the second moves to "Post types", Enter commits).
    const appliesTo = within(dialog).getByRole('combobox', { name: 'Applies to' })
    appliesTo.focus()
    fireEvent.keyDown(appliesTo, { key: 'ArrowDown' })
    fireEvent.keyDown(appliesTo, { key: 'ArrowDown' })
    fireEvent.keyDown(appliesTo, { key: 'Enter' })

    await waitFor(() => expect(collectionRequests).toBe(1))
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'Projects' })).toBeDefined())
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Projects' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    const page = useEditorStore.getState().site?.pages.find((candidate) => candidate.id === 'page-home')
    expect(page?.template?.target).toEqual({ kind: 'postTypes', tableSlugs: ['projects'] })
  })

  it('converts a template back to a page and drops bindings', () => {
    loadTemplateSite()
    render(<SiteExplorerPanel sectionGroup="site" />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /open template post template/i }), {
      clientX: 100,
      clientY: 120,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /convert to page/i }))

    const page = useEditorStore.getState().site?.pages.find((candidate) => candidate.id === 'page-template')
    expect(page?.template).toBeUndefined()
    expect(page?.nodes['root-template'].dynamicBindings).toBeUndefined()
  })
})
