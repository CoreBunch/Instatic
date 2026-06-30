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

function frameworkRuleCount(): number {
  return Object.keys(useEditorStore.getState().site!.styleRules).filter((id) =>
    id.startsWith('framework:'),
  ).length
}

describe('framework manager store actions', () => {
  it('setFrameworkPreset("full") seeds the framework and generates locked classes', () => {
    useEditorStore.getState().setFrameworkPreset('full')
    const state = useEditorStore.getState()
    expect(state.site!.settings.framework!.colors.tokens.length).toBe(13)
    // Reconcile produced framework-prefixed locked classes in the registry.
    expect(frameworkRuleCount()).toBeGreaterThan(0)
  })

  it('setFrameworkPreset merges (adds missing) without duplicating existing tokens', () => {
    useEditorStore.getState().setFrameworkPreset('variables')
    const before = useEditorStore.getState().site!.settings.framework!.colors.tokens.length
    // Switch to the other state — already-present slugs are not duplicated.
    useEditorStore.getState().setFrameworkPreset('full')
    const after = useEditorStore.getState().site!.settings.framework!.colors.tokens.length
    expect(after).toBe(before)
  })

  it('switching full → variables strips utility classes; variables → full restores them', () => {
    useEditorStore.getState().setFrameworkPreset('full')
    expect(frameworkRuleCount()).toBeGreaterThan(0)

    // Variables-only: every :root variable stays but no utility class survives.
    useEditorStore.getState().setFrameworkPreset('variables')
    expect(frameworkRuleCount()).toBe(0)
    expect(useEditorStore.getState().site!.settings.framework).toBeDefined()

    // Back to full: the canonical preset utilities come back.
    useEditorStore.getState().setFrameworkPreset('full')
    expect(frameworkRuleCount()).toBeGreaterThan(0)
  })

  it('setFrameworkPreset("none") clears the framework and is undoable', () => {
    useEditorStore.setState({
      site: {
        ...makeSite(),
        settings: { framework: buildCoreFrameworkSettings({ includeUtilities: true }) },
      },
    } as Parameters<typeof useEditorStore.setState>[0])

    useEditorStore.getState().setFrameworkPreset('none')
    expect(useEditorStore.getState().site!.settings.framework).toBeUndefined()
    // No framework-prefixed classes survive in the registry.
    expect(frameworkRuleCount()).toBe(0)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.settings.framework).toBeDefined()
  })
})
