import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { usePersistence } from '@admin/pages/site/hooks/usePersistence'
import { useSiteEditorUrlSync } from '@admin/pages/site/hooks/useSiteEditorUrlSync'
import { requestCmsSiteReload } from '@admin/state/adminEvents'
import { useEditorStore } from '@site/store/store'
import { makeNode, makePage, makeSite } from '../fixtures'
import type { SiteDocument } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { buildCoreFrameworkSettings } from '@core/framework'

afterEach(cleanup)

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

function makeComponent(id: string, name: string): VisualComponent {
  const rootNodeId = `${id}-root`
  return {
    id,
    name,
    tree: {
      rootNodeId,
      nodes: {
        [rootNodeId]: makeNode({ id: rootNodeId, moduleId: 'base.body' }),
      },
    },
    params: [],
    classIds: [],
    createdAt: 1_700_000_000_000,
  }
}

function makeEditorSite(visualComponents: VisualComponent[] = []): SiteDocument {
  const home = makePage({
    id: 'page-home',
    title: 'Home',
    slug: 'index',
    rootNodeId: 'page-home-root',
    nodes: {
      'page-home-root': makeNode({ id: 'page-home-root', moduleId: 'base.body' }),
    },
  })
  return makeSite({ pages: [home], visualComponents })
}

function makeAdapter(site: SiteDocument): IPersistenceAdapter & { loadCount: () => number } {
  let loads = 0
  return {
    async loadSite() {
      loads += 1
      return { site, rowSeqs: {}, shellSeq: 0 }
    },
    async saveSite() {
      return { seq: 1 }
    },
    loadCount: () => loads,
  }
}

function makeControlledAdapter(
  site: SiteDocument,
): IPersistenceAdapter & { loadCount: () => number; resolveNextLoad: () => void } {
  let loads = 0
  const resolvers: Array<() => void> = []
  return {
    async loadSite() {
      loads += 1
      await new Promise<void>((resolve) => resolvers.push(resolve))
      return { site, rowSeqs: {}, shellSeq: 0 }
    },
    async saveSite() {
      return { seq: 1 }
    },
    loadCount: () => loads,
    resolveNextLoad: () => {
      resolvers.shift()?.()
    },
  }
}

function useDeepLinkedSiteEditor(adapter: IPersistenceAdapter) {
  const persistence = usePersistence('default', adapter, { enabled: true })
  useSiteEditorUrlSync({
    enabled: true,
    loaded: persistence.saveStatus.state !== 'loading',
  })
  return persistence
}

beforeEach(() => {
  resetStore()
  window.history.replaceState({}, '', '/')
})

describe('Site editor Data workspace deep links', () => {
  it('reloads a stale editor store before opening a component row created from Data', async () => {
    const freshComponent = makeComponent('component-from-data', 'From Data')
    const staleSite = makeEditorSite([])
    const freshSite = makeEditorSite([freshComponent])
    const adapter = makeAdapter(freshSite)

    useEditorStore.setState({
      site: staleSite,
      activePageId: 'page-home',
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
    window.history.replaceState(
      {},
      '',
      '/admin/site?table=components&row=component-from-data',
    )

    renderHook(() => useDeepLinkedSiteEditor(adapter))

    await waitFor(() => {
      expect(adapter.loadCount()).toBe(1)
      expect(useEditorStore.getState().activeDocument).toEqual({
        kind: 'visualComponent',
        vcId: 'component-from-data',
      })
    })
  })

  it('consumes a pending CMS site reload when mounting with an existing stale site', async () => {
    const freshComponent = makeComponent('component-pending-reload', 'Pending Reload')
    const staleSite = makeEditorSite([])
    const freshSite = makeEditorSite([freshComponent])
    const adapter = makeAdapter(freshSite)

    useEditorStore.setState({
      site: staleSite,
      activePageId: 'page-home',
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
    requestCmsSiteReload()

    renderHook(() => usePersistence('default', adapter, { enabled: true }))

    await waitFor(() => {
      expect(adapter.loadCount()).toBe(1)
      expect(
        useEditorStore.getState().site?.visualComponents.some(
          (component) => component.id === 'component-pending-reload',
        ),
      ).toBe(true)
    })
  })

  it('retains a pending CMS site reload when a mount is cancelled before the fresh site hydrates', async () => {
    const staleSite = makeEditorSite([])
    const freshSite = makeEditorSite([])
    freshSite.settings.framework = buildCoreFrameworkSettings({ includeUtilities: true })
    const adapter = makeControlledAdapter(freshSite)

    useEditorStore.setState({
      site: staleSite,
      activePageId: 'page-home',
      hasUnsavedChanges: false,
    } as Parameters<typeof useEditorStore.setState>[0])
    requestCmsSiteReload()

    const firstMount = renderHook(() => usePersistence('default', adapter, { enabled: true }))
    await waitFor(() => {
      expect(adapter.loadCount()).toBe(1)
    })
    firstMount.unmount()
    adapter.resolveNextLoad()
    await new Promise((resolve) => setTimeout(resolve, 0))

    await waitFor(() => {
      expect(useEditorStore.getState().site?.settings.framework).toBeUndefined()
    })

    renderHook(() => usePersistence('default', adapter, { enabled: true }))

    await waitFor(() => {
      expect(adapter.loadCount()).toBe(2)
    })
    adapter.resolveNextLoad()

    await waitFor(() => {
      expect(useEditorStore.getState().site?.settings.framework).toBeDefined()
    })
  })
})
