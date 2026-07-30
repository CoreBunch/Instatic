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
import type { DataRow, DataTable } from '@core/data/schemas'
import { useContentToolBridge } from '@admin/pages/content/agent/useContentToolBridge'
import { getContentBridgeHandle } from '@admin/pages/content/agent/contentBridgeHandle'

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
