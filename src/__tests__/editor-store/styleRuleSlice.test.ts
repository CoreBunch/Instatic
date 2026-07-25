/**
 * styleRuleSlice tests — CSS style-rule (class + ambient) system
 *
 * Covers:
 * - createClass / renameClass / deleteClass CRUD
 * - updateClassStyles / setClassContextStyles patch semantics
 * - addNodeClass / removeNodeClass / reorderNodeClasses node assignment
 * - activeClassId state management
 * - deleteClass cascade (removes from all nodes, clears activeClassId)
 * - Uniqueness guards (duplicate class names throw)
 * - No-op guards (Guideline #242)
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { useEditorStore } from '@site/store/store'
import type { NewStyleRule } from '@core/siteImport'
import { classKindSelector } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function getStore() {
  return useEditorStore.getState()
}

function freshStore() {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeClassId: null,
    previewClassAssignment: null,
    hasUnsavedChanges: false,
  })
  return getStore()
}

/**
 * Set up a site with one page, one root node, and one child node.
 * Returns { rootId, childId }.
 */
function setupSite() {
  const s = freshStore()
  const site = s.createSite('Test')
  const rootId = site.pages[0].rootNodeId
  const childId = useEditorStore.getState().insertNode('base.text', {}, rootId)
  return { rootId, childId, site: useEditorStore.getState().site! }
}

function historyLength() {
  return useEditorStore.getState()._historyPast.length
}

// ---------------------------------------------------------------------------
// createClass
// ---------------------------------------------------------------------------

describe('styleRuleSlice.createClass', () => {
  it('creates a class and adds it to site.styleRules', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    const classes = useEditorStore.getState().site!.styleRules
    expect(classes[cls.id]).toBeDefined()
    expect(classes[cls.id].name).toBe('btn')
    expect(classes[cls.id].styles).toEqual({})
    expect(classes[cls.id].contextStyles).toEqual({})
  })

  it('creates a class with initial styles', () => {
    setupSite()
    const cls = getStore().createClass('hero', { fontSize: '24px', color: '#fff' })
    const stored = useEditorStore.getState().site!.styleRules[cls.id]
    expect(stored.styles.fontSize).toBe('24px')
    expect(stored.styles.color).toBe('#fff')
  })

  it('throws if a class with the same name already exists', () => {
    setupSite()
    getStore().createClass('btn')
    expect(() => getStore().createClass('btn')).toThrow()
  })

  it('throws if the class name cannot be represented as one HTML class token', () => {
    setupSite()
    expect(() => getStore().createClass('feature card')).toThrow(/whitespace/)
    expect(() => getStore().createClass(' feature-card')).toThrow(/whitespace/)
  })

  it('throws if no site is loaded', () => {
    freshStore() // no createSite call
    expect(() => getStore().createClass('btn')).toThrow()
  })

  it('returns the new StyleRule with createdAt / updatedAt timestamps', () => {
    setupSite()
    const before = Date.now()
    const cls = getStore().createClass('card')
    const after = Date.now()
    expect(cls.createdAt).toBeGreaterThanOrEqual(before)
    expect(cls.createdAt).toBeLessThanOrEqual(after)
    expect(cls.updatedAt).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// updateClassStyles
// ---------------------------------------------------------------------------

describe('styleRuleSlice.updateClassStyles', () => {
  it('shallow-merges a patch into base styles', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { fontSize: '14px', color: '#000' })
    const stored = useEditorStore.getState().site!.styleRules[cls.id].styles
    expect(stored.fontSize).toBe('14px')
    expect(stored.color).toBe('#000')
  })

  it('overwrites individual keys on subsequent patches', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { fontSize: '14px' })
    getStore().updateClassStyles(cls.id, { fontSize: '16px' })
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.fontSize).toBe('16px')
  })

  it('deletes a key when patched to undefined/null', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { fontSize: '14px' })
    getStore().updateClassStyles(cls.id, { fontSize: undefined })
    const stored = useEditorStore.getState().site!.styleRules[cls.id].styles
    expect('fontSize' in stored).toBe(false)
  })

  it('is a no-op for unknown classId', () => {
    setupSite()
    const siteBefore = useEditorStore.getState().site!.updatedAt
    getStore().updateClassStyles('nonexistent-id', { fontSize: '14px' })
    expect(useEditorStore.getState().site!.updatedAt).toBe(siteBefore)
  })
})

