import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { buildCoreFrameworkSettings } from '@core/framework'
import { makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: makeSite(),
    activePageId: 'page-1',
    selectedNodeId: null,
    selectedNodeIds: [],
    activeClassId: null,
    selectedSelectorClassId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

describe('framework manager store actions', () => {
  it('importCoreFramework seeds the framework and generates locked classes', () => {
    useEditorStore.getState().importCoreFramework('full')
    const state = useEditorStore.getState()
    expect(state.site!.settings.framework!.colors.tokens.length).toBe(13)
    // Reconcile produced framework-prefixed locked classes in the registry.
    const frameworkRuleIds = Object.keys(state.site!.styleRules).filter((id) =>
      id.startsWith('framework:'),
    )
    expect(frameworkRuleIds.length).toBeGreaterThan(0)
  })

  it('importCoreFramework merges (adds missing) without dropping existing tokens', () => {
    useEditorStore.getState().importCoreFramework('variables')
    const before = useEditorStore.getState().site!.settings.framework!.colors.tokens.length
    // Re-import with the other mode — already-present slugs are not duplicated.
    useEditorStore.getState().importCoreFramework('full')
    const after = useEditorStore.getState().site!.settings.framework!.colors.tokens.length
    expect(after).toBe(before)
  })

  it('removeFrameworkCompletely clears the framework and is undoable', () => {
    useEditorStore.setState({
      site: {
        ...makeSite(),
        settings: { framework: buildCoreFrameworkSettings({ includeUtilities: true }) },
      },
    } as Parameters<typeof useEditorStore.setState>[0])

    useEditorStore.getState().removeFrameworkCompletely()
    expect(useEditorStore.getState().site!.settings.framework).toBeUndefined()
    // No framework-prefixed classes survive in the registry.
    const remaining = Object.keys(useEditorStore.getState().site!.styleRules).filter((id) =>
      id.startsWith('framework:'),
    )
    expect(remaining.length).toBe(0)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.settings.framework).toBeDefined()
  })

  it('pruneUnusedFrameworkClasses removes tokens whose classes are unused', () => {
    useEditorStore.getState().importCoreFramework('full')
    const before = useEditorStore.getState().site!.settings.framework!.colors.tokens.length
    // Nothing in the fixture assigns framework classes, so every utility-
    // generating token is prunable (variable-only tokens stay).
    useEditorStore.getState().pruneUnusedFrameworkClasses()
    const after = useEditorStore.getState().site!.settings.framework!.colors.tokens.length
    expect(after).toBeLessThan(before)
  })
})
