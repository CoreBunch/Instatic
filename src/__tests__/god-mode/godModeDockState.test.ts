/**
 * God Mode — ticket 01 store/persistence/catalog seams.
 *
 * Covers the non-visual contract of the God Mode toggle + Code Dock shell:
 *   - uiSlice god-mode/dock state and actions
 *   - right-sidebar suppression while God Mode is active
 *   - per-workspace layout persistence of dock state
 *   - the capability-gated preference catalog entry
 *   - the spotlight command + keybinding
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore, selectRightSidebarExpanded } from '@site/store/store'
import {
  selectSiteLayoutState,
  siteLayoutFromSelection,
  restoreStoredSiteEditorLayout,
} from '@site/layout/siteEditorLayoutPersistence'
import {
  CODE_DOCK_MIN_HEIGHT,
  CODE_DOCK_MAX_HEIGHT,
  CODE_DOCK_MIN_COLUMN_WEIGHT,
} from '@site/store/slices/codeDockSlice'
import { PREFERENCE_CATALOG } from '@site/preferences/catalog'
import { getGodModeCommands } from '@admin/spotlight/commands/godMode'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'

function resetGodModeState() {
  useEditorStore.setState({
    godModeActive: false,
    codeDockHeight: 280,
    codeDockPanels: { html: true, css: true, js: true },
    codeDockActiveTab: 'html',
    codeDockColumnWeights: { html: 1, css: 1, js: 1 },
    selectedNodeId: null,
    selectedSelectorClassId: null,
    selectedSelectorClassIds: [],
    propertiesPanelMode: 'docked',
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.setState((s) => {
    s.propertiesPanel.collapsed = false
  })
}

describe('uiSlice — god mode + code dock state', () => {
  beforeEach(resetGodModeState)

  it('defaults: god mode off, all dock panels visible, html tab active', () => {
    const s = useEditorStore.getState()
    expect(s.godModeActive).toBe(false)
    expect(s.codeDockPanels).toEqual({ html: true, css: true, js: true })
    expect(s.codeDockActiveTab).toBe('html')
  })

  it('toggleGodMode flips the active flag', () => {
    useEditorStore.getState().toggleGodMode()
    expect(useEditorStore.getState().godModeActive).toBe(true)
    useEditorStore.getState().toggleGodMode()
    expect(useEditorStore.getState().godModeActive).toBe(false)
  })

  it('setCodeDockHeight clamps to the min/max range', () => {
    const s = useEditorStore.getState()
    s.setCodeDockHeight(10)
    expect(useEditorStore.getState().codeDockHeight).toBe(CODE_DOCK_MIN_HEIGHT)
    s.setCodeDockHeight(99999)
    expect(useEditorStore.getState().codeDockHeight).toBe(CODE_DOCK_MAX_HEIGHT)
    s.setCodeDockHeight(300)
    expect(useEditorStore.getState().codeDockHeight).toBe(300)
  })

  it('toggleCodeDockPanel hides and shows a single column, restoring a squeezed column to an equal share', () => {
    useEditorStore.getState().setCodeDockColumnWeights({ html: 1.5, css: 0.3, js: 1.2 })
    useEditorStore.getState().toggleCodeDockPanel('css')
    expect(useEditorStore.getState().codeDockPanels).toEqual({
      html: true,
      css: false,
      js: true,
    })
    useEditorStore.getState().toggleCodeDockPanel('css')
    expect(useEditorStore.getState().codeDockPanels.css).toBe(true)
    expect(useEditorStore.getState().codeDockColumnWeights).toEqual({ html: 1.5, css: 1, js: 1.2 })
  })

  it('setCodeDockColumnWeights floors each weight so no column can vanish', () => {
    useEditorStore.getState().setCodeDockColumnWeights({ html: 2, css: 0.001, js: 1 })
    expect(useEditorStore.getState().codeDockColumnWeights).toEqual({ html: 2, css: CODE_DOCK_MIN_COLUMN_WEIGHT, js: 1 })
    useEditorStore.getState().setCodeDockColumnWeights({ html: 0, css: 1, js: 1 })
    expect(useEditorStore.getState().codeDockColumnWeights).toEqual({ html: 2, css: CODE_DOCK_MIN_COLUMN_WEIGHT, js: 1 })
  })

  it('setCodeDockActiveTab switches the narrow-mode tab', () => {
    useEditorStore.getState().setCodeDockActiveTab('js')
    expect(useEditorStore.getState().codeDockActiveTab).toBe('js')
  })

  it('setCodeDockColumnWeights replaces weights and rejects non-positive values', () => {
    useEditorStore.getState().setCodeDockColumnWeights({ html: 2, css: 1, js: 1 })
    expect(useEditorStore.getState().codeDockColumnWeights).toEqual({
      html: 2,
      css: 1,
      js: 1,
    })
    useEditorStore.getState().setCodeDockColumnWeights({ html: 0, css: -1, js: 1 })
    // invalid weights are ignored — previous weights stay
    expect(useEditorStore.getState().codeDockColumnWeights).toEqual({
      html: 2,
      css: 1,
      js: 1,
    })
  })
})

describe('selectRightSidebarExpanded — suppressed by god mode', () => {
  beforeEach(resetGodModeState)

  it('expands on node selection when god mode is off', () => {
    useEditorStore.setState({ selectedNodeId: 'node-1' } as never)
    expect(selectRightSidebarExpanded(useEditorStore.getState())).toBe(true)
  })

  it('stays collapsed while god mode is active, even with a selection', () => {
    useEditorStore.setState({ selectedNodeId: 'node-1', godModeActive: true } as never)
    expect(selectRightSidebarExpanded(useEditorStore.getState())).toBe(false)
  })
})

describe('site layout persistence — code dock fields', () => {
  beforeEach(resetGodModeState)

  it('projects god mode + dock state into the stored layout', () => {
    useEditorStore.setState({
      godModeActive: true,
      codeDockHeight: 333,
      codeDockPanels: { html: true, css: false, js: true },
      codeDockActiveTab: 'css',
      codeDockColumnWeights: { html: 2, css: 1, js: 1 },
    } as never)
    const stored = siteLayoutFromSelection(
      selectSiteLayoutState(useEditorStore.getState()),
    )
    expect(stored.godModeActive).toBe(true)
    expect(stored.codeDockHeight).toBe(333)
    expect(stored.codeDockPanels).toEqual({ html: true, css: false, js: true })
    expect(stored.codeDockActiveTab).toBe('css')
    expect(stored.codeDockColumnWeights).toEqual({ html: 2, css: 1, js: 1 })
  })

  it('restores dock state from a stored layout, clamping height', () => {
    restoreStoredSiteEditorLayout(useEditorStore, {
      godModeActive: true,
      codeDockHeight: 5,
      codeDockPanels: { html: false, css: true, js: true },
      codeDockActiveTab: 'js',
      codeDockColumnWeights: { html: 1, css: 3, js: 1 },
    })
    const s = useEditorStore.getState()
    expect(s.godModeActive).toBe(true)
    expect(s.codeDockHeight).toBe(CODE_DOCK_MIN_HEIGHT)
    expect(s.codeDockPanels).toEqual({ html: false, css: true, js: true })
    expect(s.codeDockActiveTab).toBe('js')
    expect(s.codeDockColumnWeights).toEqual({ html: 1, css: 3, js: 1 })
  })

  it('leaves current dock state untouched when the stored layout has no dock fields', () => {
    useEditorStore.setState({ codeDockHeight: 300, godModeActive: true } as never)
    restoreStoredSiteEditorLayout(useEditorStore, {})
    const s = useEditorStore.getState()
    expect(s.codeDockHeight).toBe(300)
    expect(s.godModeActive).toBe(true)
  })

  it('ignores malformed stored dock fields (wrong types, unknown panels)', () => {
    restoreStoredSiteEditorLayout(useEditorStore, {
      godModeActive: true,
      codeDockPanels: { html: false, bogus: true } as never,
      codeDockActiveTab: 'nope',
      codeDockColumnWeights: { html: -5, css: 1, js: 1 },
    })
    const s = useEditorStore.getState()
    // known panel applies, unknown key dropped, missing keys keep current value
    expect(s.codeDockPanels).toEqual({ html: false, css: true, js: true })
    // invalid tab falls back to current
    expect(s.codeDockActiveTab).toBe('html')
    // invalid weights rejected wholesale
    expect(s.codeDockColumnWeights).toEqual({ html: 1, css: 1, js: 1 })
  })
})

describe('preference catalog — god mode entry', () => {
  it('declares a capability-gated boolean, default off', () => {
    const entry = PREFERENCE_CATALOG.find((p) => p.id === 'godMode')
    expect(entry).toBeDefined()
    expect(entry?.type).toBe('boolean')
    expect(entry && 'default' in entry && entry.default).toBe(false)
    expect(entry && 'gate' in entry && entry.gate).toBe('structure-edit')
  })
})

describe('spotlight — god mode command + keybinding', () => {
  it('registers godMode.toggle gated on structure edit', () => {
    const commands = getGodModeCommands()
    const toggle = commands.find((c) => c.id === 'godMode.toggle')
    expect(toggle).toBeDefined()
    expect(toggle?.capability).toBe('site.structure.edit')
    expect(toggle?.workspaces).toEqual(['site'])
  })

  it('binds godMode.toggle to Cmd/Ctrl+Shift+G', () => {
    const binding = getKeybindingForCommand('godMode.toggle')
    expect(binding).toBeDefined()
    expect(
      binding!.match({
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        key: 'g',
      }),
    ).toBe(true)
    expect(
      binding!.match({
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        key: 'g',
      }),
    ).toBe(false)
  })
})
