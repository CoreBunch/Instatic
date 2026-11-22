/**
 * applyTheme — a resolved theme lands in the editor store as ONE undo step
 * and never touches the document's nodes.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import { extractTheme, planThemeApply, resolveThemePlan } from '@core/fragments'
import { sourceWithBytes } from '../fragments/fixtures'
import '@modules/base/index'

function freshStore(): void {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(freshStore)

const { theme } = await extractTheme(sourceWithBytes())

function resolvedThemeForStore() {
  const plan = planThemeApply({ site: useEditorStore.getState().site! }, theme)
  return resolveThemePlan(plan, {
    mediaUrlByPath: new Map(plan.media.map((m) => [m.path, `/uploads/copied-${m.filename}`])),
    fontEntryByFamilyId: new Map(plan.fontFamilies.map((f) => [f.fragmentFamilyId, { ...f.entry, id: `installed-${f.entry.id}` }])),
  })
}

describe('applyTheme', () => {
  it('replaces colours, fonts, scales and root properties in one undo step', () => {
    useEditorStore.getState().createSite('Target')
    const before = useEditorStore.getState().site!

    expect(useEditorStore.getState().applyTheme(resolvedThemeForStore())).toBe(true)
    const after = useEditorStore.getState().site!
    expect(after.settings.framework!.colors.tokens.find((t) => t.slug === 'primary')?.lightValue).toBe('#3366ff')
    expect(after.settings.framework!.typography!.groups.find((g) => g.namingConvention === 'text')?.steps).toBe('xs,s,m,l,xl,2xl')
    const heading = after.settings.fonts!.tokens!.find((t) => t.variable === 'font-heading')!
    expect(heading.familyId).toBe('installed-font-inter')
    // The seeded role token is rebound, not duplicated.
    expect(after.settings.fonts!.tokens!.filter((t) => t.variable === 'font-heading')).toHaveLength(1)
    expect(Object.values(after.styleRules).some((r) => r.styles['--radius'] === '12px')).toBe(true)
    // Utilities for the theme's colours were regenerated in the same transaction.
    expect(Object.values(after.styleRules).some((r) => r.name === 'text-accent')).toBe(true)
    // No node changed.
    expect(after.pages).toEqual(before.pages)

    useEditorStore.getState().undo()
    const undone = useEditorStore.getState().site!
    expect(undone.settings).toEqual(before.settings)
    expect(undone.styleRules).toEqual(before.styleRules)
    expect(undone.pages).toEqual(before.pages)
  })

  it('refuses without a site', () => {
    useEditorStore.getState().createSite('Target')
    const resolved = resolvedThemeForStore()
    freshStore()
    expect(useEditorStore.getState().applyTheme(resolved)).toBe(false)
  })
})