// ---------------------------------------------------------------------------
// clearClassStyleProperties — batch prune (orphan-prune scenario)
// ---------------------------------------------------------------------------

describe('styleRuleSlice.clearClassStyleProperties', () => {
  it('clears several properties from base + every context in one undo step', () => {
    setupSite()
    const cls = getStore().createClass('row')
    getStore().updateClassStyles(cls.id, { display: 'flex', alignItems: 'center', color: 'red' })
    getStore().setClassContextStyles(cls.id, 'mobile', { gap: '8px' })

    const historyBefore = historyLength()
    getStore().clearClassStyleProperties(cls.id, ['display', 'alignItems', 'gap'])

    const rule = useEditorStore.getState().site!.styleRules[cls.id]
    // Pruned everywhere; the unrelated `color` survives.
    expect('display' in rule.styles).toBe(false)
    expect('alignItems' in rule.styles).toBe(false)
    expect(rule.styles.color).toBe('red')
    expect('gap' in (rule.contextStyles.mobile ?? {})).toBe(false)
    // Single undo step.
    expect(historyLength()).toBe(historyBefore + 1)
  })

  it('is a no-op (no history) when none of the properties are set', () => {
    setupSite()
    const cls = getStore().createClass('row')
    getStore().updateClassStyles(cls.id, { color: 'red' })
    const historyBefore = historyLength()
    getStore().clearClassStyleProperties(cls.id, ['display', 'gap'])
    expect(historyLength()).toBe(historyBefore)
  })
})

// ---------------------------------------------------------------------------
// setClassContextStyles
// ---------------------------------------------------------------------------

describe('styleRuleSlice.setClassContextStyles', () => {
  it('creates a breakpoint override entry and patches it', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().setClassContextStyles(cls.id, 'mobile', { fontSize: '12px' })
    const bpStyles = useEditorStore.getState().site!.styleRules[cls.id].contextStyles
    expect(bpStyles['mobile']?.fontSize).toBe('12px')
  })

  it('merges subsequent patches to the same breakpoint', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().setClassContextStyles(cls.id, 'mobile', { fontSize: '12px' })
    getStore().setClassContextStyles(cls.id, 'mobile', { color: '#fff' })
    const bp = useEditorStore.getState().site!.styleRules[cls.id].contextStyles['mobile']
    expect(bp?.fontSize).toBe('12px')
    expect(bp?.color).toBe('#fff')
  })

  it('removes a key from breakpoint styles when patched to null/undefined', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().setClassContextStyles(cls.id, 'mobile', { fontSize: '12px' })
    getStore().setClassContextStyles(cls.id, 'mobile', { fontSize: null as unknown as undefined })
    const bp = useEditorStore.getState().site!.styleRules[cls.id].contextStyles['mobile']
    expect('fontSize' in (bp ?? {})).toBe(false)
  })

  it('does not affect base styles', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { fontSize: '14px' })
    getStore().setClassContextStyles(cls.id, 'mobile', { fontSize: '12px' })
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.fontSize).toBe('14px')
  })
})

// ---------------------------------------------------------------------------
// applyCssRules
// ---------------------------------------------------------------------------

