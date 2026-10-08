/**
 * A Content workspace caches its collection roster at mount. A post type
 * created after that — by an import, another admin, or an MCP connector
 * building a site — was invisible to the bridge, so every write against it
 * failed with "Collection not found" until someone reloaded the page.
 *
 * The bridge now refreshes the roster once before rejecting an unknown id.
 * These tests exercise the resolution path only; they never reach the network
 * (a rejected id fails before any row request, and the accepted cases assert
 * on the refresh rather than on document creation).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { renderHook, cleanup } from '@testing-library/react'
import type { DataLocalization, DataRow, DataTable } from '@core/data/schemas'
import { useContentToolBridge } from '@admin/pages/content/agent/useContentToolBridge'
import { getContentBridgeHandle } from '@admin/pages/content/agent/contentBridgeHandle'
import type { LocalizedDataState } from '@admin/pages/data/localizedData'
import { LocalizationError } from '@core/localization'

function table(id: string): DataTable {
  return {
    id,
    name: id,
    slug: id,
    kind: 'postType',
    routeBase: `/${id}`,
    fields: [],
  } as unknown as DataTable
}

/** Workspace whose roster starts stale and only learns `recipes` on refresh. */
function staleWorkspace() {
  let collections = [table('posts')]
  const refreshCollections = mock(async () => {
    collections = [table('posts'), table('recipes')]
    return collections
  })
  const selectCollection = mock(() => {})
  return {
    surface: {
      get collections() { return collections },
      refreshCollections,
      entries: [] as DataRow[],
      selectedEntry: null,
      selectedCollectionId: 'posts',
      selectCollection,
      openEntry: () => true,
      deleteEntry: async () => null,
      updateEntryStatus: async (row: DataRow) => row,
      updateEntryAuthor: async (row: DataRow) => row,
      updateSelectedEntry: () => {},
    },
    refreshCollections,
    selectCollection,
  }
}

const draft = {
  setTitle: () => {}, setSlug: () => {}, setSeoTitle: () => {}, setSeoDescription: () => {},
  setFeaturedMediaId: () => {}, setBody: () => {}, setCustomCell: () => {}, applySelectedEntry: () => {},
}
const currentUser = { id: 'u1', displayName: 'Tester', email: 't@example.invalid' }

function mountBridge(workspace: ReturnType<typeof staleWorkspace>) {
  renderHook(() =>
    useContentToolBridge({
      workspace: workspace.surface as never,
      draft,
      currentUser,
    }),
  )
  const handle = getContentBridgeHandle()
  if (!handle) throw new Error('content bridge handle not registered')
  return handle
}

afterEach(cleanup)

describe('content bridge collection resolution', () => {
  it('refreshes the roster and selects a collection created after mount', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    expect(await handle.selectCollection('recipes')).toBe(true)
    expect(workspace.refreshCollections).toHaveBeenCalledTimes(1)
    expect(workspace.selectCollection).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when the collection is already known', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    expect(await handle.selectCollection('posts')).toBe(true)
    expect(workspace.refreshCollections).not.toHaveBeenCalled()
  })

  it('still reports a genuinely unknown collection as missing', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    expect(await handle.selectCollection('nope')).toBe(false)
    expect(workspace.refreshCollections).toHaveBeenCalledTimes(1)
  })

  it('refuses to create in an unknown collection before issuing any row request', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    await expect(handle.createDocument({ tableId: 'nope' })).rejects.toThrow(/not found/)
    expect(workspace.refreshCollections).toHaveBeenCalledTimes(1)
  })
})

describe('content bridge explicit language snapshot', () => {
  function localizedWorkspace() {
    const cells = { heading: { key: 'entry.title' }, cards: [{ id: 'stable', cells: { caption: { key: 'entry.caption' } } }] }
    const collection: DataTable = { ...table('posts'), primaryFieldId: 'heading', fields: [
      { id: 'heading', label: 'Heading', type: 'localizedText' },
      { id: 'cards', label: 'Cards', type: 'repeater', fields: [{ id: 'caption', label: 'Caption', type: 'localizedText' }] },
    ] }
    const row = { id: 'article', tableId: 'posts', cells, slug: 'url', status: 'draft', authorUserId: 'u1', updatedAt: '2026-10-08' } as DataRow
    return { ...staleWorkspace().surface, collections: [collection], entries: [row], selectedEntry: row }
  }

  function languageState(language = ''): LocalizedDataState {
    const translations = language === 'de' ? { entry: { title: 'Sicherheit', caption: 'Bildunterschrift' } }
      : { entry: { title: 'Sicurezza', caption: 'Didascalia' } }
    const data: DataLocalization = language ? { languages: ['it', 'de'], canBrowseCatalogue: false, language, translations }
      : { languages: ['it', 'de'], canBrowseCatalogue: false }
    return { language, setLanguage: () => {}, loading: false, error: null, required: true, refresh: () => {},
      context: language ? { language, translations } : undefined,
      data }
  }

  it('withholds the localized document title and cells until the shared workspace language is chosen', () => {
    const workspace = localizedWorkspace()
    renderHook(() => useContentToolBridge({ workspace, draft, currentUser, localization: languageState() }))
    const snapshot = getContentBridgeHandle().buildSnapshot()
    expect(snapshot.localization).toEqual({ languages: ['it', 'de'], canBrowseCatalogue: false })
    expect(snapshot.activeDocument?.title).toBeNull()
    expect(snapshot.activeDocument?.fields).toBeNull()
    expect(snapshot.activeDocument?.schema[0]).toMatchObject({ type: 'localizedText', writeShape: '{ key: string }' })
  })

  it('updates snapshot language independently of stored scalar and repeater references', () => {
    const workspace = localizedWorkspace()
    const before = structuredClone(workspace.selectedEntry.cells)
    const { rerender } = renderHook(({ localization }: { localization: LocalizedDataState }) =>
      useContentToolBridge({ workspace, draft, currentUser, localization }), { initialProps: { localization: languageState('it') } })
    expect(getContentBridgeHandle().buildSnapshot().activeDocument?.title).toBe('Sicurezza')
    rerender({ localization: languageState('de') })
    const snapshot = getContentBridgeHandle().buildSnapshot()
    expect(snapshot.activeDocument?.title).toBe('Sicherheit')
    expect(snapshot.activeDocument?.fields?.cards).toEqual([{ id: 'stable', cells: { caption: 'Bildunterschrift' } }])
    expect(workspace.selectedEntry.cells).toEqual(before)
    rerender({ localization: { ...languageState('it'), loading: true, context: undefined } })
    expect(getContentBridgeHandle().buildSnapshot().activeDocument?.title).toBeNull()
    expect(getContentBridgeHandle().buildSnapshot().activeDocument?.fields).toBeNull()
  })

  it('reports a missing translation instead of showing the reference key or another language', () => {
    const workspace = localizedWorkspace()
    renderHook(() => useContentToolBridge({ workspace, draft, currentUser,
      localization: { ...languageState('de'), context: { language: 'de', translations: {} } } }))
    expect(() => getContentBridgeHandle().buildSnapshot()).toThrow(LocalizationError)
  })
})
