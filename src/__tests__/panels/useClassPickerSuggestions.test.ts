/**
 * Unit tests for `useClassPickerSuggestions`.
 *
 * The hook is a pure-derivation function with no React-specific surface
 * (no `useState`, no `useEffect`), so we exercise it as plain code rather
 * than rendering it. The `readUsage` injection lets each test stand up its
 * own usage history without touching localStorage.
 *
 * Coverage: empty/typed query branching, recent/frequent surfacing,
 * "All classes" section threshold, exact-match vs create-new vs already-
 * assigned dispatch, Arrow-Up/Down highlight clamping, and the submit-
 * tooltip priority order.
 */
import { describe, expect, it } from 'bun:test'
import {
  CLASS_PICKER_RESULT_LIMIT,
  useClassPickerSuggestions,
} from '@site/panels/PropertiesPanel/useClassPickerSuggestions'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import type { SelectorSuggestionItem } from '@site/panels/PropertiesPanel/selectorPickerModel'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeClass(name: string, id = `cls-${name}`): StyleRule {
  return {
    id,
    name,
    kind: 'class',
    selector: classKindSelector(name),
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function makeAmbient(selector: string, id = `ambient-${selector}`): StyleRule {
  return {
    id,
    name: selector,
    kind: 'ambient',
    selector,
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

function selectorItem(
  rule: StyleRule,
  disabled = false,
): SelectorSuggestionItem {
  return {
    rule,
    disabled,
    disabledReason: disabled ? "Doesn't match this element" : null,
    match: disabled ? null : { kind: 'direct' },
  }
}

const NO_USAGE = () => ({})

// ---------------------------------------------------------------------------
// Empty-query branch
// ---------------------------------------------------------------------------

describe('useClassPickerSuggestions — empty query', () => {
  it('returns the candidates list (allClasses minus assigned) when query is empty', () => {
    const allClasses = [makeClass('foo'), makeClass('bar'), makeClass('baz')]
    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: ['cls-bar'],
      query: '',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.isEmptyQuery).toBe(true)
    expect(result.candidates.map((c) => c.name)).toEqual(['foo', 'baz'])
    expect(result.filteredSuggestions.map((c) => c.name)).toEqual(['foo', 'baz'])
  })

  it('shows the "All classes" section when usage history is empty', () => {
    const allClasses = [makeClass('foo'), makeClass('bar')]
    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: [],
      query: '',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.recentIds).toEqual([])
    expect(result.frequentIds).toEqual([])
    expect(result.surfacedCount).toBe(0)
    expect(result.shouldShowAllSection).toBe(true)
    expect(result.remainingCandidates.map((c) => c.name)).toEqual(['foo', 'bar'])
    // flatNavIds is just the candidates when there's no usage history.
    expect(result.flatNavIds).toEqual(['cls-foo', 'cls-bar'])
  })

  it('hides the "All classes" section once the recent/frequent surface is large enough', () => {
    // Build 10 classes so recent + frequent can surface ≥ CLASS_USAGE_RECENT_LIMIT (8).
    const allClasses = Array.from({ length: 10 }, (_, i) => makeClass(`u-${i}`))
    // Mock usage so 8 IDs land in recent.
    const recentIds = allClasses.slice(0, 8).map((c) => c.id)
    const usage = Object.fromEntries(
      recentIds.map((id, i) => [id, { lastUsedAt: 1000 + i, count: 1 }]),
    )

    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: [],
      query: '',
      highlightedIndex: -1,
      readUsage: () => usage,
    })

    expect(result.recentIds.length).toBeGreaterThanOrEqual(8)
    expect(result.shouldShowAllSection).toBe(false)
    // flatNavIds covers only recent + frequent (no remaining slot).
    expect(result.flatNavIds).toEqual([...result.recentIds, ...result.frequentIds])
  })

  it('bounds mounted rows for a full utility registry', () => {
    const allClasses = Array.from({ length: 40_000 }, (_, index) =>
      makeClass(`utility-${index}`),
    )
    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: [],
      query: '',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.candidates).toHaveLength(40_000)
    expect(result.remainingCandidates).toHaveLength(CLASS_PICKER_RESULT_LIMIT)
    expect(result.flatNavIds).toHaveLength(CLASS_PICKER_RESULT_LIMIT)
  })

})