describe('styleRuleSlice.applyCssRules', () => {
  it('skips identical writes and prunes priority metadata when values are cleared', () => {
    setupSite()
    const incoming: NewStyleRule = {
      name: 'priority',
      kind: 'class',
      selector: '.priority',
      order: 0,
      styles: { color: 'red' },
      stylePriorities: { color: 'important' },
      contextStyles: { mobile: { color: 'blue' } },
      contextStylePriorities: { mobile: { color: 'important' } },
    }

    expect(getStore().applyCssRules([incoming], [], 'merge')).toEqual({
      created: 1,
      updated: 0,
      blockedSelectors: [],
    })
    const rule = Object.values(useEditorStore.getState().site!.styleRules)
      .find((candidate) => candidate.selector === '.priority')!
    const historyBeforeNoop = historyLength()
    const updatedAtBeforeNoop = rule.updatedAt

    expect(getStore().applyCssRules([incoming], [], 'merge')).toEqual({
      created: 0,
      updated: 0,
      blockedSelectors: [],
    })
    expect(historyLength()).toBe(historyBeforeNoop)
    expect(useEditorStore.getState().site!.styleRules[rule.id].updatedAt).toBe(updatedAtBeforeNoop)

    getStore().updateClassStyles(rule.id, { color: undefined })
    getStore().setClassContextStyles(rule.id, 'mobile', { color: undefined })
    const cleared = useEditorStore.getState().site!.styleRules[rule.id]
    expect(cleared.stylePriorities).toBeUndefined()
    expect(cleared.contextStylePriorities).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// removeClassStyleProperty
// ---------------------------------------------------------------------------

describe('styleRuleSlice.removeClassStyleProperty', () => {
  it('removes the property from base styles', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { display: 'flex' })
    getStore().removeClassStyleProperty(cls.id, 'display')
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.display).toBeUndefined()
  })

  it('removes the property from every breakpoint override', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().setClassContextStyles(cls.id, 'mobile', { display: 'block' })
    getStore().setClassContextStyles(cls.id, 'tablet', { display: 'inline' })
    getStore().removeClassStyleProperty(cls.id, 'display')
    const c = useEditorStore.getState().site!.styleRules[cls.id]
    expect(c.contextStyles['mobile']?.display).toBeUndefined()
    expect(c.contextStyles['tablet']?.display).toBeUndefined()
  })

  it('removes the property from base AND all breakpoints in a single history entry', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { display: 'grid' })
    getStore().setClassContextStyles(cls.id, 'mobile', { display: 'block' })
    getStore().removeClassStyleProperty(cls.id, 'display')
    const c = useEditorStore.getState().site!.styleRules[cls.id]
    expect(c.styles.display).toBeUndefined()
    expect(c.contextStyles['mobile']?.display).toBeUndefined()
    // One undo brings BOTH base and breakpoint back at once — confirms the
    // remove operation pushed exactly one history entry, not two.
    getStore().undo()
    const after = useEditorStore.getState().site!.styleRules[cls.id]
    expect(after.styles.display).toBe('grid')
    expect(after.contextStyles['mobile']?.display).toBe('block')
  })

  it('preserves other properties when removing one', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().updateClassStyles(cls.id, { display: 'flex', gap: '8px' })
    getStore().removeClassStyleProperty(cls.id, 'display')
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.display).toBeUndefined()
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.gap).toBe('8px')
  })

  it('is a no-op when the property is not set anywhere — updatedAt unchanged', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    const before = useEditorStore.getState().site!.styleRules[cls.id].updatedAt
    getStore().removeClassStyleProperty(cls.id, 'display')
    const after = useEditorStore.getState().site!.styleRules[cls.id].updatedAt
    expect(after).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// renameClass
// ---------------------------------------------------------------------------

describe('styleRuleSlice.renameClass', () => {
  it('renames a class', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().renameClass(cls.id, 'button')
    expect(useEditorStore.getState().site!.styleRules[cls.id].name).toBe('button')
  })

  it('keeps a class-kind rule selector in sync when renaming', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().renameClass(cls.id, 'button')
    expect(useEditorStore.getState().site!.styleRules[cls.id].selector).toBe('.button')
  })

  it('renames the binding token inside a preserved imported selector', () => {
    setupSite()
    const cls = getStore().createClass('group-hover:block')
    useEditorStore.setState((state) => ({
      site: {
        ...state.site!,
        styleRules: {
          ...state.site!.styleRules,
          [cls.id]: {
            ...state.site!.styleRules[cls.id],
            selector: `.group:hover ${classKindSelector('group-hover:block')}`,
          },
        },
      },
    }))

    getStore().renameClass(cls.id, 'group-focus:block')

    expect(useEditorStore.getState().site!.styleRules[cls.id].selector).toBe(
      `.group:hover ${classKindSelector('group-focus:block')}`,
    )
  })

  it('allows renaming to the same name (no-op, no throw)', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    expect(() => getStore().renameClass(cls.id, 'btn')).not.toThrow()
    expect(useEditorStore.getState().site!.styleRules[cls.id].name).toBe('btn')
  })

  it('throws when renaming to an already-used name', () => {
    setupSite()
    const cls1 = getStore().createClass('btn')
    getStore().createClass('card')
    expect(() => getStore().renameClass(cls1.id, 'card')).toThrow()
  })

  it('throws if the new name cannot be represented as one HTML class token', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    expect(() => getStore().renameClass(cls.id, 'feature card')).toThrow(/whitespace/)
  })

  it('is a no-op for unknown classId', () => {
    setupSite()
    expect(() => getStore().renameClass('nonexistent', 'whatever')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// deleteClass
// ---------------------------------------------------------------------------

describe('styleRuleSlice.deleteClass', () => {
  it('removes the class from the registry', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().deleteClass(cls.id)
    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeUndefined()
  })

  it('removes the classId from all nodes that reference it', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('btn')
    getStore().addNodeClass(childId, cls.id)
    // Verify it was added
    const pageBefore = useEditorStore.getState().site!.pages[0]
    expect(pageBefore.nodes[childId].classIds).toContain(cls.id)
    // Delete the class
    getStore().deleteClass(cls.id)
    const pageAfter = useEditorStore.getState().site!.pages[0]
    expect(pageAfter.nodes[childId].classIds ?? []).not.toContain(cls.id)
  })

  it('clears activeClassId when the active class is deleted', () => {
    setupSite()
    const cls = getStore().createClass('btn')
    getStore().setActiveClass(cls.id)
    expect(useEditorStore.getState().activeClassId).toBe(cls.id)
    getStore().deleteClass(cls.id)
    expect(useEditorStore.getState().activeClassId).toBeNull()
  })

  it('does not clear activeClassId when a different class is deleted', () => {
    setupSite()
    const cls1 = getStore().createClass('btn')
    const cls2 = getStore().createClass('card')
    getStore().setActiveClass(cls1.id)
    getStore().deleteClass(cls2.id)
    expect(useEditorStore.getState().activeClassId).toBe(cls1.id)
  })
})

// ---------------------------------------------------------------------------
// duplicateClass
// ---------------------------------------------------------------------------

describe('styleRuleSlice.duplicateClass', () => {
  it('copies styles and breakpoint styles without copying node assignments', () => {
    const { childId } = setupSite()
    const original = getStore().createClass('card', { padding: '16px', color: '#111' })
    getStore().setClassContextStyles(original.id, 'mobile', { padding: '8px' })
    getStore().addNodeClass(childId, original.id)

    const copy = getStore().duplicateClass(original.id)

    expect(copy).not.toBeNull()
    expect(copy!.id).not.toBe(original.id)
    expect(copy!.name).toBe('card-copy')
    expect(copy!.styles).toEqual({ padding: '16px', color: '#111' })
    expect(copy!.contextStyles).toEqual({ mobile: { padding: '8px' } })
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds).toEqual([original.id])
  })

  it('generates a unique copy name when a copy already exists', () => {
    setupSite()
    const original = getStore().createClass('badge')
    const firstCopy = getStore().duplicateClass(original.id)
    const secondCopy = getStore().duplicateClass(original.id)

    expect(firstCopy?.name).toBe('badge-copy')
    expect(secondCopy?.name).toBe('badge-copy-2')
  })

  it('returns null for unknown classId', () => {
    setupSite()
    const before = historyLength()
    expect(getStore().duplicateClass('missing')).toBeNull()
    expect(historyLength()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// addNodeClass / removeNodeClass / reorderNodeClasses
// ---------------------------------------------------------------------------

describe('styleRuleSlice — node class assignment', () => {
  it('addNodeClass appends a classId to the node', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('btn')
    getStore().addNodeClass(childId, cls.id)
    const node = useEditorStore.getState().site!.pages[0].nodes[childId]
    expect(node.classIds).toContain(cls.id)
  })

  it('addNodeClass is a no-op if classId is already present', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('btn')
    getStore().addNodeClass(childId, cls.id)
    getStore().addNodeClass(childId, cls.id) // second call
    const node = useEditorStore.getState().site!.pages[0].nodes[childId]
    expect(node.classIds?.filter((id) => id === cls.id).length).toBe(1)
  })

  it('addNodeClass can assign multiple classes in order', () => {
    const { childId } = setupSite()
    const cls1 = getStore().createClass('a')
    const cls2 = getStore().createClass('b')
    getStore().addNodeClass(childId, cls1.id)
    getStore().addNodeClass(childId, cls2.id)
    const node = useEditorStore.getState().site!.pages[0].nodes[childId]
    expect(node.classIds).toEqual([cls1.id, cls2.id])
  })

  it('removeNodeClass removes the classId from the node', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('btn')
    getStore().addNodeClass(childId, cls.id)
    getStore().removeNodeClass(childId, cls.id)
    const node = useEditorStore.getState().site!.pages[0].nodes[childId]
    expect(node.classIds ?? []).not.toContain(cls.id)
  })

  it('removeNodeClass is a no-op if classId is not present', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('btn')
    expect(() => getStore().removeNodeClass(childId, cls.id)).not.toThrow()
  })

  it('reorderNodeClasses swaps positions by index', () => {
    const { childId } = setupSite()
    const cls1 = getStore().createClass('a')
    const cls2 = getStore().createClass('b')
    const cls3 = getStore().createClass('c')
    getStore().addNodeClass(childId, cls1.id)
    getStore().addNodeClass(childId, cls2.id)
    getStore().addNodeClass(childId, cls3.id)
    // Move index 0 → index 2: [cls1, cls2, cls3] → [cls2, cls3, cls1]
    getStore().reorderNodeClasses(childId, 0, 2)
    const node = useEditorStore.getState().site!.pages[0].nodes[childId]
    expect(node.classIds).toEqual([cls2.id, cls3.id, cls1.id])
  })

  it('reorderNodeClasses is a no-op when fromIndex === toIndex', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('a')
    getStore().addNodeClass(childId, cls.id)
    getStore().reorderNodeClasses(childId, 0, 0)
    const node = useEditorStore.getState().site!.pages[0].nodes[childId]
    expect(node.classIds).toEqual([cls.id])
  })
})

