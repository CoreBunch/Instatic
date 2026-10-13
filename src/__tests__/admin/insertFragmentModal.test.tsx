/**
 * InsertFragmentModal — pick a package, review the plan, insert, read the report.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { InsertFragmentModal } from '@admin/modals/InsertFragment'
import { getAllCommands } from '@admin/spotlight/builtinCommands'
import { useEditorStore } from '@site/store/store'
import { extractFragment, fragmentSourceFromSite, writeFragmentPackage } from '@core/fragments'
import type { StyleRule } from '@core/page-tree'
import { makeNode, makePage, makeSite } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

const realFetch = globalThis.fetch

function rule(id: string, name: string, styles: Record<string, unknown>): StyleRule {
  return { id, name, kind: 'class', selector: `.${name}`, order: 0, styles, contextStyles: {}, createdAt: 1, updatedAt: 1 }
}

async function packageFile(): Promise<File> {
  const source = makeSite({
    pages: [makePage({
      id: 'src-page',
      rootNodeId: 'src-body',
      nodes: {
        'src-body': makeNode({ id: 'src-body', moduleId: 'base.body', children: ['src-banner'] }),
        'src-banner': makeNode({ id: 'src-banner', moduleId: 'base.container', classIds: ['src-banner-class'], children: ['src-text'] }),
        'src-text': makeNode({ id: 'src-text', moduleId: 'base.text', props: { text: 'From the library' } }),
      },
    })],
    styleRules: { 'src-banner-class': rule('src-banner-class', 'banner', { padding: '2rem' }) },
  })
  const { fragment, mediaBytes } = await extractFragment(fragmentSourceFromSite(source), { pageId: 'src-page', rootNodeIds: ['src-banner'] })
  const bytes = writeFragmentPackage({ ...fragment, origin: { item: 'banner-1' } }, mediaBytes)
  return new File([bytes.slice().buffer as ArrayBuffer], 'banner.zip', { type: 'application/zip' })
}

beforeEach(() => {
  localStorage.clear()
  globalThis.fetch = (async () => new Response(JSON.stringify({ tables: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch
  useEditorStore.setState({
    site: makeSite({
      pages: [makePage({
        id: 'page-1',
        rootNodeId: 'root-1',
        nodes: { 'root-1': makeNode({ id: 'root-1', moduleId: 'base.body', children: [] }) },
      })],
    }),
    activePageId: 'page-1',
    activeDocument: { kind: 'page', pageId: 'page-1' },
    insertFragmentModalOpen: true,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('Insert fragment', () => {
  it('Spotlight offers the command in the site editor and it opens the dialog', async () => {
    useEditorStore.setState({ insertFragmentModalOpen: false })
    const command = getAllCommands().find((c) => c.id === 'editor.insertFragment')
    expect(command?.workspaces).toEqual(['site'])
    await command!.run({ closeSpotlight: () => {} } as unknown as Parameters<NonNullable<typeof command>['run']>[0])
    expect(useEditorStore.getState().insertFragmentModalOpen).toBe(true)
  })

  it('reviews the plan, inserts on confirm, and reports what was added', async () => {
    render(<InsertFragmentModal />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [await packageFile()] } })

    const willAdd = await screen.findByRole('region', { name: 'Will add' })
    expect(within(willAdd).getByText('banner')).toBeTruthy()
    expect(screen.getByText('banner-1', { exact: false })).toBeTruthy()
    // Nothing changes before Insert.
    expect(useEditorStore.getState().site!.pages[0].nodes['root-1'].children).toEqual([])

    fireEvent.click(screen.getByTestId('insert-fragment-confirm'))
    await screen.findByRole('region', { name: 'Added' })

    const page = useEditorStore.getState().site!.pages[0]
    const [bannerId] = page.nodes['root-1'].children
    expect(bannerId).toBeDefined()
    const banner = page.nodes[bannerId]
    expect(useEditorStore.getState().site!.styleRules[banner.classIds[0]].name).toBe('banner')
    expect(useEditorStore.getState().selectedNodeId).toBe(bannerId)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy())
  })
})