// ---------------------------------------------------------------------------
// Typed-query branch
// ---------------------------------------------------------------------------

describe('useClassPickerSuggestions — typed query', () => {
  it('ranks an exact match above prefix matches', () => {
    const allClasses = [makeClass('text-bg-body-5'), makeClass('text'), makeClass('text-xl')]
    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: [],
      query: 'text',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.isEmptyQuery).toBe(false)
    // Exact match wins, then prefix (shorter wins within tier).
    expect(result.filteredSuggestions[0].name).toBe('text')
    expect(result.flatNavIds[0]).toBe('cls-text')
  })

  it('detects an exact-name match independent of ranking', () => {
    const allClasses = [makeClass('header')]
    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: [],
      query: 'header',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.exactMatchedClass?.name).toBe('header')
    expect(result.exactMatchAlreadyAssigned).toBe(false)
    expect(result.canCreateNew).toBe(false)
    expect(result.hasSubmittableQuery).toBe(true)
    expect(result.submitTooltip).toBe('Add class “.header”')
  })

  it('finds an exact utility beyond the mounted result window', () => {
    const allClasses = Array.from({ length: 10_000 }, (_, index) =>
      makeClass(`utility-${index}`),
    )
    const result = useClassPickerSuggestions({
      allClasses,
      assignedIds: [],
      query: 'utility-9999',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.filteredSuggestions.length).toBeLessThanOrEqual(CLASS_PICKER_RESULT_LIMIT)
    expect(result.exactMatchedClass?.name).toBe('utility-9999')
    expect(result.hasSubmittableQuery).toBe(true)
  })

  it('flags an exact match that is already assigned as non-submittable', () => {
    const cls = makeClass('header')
    const result = useClassPickerSuggestions({
      allClasses: [cls],
      assignedIds: [cls.id],
      query: 'header',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.exactMatchedClass?.id).toBe(cls.id)
    expect(result.exactMatchAlreadyAssigned).toBe(true)
    expect(result.hasSubmittableQuery).toBe(false)
    expect(result.submitTooltip).toBe('“.header” is already on this element')
  })

  it('reports canCreateNew when the typed query matches no existing class', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('foo')],
      assignedIds: [],
      query: 'brand-new',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.canCreateNew).toBe(true)
    expect(result.hasSubmittableQuery).toBe(true)
    expect(result.submitTooltip).toBe('Create class “.brand-new”')
  })

  it('reports selector creation for selector-shaped input', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('hero')],
      assignedIds: [],
      query: '.hero .title',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.createIntent).toEqual({ kind: 'ambient', selector: '.hero .title' })
    expect(result.canCreateNew).toBe(true)
    expect(result.hasSubmittableQuery).toBe(true)
    expect(result.submitTooltip).toBe('Create selector “.hero .title”')
  })

  it('matches dot-prefixed class input against existing classes', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('header')],
      assignedIds: [],
      query: '.header',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.exactMatchedClass?.name).toBe('header')
    expect(result.canCreateNew).toBe(false)
    expect(result.submitTooltip).toBe('Add class “.header”')
  })

  it('filters classes by dot-prefixed partial input', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('header'), makeClass('footer')],
      assignedIds: [],
      query: '.hea',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.filteredSuggestions.map((cls) => cls.name)).toEqual(['header'])
  })

  it('returns an empty suggestion list when no class matches the query', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('foo'), makeClass('bar')],
      assignedIds: [],
      query: 'zzz',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.filteredSuggestions).toEqual([])
    expect(result.canCreateNew).toBe(true)
  })

  it('includes matching ambient selector suggestions in typed results', () => {
    const ambient = makeAmbient('.hero .title', 'ambient-match')
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('hero-title')],
      assignedIds: [],
      selectorItems: [selectorItem(ambient)],
      query: 'hero',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.selectorSuggestions.map((item) => item.rule.id)).toEqual(['ambient-match'])
    expect(result.flatNavIds).toContain('ambient-match')
  })

  it('keeps non-matching ambient selector suggestions disabled', () => {
    const ambient = makeAmbient('.card', 'ambient-off')
    const result = useClassPickerSuggestions({
      allClasses: [],
      assignedIds: [],
      selectorItems: [selectorItem(ambient, true)],
      query: 'card',
      highlightedIndex: 0,
      readUsage: NO_USAGE,
    })

    expect(result.selectorSuggestions[0]).toMatchObject({
      disabled: true,
      disabledReason: "Doesn't match this element",
    })
    expect(result.hasSubmittableQuery).toBe(false)
  })

  it('lets an arrow-highlighted matching ambient selector become the submit target', () => {
    const ambient = makeAmbient('.hero .title', 'ambient-match')
    const result = useClassPickerSuggestions({
      allClasses: [],
      assignedIds: [],
      selectorItems: [selectorItem(ambient)],
      query: 'hero',
      highlightedIndex: 0,
      readUsage: NO_USAGE,
    })

    expect(result.highlightedSelectorItem?.rule.id).toBe('ambient-match')
    expect(result.hasSubmittableQuery).toBe(true)
    expect(result.submitTooltip).toBe('Edit selector “.hero .title”')
  })

  it('lets an exact ambient selector become the submit target without arrow navigation', () => {
    const ambient = makeAmbient('.hero .title', 'ambient-match')
    const result = useClassPickerSuggestions({
      allClasses: [],
      assignedIds: [],
      selectorItems: [selectorItem(ambient)],
      query: '.hero .title',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.exactMatchedSelectorItem?.rule.id).toBe('ambient-match')
    expect(result.canCreateNew).toBe(false)
    expect(result.hasSubmittableQuery).toBe(true)
    expect(result.submitTooltip).toBe('Edit selector “.hero .title”')
  })
})