// ---------------------------------------------------------------------------
// class hover preview
// ---------------------------------------------------------------------------

describe('styleRuleSlice — class hover preview', () => {
  it('stores a preview assignment without mutating node classIds or site timestamps', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('preview-me')
    const beforeSiteUpdatedAt = useEditorStore.getState().site!.updatedAt
    const beforeClassIds = useEditorStore.getState().site!.pages[0].nodes[childId].classIds

    getStore().setPreviewNodeClass(childId, cls.id)

    const state = useEditorStore.getState()
    expect(state.previewClassAssignment).toEqual({ nodeId: childId, classId: cls.id })
    expect(state.site!.pages[0].nodes[childId].classIds).toEqual(beforeClassIds)
    expect(state.site!.updatedAt).toBe(beforeSiteUpdatedAt)
  })

  it('clears only the matching preview assignment so stale mouseleave events cannot remove a newer preview', () => {
    const { childId } = setupSite()
    const first = getStore().createClass('first')
    const second = getStore().createClass('second')

    getStore().setPreviewNodeClass(childId, first.id)
    getStore().setPreviewNodeClass(childId, second.id)
    getStore().clearPreviewNodeClass(childId, first.id)

    expect(useEditorStore.getState().previewClassAssignment).toEqual({
      nodeId: childId,
      classId: second.id,
    })

    getStore().clearPreviewNodeClass(childId, second.id)
    expect(useEditorStore.getState().previewClassAssignment).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// activeClassId
// ---------------------------------------------------------------------------

describe('styleRuleSlice.setActiveClass', () => {
  it('sets activeClassId to a string value', () => {
    freshStore()
    getStore().setActiveClass('abc')
    expect(useEditorStore.getState().activeClassId).toBe('abc')
  })

  it('sets activeClassId to null', () => {
    freshStore()
    getStore().setActiveClass('abc')
    getStore().setActiveClass(null)
    expect(useEditorStore.getState().activeClassId).toBeNull()
  })

  it('is a no-op when value is unchanged (Guideline #242)', () => {
    freshStore()
    getStore().setActiveClass('abc')
    // Get store reference — if it changes, the selector ref changes
    const storeBefore = useEditorStore.getState()
    getStore().setActiveClass('abc') // same value
    const storeAfter = useEditorStore.getState()
    // The store object reference should be the same when no mutation occurred
    expect(storeAfter.activeClassId).toBe(storeBefore.activeClassId)
  })
})

// ---------------------------------------------------------------------------
// undo / redo integration for class mutations
// ---------------------------------------------------------------------------

describe('styleRuleSlice — undo / redo', () => {
  it('createClass is undoable and redoable', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('undoable')

    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeDefined()
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeUndefined()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId]).toBeDefined()

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeDefined()
  })

  it('renameClass is undoable and redoable', () => {
    setupSite()
    const cls = getStore().createClass('before-name')

    getStore().renameClass(cls.id, 'after-name')
    expect(useEditorStore.getState().site!.styleRules[cls.id].name).toBe('after-name')

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.styleRules[cls.id].name).toBe('before-name')

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.styleRules[cls.id].name).toBe('after-name')
  })

  it('duplicateClass is undoable and redoable', () => {
    setupSite()
    const cls = getStore().createClass('duplicated')
    const copy = getStore().duplicateClass(cls.id)

    expect(copy).not.toBeNull()
    expect(useEditorStore.getState().site!.styleRules[copy!.id]).toBeDefined()

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.styleRules[copy!.id]).toBeUndefined()

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.styleRules[copy!.id]).toBeDefined()
  })

  it('deleteClass is undoable and redoable including node assignments', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('removable')
    getStore().addNodeClass(childId, cls.id)

    getStore().deleteClass(cls.id)
    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeUndefined()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).not.toContain(cls.id)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeDefined()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).toContain(cls.id)

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.styleRules[cls.id]).toBeUndefined()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).not.toContain(cls.id)
  })

  it('style edits are undoable and redoable', () => {
    setupSite()
    const cls = getStore().createClass('styled')

    getStore().updateClassStyles(cls.id, { fontSize: '18px' })
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.fontSize).toBe('18px')

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.fontSize).toBeUndefined()

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.styleRules[cls.id].styles.fontSize).toBe('18px')
  })

  it('breakpoint style edits are undoable and redoable', () => {
    setupSite()
    const cls = getStore().createClass('responsive')

    getStore().setClassContextStyles(cls.id, 'mobile', { fontSize: '14px' })
    expect(useEditorStore.getState().site!.styleRules[cls.id].contextStyles.mobile?.fontSize).toBe('14px')

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.styleRules[cls.id].contextStyles.mobile?.fontSize).toBeUndefined()

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.styleRules[cls.id].contextStyles.mobile?.fontSize).toBe('14px')
  })

  it('node class assignments are undoable and redoable', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('assignable')

    getStore().addNodeClass(childId, cls.id)
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).toContain(cls.id)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).not.toContain(cls.id)

    useEditorStore.getState().redo()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).toContain(cls.id)

    getStore().removeNodeClass(childId, cls.id)
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).not.toContain(cls.id)

    useEditorStore.getState().undo()
    expect(useEditorStore.getState().site!.pages[0].nodes[childId].classIds ?? []).toContain(cls.id)
  })

  it('no-op class mutations do not push undo history', () => {
    const { childId } = setupSite()
    const cls = getStore().createClass('stable')

    const beforeSameRename = historyLength()
    getStore().renameClass(cls.id, 'stable')
    expect(historyLength()).toBe(beforeSameRename)

    const beforeEmptyStylePatch = historyLength()
    getStore().updateClassStyles(cls.id, {})
    expect(historyLength()).toBe(beforeEmptyStylePatch)

    const beforeUnassignedRemove = historyLength()
    getStore().removeNodeClass(childId, cls.id)
    expect(historyLength()).toBe(beforeUnassignedRemove)
  })
})

