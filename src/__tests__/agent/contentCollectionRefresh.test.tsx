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

function table(id: string, kind: DataTable['kind'] = 'postType'): DataTable {
  return {
    id,
    name: id,
    slug: id,
    kind,
    routeBase: kind === 'postType' ? `/${id}` : '',
    fields: [],
  } as unknown as DataTable
}

/**
 * Workspace whose roster starts stale and only learns `recipes` (a post type)
 * and `trainings` (a reusable data table) on refresh.
 */
function staleWorkspace() {
  let tables = [table('posts')]
  const refreshTables = mock(async () => {
    tables = [table('posts'), table('recipes'), table('trainings', 'data')]
    return tables
  })
  const selectCollection = mock(() => {})
  return {
    surface: {
      get collections() { return tables.filter((t) => t.kind === 'postType') },
      get tables() { return tables },
      refreshTables,
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
    refreshTables,
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

    await handle.selectCollection('recipes')
    expect(workspace.refreshTables).toHaveBeenCalledTimes(1)
    expect(workspace.selectCollection).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when the collection is already known', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    await handle.selectCollection('posts')
    expect(workspace.refreshTables).not.toHaveBeenCalled()
  })

  it('still reports a genuinely unknown collection as missing', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    await expect(handle.selectCollection('nope')).rejects.toThrow(/not found/)
    expect(workspace.refreshTables).toHaveBeenCalledTimes(1)
  })

  it('tells the caller a reusable data table is real but authored elsewhere', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    // Issue #463: "not found" made agents re-create a table that already
    // existed. The refusal names the toolset that can actually write it.
    await expect(handle.selectCollection('trainings')).rejects.toThrow(/data_create_rows/)
    expect(workspace.selectCollection).not.toHaveBeenCalled()
  })

  it('refuses to create in an unknown collection before issuing any row request', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    await expect(handle.createDocument({ tableId: 'nope' })).rejects.toThrow(/not found/)
    expect(workspace.refreshTables).toHaveBeenCalledTimes(1)
  })

  it('refuses to create a document in a data table, naming the row tool', async () => {
    const workspace = staleWorkspace()
    const handle = mountBridge(workspace)

    await expect(handle.createDocument({ tableId: 'trainings' })).rejects.toThrow(/data_create_rows/)
  })
})