// ---------------------------------------------------------------------------
// Highlight clamping & arrow navigation
// ---------------------------------------------------------------------------

describe('useClassPickerSuggestions — highlightedIndex clamping', () => {
  it('snaps an out-of-range highlightedIndex to "no selection"', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('foo'), makeClass('bar')],
      assignedIds: [],
      query: '',
      highlightedIndex: 99,
      readUsage: NO_USAGE,
    })

    expect(result.effectiveHighlightedIndex).toBe(-1)
    expect(result.hasArrowSelection).toBe(false)
    expect(result.highlightedClassId).toBeNull()
    expect(result.highlightedName).toBeNull()
  })

  it('exposes a primitive highlightedClassId when the index is in range', () => {
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('foo'), makeClass('bar')],
      assignedIds: [],
      query: '',
      highlightedIndex: 1,
      readUsage: NO_USAGE,
    })

    expect(result.effectiveHighlightedIndex).toBe(1)
    expect(result.hasArrowSelection).toBe(true)
    // flatNavIds order matches candidates order when there's no usage history.
    expect(result.highlightedClassId).toBe(result.flatNavIds[1])
    expect(result.highlightedName).toBe('.bar')
  })

  it('arrow highlight wins over the typed query in the submit tooltip', () => {
    // Typed query matches `foo` and `foo-bar` but the user has explicitly
    // arrow-selected the second result. Tooltip should describe the arrow
    // pick, not the (non-)create-new intent.
    const result = useClassPickerSuggestions({
      allClasses: [makeClass('foo'), makeClass('foo-bar')],
      assignedIds: [],
      query: 'foo',
      highlightedIndex: 1,
      readUsage: NO_USAGE,
    })

    expect(result.hasArrowSelection).toBe(true)
    expect(result.submitTooltip).toBe('Add class “.foo-bar”')
  })
})

// ---------------------------------------------------------------------------
// Submit tooltip priority
// ---------------------------------------------------------------------------

describe('useClassPickerSuggestions — submit tooltip', () => {
  it('returns the static instructional copy for an empty query', () => {
    const result = useClassPickerSuggestions({
      allClasses: [],
      assignedIds: [],
      query: '',
      highlightedIndex: -1,
      readUsage: NO_USAGE,
    })

    expect(result.submitTooltip).toBe('Type a class name or selector to add or create')
    expect(result.hasSubmittableQuery).toBe(false)
  })
})