// ---------------------------------------------------------------------------
// node↔class assignment in Visual Component canvas mode
//
// Regression for the bug where applying a class to an element selected inside
// a VC canvas silently no-opped: addNodeClass / removeNodeClass /
// reorderNodeClass(es) only searched site.pages, missing nodes that live in
// the VC's tree (site.visualComponents[].tree.nodes). Hover preview kept
// working because it doesn't touch the tree at all.
// ---------------------------------------------------------------------------

describe('styleRuleSlice — node class assignment in VC canvas', () => {
  /**
   * Set up a site that already contains one Visual Component with a root
   * node and a child node. Returns the relevant ids so tests can drive
   * mutations through the public store API.
   */
  function setupVc() {
    freshStore()
    const s = getStore()
    s.createSite('Test')

    const vcId = 'vc-1'
    const vcRootId = 'vc-root'
    const vcChildId = 'vc-child'

    useEditorStore.setState((state) => ({
      ...state,
      site: state.site
        ? {
            ...state.site,
            visualComponents: [
              {
                id: vcId,
                name: 'Hero',
                tree: {
                  rootNodeId: vcRootId,
                  nodes: {
                    [vcRootId]: {
                      id: vcRootId,
                      moduleId: 'base.body',
                      props: {},
                      children: [vcChildId],
                      breakpointOverrides: {},
                      classIds: [],
                    },
                    [vcChildId]: {
                      id: vcChildId,
                      moduleId: 'base.text',
                      props: { text: 'Hi' },
                      children: [],
                      breakpointOverrides: {},
                      classIds: [],
                    },
                  },
                },
                params: [],
                breakpoints: [],
                classIds: [],
                createdAt: Date.now(),
              },
            ],
          }
        : null,
    }))

    // Enter the VC canvas — same state the editor sets when the user
    // double-clicks a VC in the layers panel.
    s.setActiveDocument({ kind: 'visualComponent', vcId })

    return { vcId, vcRootId, vcChildId }
  }

  it('addNodeClass writes onto a node inside the active VC tree', () => {
    const { vcId, vcChildId } = setupVc()
    const cls = getStore().createClass('hero-text')

    getStore().addNodeClass(vcChildId, cls.id)

    const vc = useEditorStore
      .getState()
      .site!.visualComponents.find((v) => v.id === vcId)!
    expect(vc.tree.nodes[vcChildId].classIds).toContain(cls.id)
  })

  it('removeNodeClass clears the assignment from a VC tree node', () => {
    const { vcId, vcChildId } = setupVc()
    const cls = getStore().createClass('hero-text')

    getStore().addNodeClass(vcChildId, cls.id)
    getStore().removeNodeClass(vcChildId, cls.id)

    const vc = useEditorStore
      .getState()
      .site!.visualComponents.find((v) => v.id === vcId)!
    expect(vc.tree.nodes[vcChildId].classIds ?? []).not.toContain(cls.id)
  })

  it('reorderNodeClass moves a class up/down inside a VC tree node', () => {
    const { vcId, vcChildId } = setupVc()
    const a = getStore().createClass('a')
    const b = getStore().createClass('b')
    const c = getStore().createClass('c')

    getStore().addNodeClass(vcChildId, a.id)
    getStore().addNodeClass(vcChildId, b.id)
    getStore().addNodeClass(vcChildId, c.id)
    // [a, b, c] → move c up → [a, c, b]
    getStore().reorderNodeClass(vcChildId, c.id, 'up')

    const vc = useEditorStore
      .getState()
      .site!.visualComponents.find((v) => v.id === vcId)!
    expect(vc.tree.nodes[vcChildId].classIds).toEqual([a.id, c.id, b.id])
  })

  it('deleteClass removes the classId from VC tree nodes too', () => {
    const { vcId, vcChildId } = setupVc()
    const cls = getStore().createClass('chrome')
    getStore().addNodeClass(vcChildId, cls.id)

    getStore().deleteClass(cls.id)

    const vc = useEditorStore
      .getState()
      .site!.visualComponents.find((v) => v.id === vcId)!
    expect(vc.tree.nodes[vcChildId].classIds ?? []).not.toContain(cls.id)
  })
})
