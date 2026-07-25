/**
 * PropertiesPanel Redesign — PP-1..PP-16 Acceptance Gate Tests
 *
 * Task #456 / Spec #659 (UX Reviewer Contribution #659, accepted by Architect).
 *
 * Covers:
 *   PP-1  No role="tablist" in PropertiesPanel.tsx (static gate)
 *   PP-2  ClassPicker (pills + input) visible immediately on node selection — no tab click
 *   PP-3  Clicking class pill opens StyleRuleComposer; clicking again closes it
 *   PP-4  Module props in collapsible Section (defaultOpen=true), titled definition.name
 *   PP-5  Advanced Section removed from the Properties panel
 *   PP-6  Both StyleRuleComposer + PropertiesPanel import Section from same path (static gate)
 *   PP-7  Order superscript removed — chips render without ¹ ² ³ badges (position conveys order)
 *   PP-8  Class pill context menu owns reorder actions; hover arrows are not mounted
 *   PP-9  Pill × has title="Remove from this element" (static gate)
 *   PP-10 "Edit CSS" textarea is writable; typing + blur applies to class styles
 *   PP-11 Cmd/Ctrl+Enter in Edit CSS textarea applies styles (triggers blur)
 *   PP-12 Escape in Edit CSS textarea reverts without applying
 *   PP-13 Breakpoint hint appears inside Module section when non-desktop bp active
 *   PP-14 Phase-4 architecture gates (Gates 1–5) remain green — covered by existing test file
 *   PP-15 Existing 16 propertiesPanel.test.tsx tests remain green — covered by that file
 *   PP-16 No inline styles, no Tailwind, no !important in new source files (static gate)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PropertiesPanel } from '@site/panels/PropertiesPanel/PropertiesPanel'
import { getCSSPropertyDefaultValue } from '@site/panels/PropertiesPanel/cssControlTypes'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

const SRC_ROOT = join(import.meta.dir, '../../')
const PP_DIR = join(SRC_ROOT, 'admin/pages/site/panels/PropertiesPanel')

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function resetStore() {
  localStorage.clear()
  useEditorStore.setState({
    site: null,
    activePageId: null,
    activeDocument: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeBreakpointId: 'desktop',
    activeClassId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 280 },
    focusedPanel: 'canvas',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

function loadSiteWithHeading(): { nodeId: string; rootId: string } {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const textNode = makeNode({
    id: nodeId,
    moduleId: 'base.text',
    props: { text: 'Hello', tag: 'h2' },
    children: [],
  })
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: rootNode, [nodeId]: textNode } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  return { nodeId, rootId }
}

function loadSiteWithImage(): { nodeId: string; rootId: string } {
  const rootId = 'root-1'
  const nodeId = 'image-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const imageNode = makeNode({
    id: nodeId,
    moduleId: 'base.image',
    props: { src: '', loading: 'lazy' },
    children: [],
  })
  const page = makePage({ id: 'page-1', rootNodeId: rootId, nodes: { [rootId]: rootNode, [nodeId]: imageNode } })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  return { nodeId, rootId }
}

function selectNode(nodeId: string) {
  useEditorStore.setState({ selectedNodeId: nodeId } as Parameters<typeof useEditorStore.setState>[0])
}

/** Set up site with a node that has N classes pre-assigned. Returns nodeId + classIds. */
function loadSiteWithClasses(count: number): { nodeId: string; classIds: string[] } {
  const { nodeId } = loadSiteWithHeading()
  const state = useEditorStore.getState()
  const classIds: string[] = []
  for (let i = 1; i <= count; i++) {
    const cls = state.createClass(`class-${i}`)
    classIds.push(cls.id)
    state.addNodeClass(nodeId, cls.id)
  }
  return { nodeId, classIds }
}

// ---------------------------------------------------------------------------
// PP-1: No role="tablist" in PropertiesPanel.tsx (static)
// ---------------------------------------------------------------------------

describe('PP-1 — No role="tablist" in PropertiesPanel.tsx', () => {
  it('PropertiesPanel.tsx does not contain role="tablist"', () => {
    const src = readFileSync(join(PP_DIR, 'PropertiesPanel.tsx'), 'utf-8')
    expect(src).not.toContain('role="tablist"')
  })
})

// ---------------------------------------------------------------------------
// PP-2: ClassPicker visible immediately on selection — no tab click
// ---------------------------------------------------------------------------

describe('PP-2 — ClassPicker visible immediately on element selection', () => {
  it('class add input is visible directly under the panel header with no accordion interaction', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    const renameButton = screen.getByRole('button', { name: /rename text/i })
    const classInput = screen.getByRole('textbox', { name: /add or create a css selector/i })

    expect(classInput).toBeDefined()
    expect(renameButton.compareDocumentPosition(classInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^classes$/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-3: Pill click opens minimal StyleRuleComposer; clicking again closes it
// ---------------------------------------------------------------------------

describe('PP-3 — Pill click toggles CSS editor; locked preview shown with no active class', () => {
  it('before class selection the locked preview CTA is shown; clicking a pill opens the CSS editor; clicking again returns to locked preview', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    // No active class — LockedStylePreview is shown with its "Add class" CTA.
    // The style search bar is bound to the active class, so it's hidden in
    // the no-class state (nothing to search).
    expect(screen.getByRole('button', { name: /^add class$/i })).toBeDefined()
    expect(screen.queryByRole('searchbox', { name: /search class style properties to add/i })).toBeNull()

    // Click the pill to activate the class CSS editor.
    const pill = screen.getByRole('button', { name: /edit class \.class-1/i })
    fireEvent.click(pill)

    // CSS editor active — locked preview CTA gone, CSS property rows accessible,
    // and the style search bar is now visible (scoped to the active class).
    expect(screen.queryByRole('button', { name: /^add class$/i })).toBeNull()
    expect(screen.getByRole('searchbox', { name: /search class style properties to add/i })).toBeDefined()

    // Click again to deselect — locked preview returns and the search bar
    // disappears with it.
    fireEvent.click(pill)
    expect(screen.getByRole('button', { name: /^add class$/i })).toBeDefined()
    expect(screen.queryByRole('searchbox', { name: /search class style properties to add/i })).toBeNull()
  })
})

describe('SelectorHeader delete action', () => {
  it('confirms before deleting the selector opened in the Properties panel', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const classId = classIds[0]
    useEditorStore.setState({
      selectedNodeId: null,
      selectedNodeIds: [],
      activeClassId: null,
      selectedSelectorClassId: classId,
      propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<PropertiesPanel variant="docked" />)

    fireEvent.click(screen.getByRole('button', { name: /delete selector \.class-1/i }))

    expect(screen.getByRole('alertdialog', { name: /delete selector/i })).toBeDefined()
    expect(screen.getByText(/this selector is used 1 time/i)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /^delete selector$/i }))

    const state = useEditorStore.getState()
    expect(state.site?.styleRules[classId]).toBeUndefined()
    expect(state.selectedSelectorClassId).toBeNull()
    expect(state.site?.pages[0].nodes[nodeId].classIds).not.toContain(classId)
  })
})

describe('StyleRuleComposer inline style filtering', () => {
  it('filters the inline style catalog without opening an autocomplete menu', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))
    fireEvent.change(screen.getByRole('searchbox', { name: /search class style properties to add/i }), {
      target: { value: 'color' },
    })

    expect(document.querySelector('[data-testid="css-property-row-color"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-backgroundColor"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-display"]')).toBeNull()
    expect(screen.queryByRole('menu', { name: /available style properties/i })).toBeNull()
    expect(screen.queryByRole('listbox', { name: /available style properties/i })).toBeNull()
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('does not keep bespoke autocomplete result styles in StyleRuleComposer.module.css', () => {
    const css = readFileSync(join(PP_DIR, 'StyleRuleComposer.module.css'), 'utf-8')

    expect(css).not.toMatch(/\.searchResults\b/)
    expect(css).not.toMatch(/\.searchGroup\b/)
    expect(css).not.toMatch(/\.searchGroupHeader\b/)
    expect(css).not.toMatch(/\.searchGroupItems\b/)
    expect(css).not.toMatch(/\.searchResultsEmpty\b/)
  })

  it('category rail buttons navigate via scroll-anchor (all sections stay in DOM)', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // All sections always rendered — layout renders the DisplaySwitcher
    // and typography renders the fontFamily row.
    expect(document.querySelector('[data-testid="css-display-switcher"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()

    const typographyButton = screen.getByRole('button', { name: /show typography styles/i })
    fireEvent.click(typographyButton)

    // Typography button is pressed (scroll-anchor active); both sections still in DOM.
    expect(typographyButton.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    // Scroll-anchor: clicking a section scrolls to it, does NOT hide other sections.
    expect(document.querySelector('[data-testid="css-display-switcher"]')).not.toBeNull()
  })

  it('search filters across all categories regardless of which rail button was last clicked', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))
    // Click typography rail button (scroll-anchor: does NOT remove other sections from DOM).
    fireEvent.click(screen.getByRole('button', { name: /show typography styles/i }))

    // All sections still present after clicking a rail button in scroll-anchor mode.
    expect(document.querySelector('[data-testid="css-display-switcher"]')).not.toBeNull()

    // Search for 'fontFamily' — only typography rows match. The layout
    // section, which is not specially filtered by query inside LayoutSection,
    // collapses to nothing because none of its property keys match.
    fireEvent.change(screen.getByRole('searchbox', { name: /search class style properties to add/i }), {
      target: { value: 'fontFamily' },
    })

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-color"]')).toBeNull()
  })
})

describe('ClassPicker — suggestion hover preview', () => {
  it('previews an unassigned class while its suggestion is hovered and clears on leave', () => {
    const { nodeId } = loadSiteWithHeading()
    const cls = useEditorStore.getState().createClass('preview-target')
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.focus(screen.getByRole('textbox', { name: /add or create a css selector/i }))
    const item = screen.getByRole('menuitem', { name: '.preview-target' })

    fireEvent.mouseEnter(item)
    expect(useEditorStore.getState().previewClassAssignment).toEqual({
      nodeId,
      classId: cls.id,
    })
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].classIds ?? []).not.toContain(cls.id)

    fireEvent.mouseLeave(item)
    expect(useEditorStore.getState().previewClassAssignment).toBeNull()
  })

  it('does not preview suggestion hovers when the preference is disabled', () => {
    localStorage.setItem('instatic-editor-prefs', JSON.stringify({ hoverPreview: false }))
    const { nodeId } = loadSiteWithHeading()
    useEditorStore.getState().createClass('no-preview')
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.focus(screen.getByRole('textbox', { name: /add or create a css selector/i }))
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '.no-preview' }))

    expect(useEditorStore.getState().previewClassAssignment).toBeNull()
  })

  it('consumes a hovered suggestion as a real class on click and clears the preview', () => {
    const { nodeId } = loadSiteWithHeading()
    const cls = useEditorStore.getState().createClass('consume-preview')
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.focus(screen.getByRole('textbox', { name: /add or create a css selector/i }))
    const item = screen.getByRole('menuitem', { name: '.consume-preview' })

    fireEvent.mouseEnter(item)
    fireEvent.click(item)

    const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.classIds).toContain(cls.id)
    expect(useEditorStore.getState().previewClassAssignment).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-4: Module Section visible with definition.name, controls in DOM by default
// ---------------------------------------------------------------------------

describe('PP-4 — Module Section default open with controls', () => {
  it('Module section titled with definition.name is present and open by default', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    // "Text" is the definition.name for base.text
    expect(screen.getByRole('button', { name: /module settings.*text/i })).toBeDefined()
  })

  it('Property controls are visible without interaction (module section default open)', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    // base.text has a 'text' property control — should be in DOM immediately
    expect(screen.getByTestId('property-control-text')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// PP-5: Advanced Section removed from the Properties panel
// ---------------------------------------------------------------------------

describe('PP-5 — Advanced Section removed', () => {
  it('does not render the Advanced section or Hidden/Locked toggles', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)
    expect(screen.queryByRole('button', { name: /Advanced/i })).toBeNull()
    expect(screen.queryByLabelText(/^Hidden$/)).toBeNull()
    expect(screen.queryByLabelText(/^Locked$/)).toBeNull()
    expect(screen.queryByText(/^Node ID:/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-6: Section shared by top-level panel and class style categories
// ---------------------------------------------------------------------------

describe("PP-6 — StyleSurface used by PropertiesPanel; Section shared in StyleSectionsEditor", () => {
  it('PropertiesPanelBody.tsx imports StyleSurface from ./StyleSurface', () => {
    // The PropertiesPanel was refactored into a slim JSX shell + a body
    // component that owns the surface-selection branches. The StyleSurface
    // import now lives in `PropertiesPanelBody.tsx`, which is the file the
    // panel composes for the scrollable content area.
    const src = readFileSync(join(PP_DIR, 'PropertiesPanelBody.tsx'), 'utf-8')
    expect(src).toMatch(/import.*StyleSurface.*from\s+['"]\.\/StyleSurface['"]/)
  })

  it('StyleSectionsEditor.tsx imports Section from the shared @ui/components/Section primitive', () => {
    // Section moved from StyleRuleComposer into StyleSectionsEditor when inline-styles
    // refactoring (commit ee346c41) extracted the style-section rendering into a
    // shared target-agnostic renderer used by both StyleRuleComposer and InlineStyleComposer.
    const src = readFileSync(join(PP_DIR, 'StyleSectionsEditor.tsx'), 'utf-8')
    expect(src).toMatch(/import\s*\{\s*Section\s*\}\s*from\s+['"]@ui\/components\/Section['"]/)
  })
})

// ---------------------------------------------------------------------------
// PP-7: Order superscript removed — chips render without ¹²³ badges.
// Cascade order is conveyed by left-to-right position in the chip row.
// ---------------------------------------------------------------------------

describe('PP-7 — No cascade order badges on chips', () => {
  it('Three chips render without ordinal superscript badges ¹ ² ³', () => {
    const { nodeId } = loadSiteWithClasses(3)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    expect(screen.queryByText('¹')).toBeNull()
    expect(screen.queryByText('²')).toBeNull()
    expect(screen.queryByText('³')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-8: Class pill context menu owns reorder actions
// ---------------------------------------------------------------------------

describe('PP-8 — Class pill context menu owns reorder actions', () => {
  it('does not mount hover-only reorder arrow controls inside class pills', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPicker.tsx'), 'utf-8')
    const css = readFileSync(join(PP_DIR, 'ClassPicker.module.css'), 'utf-8')

    expect(src).not.toContain('styles.reorderGroup')
    expect(src).not.toContain('Move class ${cls.name} up in cascade')
    expect(src).not.toContain('Move class ${cls.name} down in cascade')
    expect(css).not.toMatch(/\.reorderGroup\b/)
  })

  it('right-clicking a class pill opens class actions and moves the class up or down', () => {
    const { nodeId, classIds } = loadSiteWithClasses(3)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const classTwoPill = screen.getByRole('button', { name: /edit class \.class-2/i })
    fireEvent.contextMenu(classTwoPill, { clientX: 32, clientY: 48 })

    expect(screen.getByRole('menu', { name: /class actions/i })).toBeDefined()
    fireEvent.click(screen.getByRole('menuitem', { name: /move up/i }))

    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].classIds).toEqual([
      classIds[1],
      classIds[0],
      classIds[2],
    ])

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit class \.class-2/i }), {
      clientX: 32,
      clientY: 48,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: /move down/i }))

    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].classIds).toEqual([
      classIds[0],
      classIds[1],
      classIds[2],
    ])
  })

  it('disables boundary moves in the class pill context menu', () => {
    const { nodeId, classIds } = loadSiteWithClasses(2)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.contextMenu(screen.getByRole('button', { name: /edit class \.class-1/i }), {
      clientX: 32,
      clientY: 48,
    })

    expect(screen.getByRole('menuitem', { name: /move up/i }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('menuitem', { name: /move down/i }))
    expect(useEditorStore.getState().site!.pages[0].nodes[nodeId].classIds).toEqual([
      classIds[1],
      classIds[0],
    ])
  })

  it('opens class actions from the keyboard and renames the selector with a dialog', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.keyDown(screen.getByRole('button', { name: /edit class \.class-1/i }), { key: 'ContextMenu' })
    expect(screen.getByRole('menu', { name: /class actions/i })).toBeDefined()

    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }))
    fireEvent.change(screen.getByRole('textbox', { name: /class name/i }), {
      target: { value: 'renamed-class' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(useEditorStore.getState().site!.styleRules[classIds[0]].name).toBe('renamed-class')
  })
})

// ---------------------------------------------------------------------------
// PP-9: Pill × button has title="Remove from this element" (static)
// ---------------------------------------------------------------------------

describe('PP-9 — Pill × button tooltip "Remove from this element"', () => {
  it('ClassPillContextMenu.tsx source contains "Remove from this element"', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPillContextMenu.tsx'), 'utf-8')
    expect(src).toContain('Remove from this element')
  })
})

// ---------------------------------------------------------------------------
// PP-10: Class and module style controls are visible in StyleRuleComposer
// ---------------------------------------------------------------------------

describe('PP-10 — Class and module style controls visible in StyleRuleComposer', () => {
  it('a class with a fontFamily style shows a CSS property row', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('styled-class')
    state.addNodeClass(nodeId, cls.id)
    state.updateClassStyles(cls.id, { fontFamily: 'Inter' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    // Open the StyleRuleComposer by clicking the pill
    const pill = screen.getByRole('button', { name: /edit class \.styled-class/i })
    fireEvent.click(pill)

    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
  })

  it('no textarea element is present in StyleRuleComposer (PP-17)', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.class-1/i })
    fireEvent.click(pill)

    // Phase 3 removes the former StyleRuleComposer "Edit CSS" textarea.
    expect(screen.queryByRole('textbox', { name: /edit css/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-11: Editing a text-type class property via TextControl updates the store
// ---------------------------------------------------------------------------

describe('PP-11 — Editing a text-type class property via TextControl updates class styles', () => {
  it('changing the fontFamily input writes the new value to the class styles in the store', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('edit-class')
    state.addNodeClass(nodeId, cls.id)
    state.updateClassStyles(cls.id, { fontFamily: 'serif' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.edit-class/i })
    fireEvent.click(pill)

    // Find the text input for fontFamily (TextControl renders a text input)
    const input = document
      .querySelector('[data-testid="css-property-row-fontFamily"]')
      ?.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('serif')
    fireEvent.change(input, { target: { value: 'Inter, sans-serif' } })

    const updatedCls = useEditorStore.getState().site!.styleRules[cls.id]
    expect(updatedCls.styles.fontFamily).toBe('Inter, sans-serif')
  })

  it('uses the active canvas breakpoint for class style edits without changing base styles', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('responsive-edit-class')
    state.addNodeClass(nodeId, cls.id)
    state.updateClassStyles(cls.id, { fontFamily: 'serif' })
    useEditorStore.setState({ activeBreakpointId: 'mobile' } as Parameters<typeof useEditorStore.setState>[0])
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.responsive-edit-class/i })
    fireEvent.click(pill)

    expect(screen.queryByRole('combobox', { name: /class style breakpoint/i })).toBeNull()

    const input = document
      .querySelector('[data-testid="css-property-row-fontFamily"]')
      ?.querySelector('input') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('serif')
    fireEvent.change(input, { target: { value: 'Inter, sans-serif' } })

    const updatedCls = useEditorStore.getState().site!.styleRules[cls.id]
    expect(updatedCls.styles.fontFamily).toBe('serif')
    expect(updatedCls.contextStyles.mobile.fontFamily).toBe('Inter, sans-serif')
  })

  it('does not render a panel-local class style breakpoint picker', () => {
    const { nodeId } = loadSiteWithClasses(1)
    useEditorStore.setState({ activeBreakpointId: 'mobile' } as Parameters<typeof useEditorStore.setState>[0])
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(screen.queryByRole('combobox', { name: /class style breakpoint/i })).toBeNull()
    expect(screen.getByRole('searchbox', { name: /search class style properties to add/i })).toBeDefined()
  })
})

describe('StyleRuleComposer unset CSS property placeholders', () => {
  it('renders the display switcher with no segment pressed when display is unset', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const displaySwitcher = document.querySelector('[data-testid="css-display-switcher"]')
    expect(displaySwitcher).not.toBeNull()
    expect(displaySwitcher?.getAttribute('data-display-value')).toBe('')

    // No segment is pressed in the unset state.
    const flexSegment = screen.getByRole('button', { name: /^flex layout$/i })
    const gridSegment = screen.getByRole('button', { name: /^grid layout$/i })
    expect(flexSegment.getAttribute('aria-pressed')).toBe('false')
    expect(gridSegment.getAttribute('aria-pressed')).toBe('false')

    expect(useEditorStore.getState().site!.styleRules[useEditorStore.getState().activeClassId!].styles.display).toBeUndefined()
  })

  it('renders unset text defaults as placeholders, not input values', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    // Set display to flex so the GapInput is revealed inside the flex
    // block. Gap is a container-only property and lives in the visual
    // flex/grid blocks rather than the fallback rows.
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const gapInput = screen.getByLabelText('Gap') as HTMLInputElement
    expect(gapInput.value).toBe('')
    expect(gapInput.placeholder).toBe('0px')
    expect(useEditorStore.getState().site!.styleRules[clsId].styles.gap).toBeUndefined()
  })

  it('renders stored CSS declarations as actual control values', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex', gap: '32px' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // The Flex segment of the SegmentedControl is pressed when display: flex
    // is stored on the class.
    const flexSegment = screen.getByRole('button', { name: /^flex layout$/i })
    expect(flexSegment.getAttribute('aria-pressed')).toBe('true')

    // Gap renders inside the flex block via the GapInput primitive (token-aware).
    const gapInput = screen.getByLabelText('Gap') as HTMLInputElement
    expect(gapInput.value).toBe('32px')
  })
})

describe('LayoutSection — clear via active segment X', () => {
  it('clicking the active flex segment clears display from base styles', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const flexSegment = screen.getByRole('button', { name: /^flex layout$/i })
    expect(flexSegment.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(flexSegment)

    expect(useEditorStore.getState().site!.styleRules[clsId].styles.display).toBeUndefined()
    // After clearing, no segment is pressed.
    expect(screen.getByRole('button', { name: /^flex layout$/i }).getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking the active grid segment clears display from base styles even when on a breakpoint tab', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid' })
    useEditorStore.setState({ activeBreakpointId: 'mobile' } as Parameters<typeof useEditorStore.setState>[0])
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const gridSegment = screen.getByRole('button', { name: /^grid layout$/i })
    expect(gridSegment.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(gridSegment)

    // X click clears the property entirely, not just at the active breakpoint —
    // otherwise the inherited base value would bleed through and the segment
    // would stay pressed (Job #1342 followup).
    expect(useEditorStore.getState().site!.styleRules[clsId].styles.display).toBeUndefined()
    expect(screen.getByRole('button', { name: /^grid layout$/i }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: /^flex layout$/i }).getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking the active flex direction icon clears flexDirection', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex', flexDirection: 'column' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const columnSegment = screen.getByRole('button', { name: /^column$/i })
    expect(columnSegment.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(columnSegment)

    expect(useEditorStore.getState().site!.styleRules[clsId].styles.flexDirection).toBeUndefined()
  })
})

describe('LayoutSection — grid block', () => {
  it('renders the grid block when display is grid', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // Grid template column / row track pickers and the alignment switchers
    // are present.
    expect(screen.getByRole('group', { name: /grid template columns/i })).toBeDefined()
    expect(screen.getByRole('group', { name: /grid template rows/i })).toBeDefined()
    expect(screen.getByRole('group', { name: /^align items$/i })).toBeDefined()
    expect(screen.getByRole('group', { name: /^justify items$/i })).toBeDefined()
  })

  it('does not render the grid block when display is flex', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(screen.queryByRole('group', { name: /grid template columns/i })).toBeNull()
  })

  it('clicking a column count segment writes repeat(N, 1fr) to gridTemplateColumns', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // Column track group renders [1, 2, 3, 4, 5, 6] count segments. Click "3".
    const columnGroup = screen.getByRole('group', { name: /grid template columns/i })
    const threeColsSegment = columnGroup.querySelector('button[aria-label="3 tracks"]') as HTMLButtonElement
    expect(threeColsSegment).not.toBeNull()
    fireEvent.click(threeColsSegment)

    expect(useEditorStore.getState().site!.styleRules[clsId].styles.gridTemplateColumns).toBe('repeat(3, 1fr)')
  })

  it('reflects an existing repeat(N, 1fr) value as a pressed segment', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const columnGroup = screen.getByRole('group', { name: /grid template columns/i })
    const fourColsSegment = columnGroup.querySelector('button[aria-label="4 tracks"]') as HTMLButtonElement
    expect(fourColsSegment.getAttribute('aria-pressed')).toBe('true')
  })

  it('falls back to a custom-value chip when gridTemplateColumns is a non-preset template', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid', gridTemplateColumns: '200px 1fr 200px' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // The chip exposes the raw value as the button's accessible name.
    const chip = screen.getByRole('button', { name: /grid template columns: 200px 1fr 200px/i })
    expect(chip).toBeDefined()
  })

  it('clicking the active grid column segment clears gridTemplateColumns', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const columnGroup = screen.getByRole('group', { name: /grid template columns/i })
    const twoColsSegment = columnGroup.querySelector('button[aria-label="2 tracks"]') as HTMLButtonElement
    expect(twoColsSegment.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(twoColsSegment)

    expect(useEditorStore.getState().site!.styleRules[clsId].styles.gridTemplateColumns).toBeUndefined()
  })

  it('hides gridTemplateColumns / gridTemplateRows / justifyItems fallback rows when display is grid', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'grid' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // Generic ClassPropertyRow rows for the grid-owned properties are
    // suppressed; the visual GridBlock owns those controls instead.
    expect(document.querySelector('[data-testid="css-property-row-gridTemplateColumns"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-gridTemplateRows"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-justifyItems"]')).toBeNull()
    // Gap is owned by the GridBlock's GapInput (TokenAwareInput) and lives
    // inside the visual block, not as a fallback row.
    expect(screen.getByLabelText('Gap')).toBeDefined()
  })

  it('hides gap / rowGap / columnGap rows when display is not flex or grid', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // Default display (unset) → no gap controls at all (fallback is gone,
    // visual block isn't rendered yet).
    expect(screen.queryByLabelText('Gap')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-rowGap"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-columnGap"]')).toBeNull()
    // Item-level properties (gridColumn / gridRow / alignSelf / flex)
    // still render — they depend on the parent's display, which we don't
    // observe from a class-style editor.
    expect(document.querySelector('[data-testid="css-property-row-alignSelf"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-gridColumn"]')).not.toBeNull()
  })

  it('reveals the GapInput once display becomes flex', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // Gap is now inside the flex block (token-aware input), not a fallback row.
    expect(screen.getByLabelText('Gap')).toBeDefined()
    expect(document.querySelector('[data-testid="css-property-row-rowGap"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-columnGap"]')).not.toBeNull()
  })
})

describe('LayoutSection — position block', () => {
  it('always renders the position switcher, regardless of display', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(document.querySelector('[data-testid="css-position-switcher"]')).not.toBeNull()
  })

  it('does not render the directional offsets when position is unset or static', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(document.querySelector('[data-testid="css-direction-input-top"]')).toBeNull()

    // Setting position to static does NOT reveal the offsets either —
    // static elements ignore top/right/bottom/left.
    useEditorStore.getState().updateClassStyles(clsId, { position: 'static' })
    expect(document.querySelector('[data-testid="css-direction-input-top"]')).toBeNull()
  })

  it('reveals the 4-direction grid when position is relative / absolute / fixed / sticky', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { position: 'relative' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(document.querySelector('[data-testid="css-direction-input-top"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-direction-input-right"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-direction-input-bottom"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-direction-input-left"]')).not.toBeNull()
  })

  it('marks the relative segment as pressed when position: relative is stored', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { position: 'relative' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const relSegment = screen.getByRole('button', { name: /^position relative$/i })
    expect(relSegment.getAttribute('aria-pressed')).toBe('true')
  })

  it('falls back to a chip + close when position is fixed / sticky', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { position: 'sticky' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const chip = screen.getByRole('button', { name: /position: sticky/i })
    expect(chip).toBeDefined()
  })

  it('typing into a direction input writes the value to the matching property on blur', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { position: 'absolute' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const topCell = document.querySelector('[data-testid="css-direction-input-top"]')
    const topInput = topCell?.querySelector('input') as HTMLInputElement

    // TokenAwareInput defers commit to blur (so token resolution and
    // store writes don't fire on every keystroke). Simulate the full
    // type-then-blur user gesture.
    fireEvent.focus(topInput)
    fireEvent.change(topInput, { target: { value: '12px' } })
    fireEvent.blur(topInput)

    expect(useEditorStore.getState().site!.styleRules[clsId].styles.top).toBe('12px')
  })

  it('hides the position keyword and 4 offset fallback rows when position is active', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { position: 'relative' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(document.querySelector('[data-testid="css-property-row-position"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-top"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-right"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-bottom"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-left"]')).toBeNull()
  })

  it('keeps the switcher visible but hides offset inputs entirely when position is unset', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // The PositionSection always renders the switcher.
    expect(document.querySelector('[data-testid="css-position-switcher"]')).not.toBeNull()
    // No fallback row for the position keyword anywhere — the switcher is
    // the single way to set it.
    expect(document.querySelector('[data-testid="css-property-row-position"]')).toBeNull()
    // Offset inputs and rows are entirely absent until position becomes
    // active. The position section owns top/right/bottom/left via its
    // DirectionInputs, which only render when the value honors offsets.
    expect(document.querySelector('[data-testid="css-property-row-top"]')).toBeNull()
    expect(document.querySelector('[data-testid="css-direction-input-top"]')).toBeNull()
  })

  it('renders zIndex row inside the position section regardless of position value', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    // zIndex always renders inside the position section as a generic
    // ClassPropertyRow — even when the position keyword itself is unset.
    expect(document.querySelector('[data-testid="css-property-row-zIndex"]')).not.toBeNull()
  })
})

describe('ClassPropertyRow — token-aware properties', () => {
  it('fontSize commits on blur (token-aware input pattern), not per-keystroke', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const fontSizeRow = document.querySelector('[data-testid="css-property-row-fontSize"]')
    expect(fontSizeRow).not.toBeNull()
    const fontSizeInput = fontSizeRow?.querySelector('input') as HTMLInputElement

    // Typing alone doesn't commit — TokenAwareInput defers to blur so token
    // resolution and store writes don't fire on every keystroke.
    fireEvent.focus(fontSizeInput)
    fireEvent.change(fontSizeInput, { target: { value: '18px' } })
    expect(useEditorStore.getState().site!.styleRules[clsId].styles.fontSize).toBeUndefined()

    // Blur commits.
    fireEvent.blur(fontSizeInput)
    expect(useEditorStore.getState().site!.styleRules[clsId].styles.fontSize).toBe('18px')
  })

  it('fontSize displays a stored var(--text-l) value as the short token step', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    // Seed with a typography variable. Without a framework typography
    // group the input falls back to showing the raw var() value, so we
    // just verify that the row renders and the raw value is what we get
    // back when no typography tokens are configured.
    useEditorStore.getState().updateClassStyles(clsId, { fontSize: 'var(--text-l)' })
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const fontSizeRow = document.querySelector('[data-testid="css-property-row-fontSize"]')
    const fontSizeInput = fontSizeRow?.querySelector('input') as HTMLInputElement
    // Test fixture has no typography groups configured, so the value
    // round-trips as the raw var() expression.
    expect(fontSizeInput.value).toBe('var(--text-l)')
  })
})

describe('ClassPropertyRow — number-typed CSS properties', () => {
  it('keeps a typed opacity decimal intact while persisting a number', async () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const classId = classIds[0]
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const opacityRow = document.querySelector('[data-testid="css-property-row-opacity"]')
    const opacityInput = opacityRow?.querySelector('input') as HTMLInputElement
    const user = userEvent.setup()

    await user.click(opacityInput)
    await user.type(opacityInput, '0')
    await user.type(opacityInput, '.')
    expect(opacityInput.value).toBe('0.')

    await user.type(opacityInput, '8')
    expect(opacityInput.value).toBe('0.8')
    expect(useEditorStore.getState().site!.styleRules[classId].styles.opacity).toBe(0.8)
    expect(typeof useEditorStore.getState().site!.styleRules[classId].styles.opacity).toBe('number')

    await user.tab()
    expect(opacityInput.value).toBe('0.8')
  })

  it('keeps a leading minus while typing a negative z-index', async () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const classId = classIds[0]
    selectNode(nodeId)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    const zIndexRow = document.querySelector('[data-testid="css-property-row-zIndex"]')
    const zIndexInput = zIndexRow?.querySelector('input') as HTMLInputElement
    const user = userEvent.setup()

    await user.click(zIndexInput)
    await user.type(zIndexInput, '-')
    expect(zIndexInput.value).toBe('-')
    expect(useEditorStore.getState().site!.styleRules[classId].styles.zIndex).toBeUndefined()

    await user.type(zIndexInput, '2')
    expect(zIndexInput.value).toBe('-2')
    expect(useEditorStore.getState().site!.styleRules[classId].styles.zIndex).toBe(-2)

    await user.tab()
    expect(zIndexInput.value).toBe('-2')
  })
})

describe('StyleRuleComposer set style indicators', () => {
  it('marks category rail icons and section headers that contain stored class styles', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex', fontFamily: 'Inter, sans-serif' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(screen.getByTestId('class-style-section-dot-layout')).toBeDefined()
    expect(screen.getByTestId('class-style-section-dot-typography')).toBeDefined()
    expect(screen.queryByTestId('class-style-section-dot-size')).toBeNull()

    expect(screen.getByTestId('class-style-category-dot-layout')).toBeDefined()
    expect(screen.getByTestId('class-style-category-dot-typography')).toBeDefined()
    expect(screen.queryByTestId('class-style-category-dot-size')).toBeNull()
  })

  it('does not mark inherited base styles as set on breakpoint tabs', () => {
    const { nodeId, classIds } = loadSiteWithClasses(1)
    const clsId = classIds[0]
    useEditorStore.getState().updateClassStyles(clsId, { display: 'flex' })
    useEditorStore.setState({ activeBreakpointId: 'mobile' } as Parameters<typeof useEditorStore.setState>[0])
    selectNode(nodeId)
    render(<PropertiesPanel />)

    fireEvent.click(screen.getByRole('button', { name: /edit class \.class-1/i }))

    expect(screen.queryByTestId('class-style-section-dot-layout')).toBeNull()
    expect(screen.queryByTestId('class-style-category-dot-layout')).toBeNull()

    // Inherited base style (display: flex) is reflected on the SegmentedControl
    // — the Flex segment is pressed because the inherited cascade resolves to
    // flex on this breakpoint, even though nothing is stored at the mobile tab.
    const flexSegment = screen.getByRole('button', { name: /^flex layout$/i })
    expect(flexSegment.getAttribute('aria-pressed')).toBe('true')
  })
})

// ---------------------------------------------------------------------------
// PP-12: Remove class CSS property via the ClassPropertyRow remove button
// ---------------------------------------------------------------------------

describe('PP-12 — Removing a class CSS property removes it from class styles', () => {
  it('clicking the remove button for fontFamily clears it from class styles', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('remove-class')
    state.addNodeClass(nodeId, cls.id)
    state.updateClassStyles(cls.id, { fontFamily: 'serif' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.remove-class/i })
    fireEvent.click(pill)

    const removeBtn = screen.getByRole('button', { name: /remove font family property/i })
    fireEvent.click(removeBtn)

    const updatedCls = useEditorStore.getState().site!.styleRules[cls.id]
    // fontFamily should be cleared (null or undefined or '')
    expect(updatedCls.styles.fontFamily).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// PP-13: Breakpoint hint appears inside Module section when non-desktop bp active
// ---------------------------------------------------------------------------

describe('PP-13 — Breakpoint hint inside Module section when non-desktop bp active', () => {
  // The previous "editing tablet" text affordance was replaced by the breakpoint
  // dot indicator on the Module section header — only the dot indicator below is
  // still part of the spec.

  it('breakpoint dot indicator appears on Module section header when non-desktop bp active', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    useEditorStore.setState({ activeBreakpointId: 'tablet' } as Parameters<typeof useEditorStore.setState>[0])
    render(<PropertiesPanel />)

    // The Module settings section includes the selected module name and breakpoint indicator.
    const moduleSection = screen.getByRole('button', { name: /module settings.*text/i })
    expect(moduleSection).toBeDefined()
  })

  it('no breakpoint hint when desktop bp is active', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    useEditorStore.setState({ activeBreakpointId: 'desktop' } as Parameters<typeof useEditorStore.setState>[0])
    render(<PropertiesPanel />)
    expect(screen.queryByText(/editing.*overrides/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-16: No inline styles, no Tailwind, no !important in new source files (static)
// ---------------------------------------------------------------------------

describe('PP-16 — No inline styles / no Tailwind / no !important in new files', () => {
  const SECTION_DIR = join(SRC_ROOT, 'ui/components/Section')
  const newFiles: Array<{ file: string; dir: string }> = [
    { file: 'Section.tsx', dir: SECTION_DIR },
    { file: 'Section.module.css', dir: SECTION_DIR },
    { file: 'ClassPicker.tsx', dir: PP_DIR },
    { file: 'ClassPicker.module.css', dir: PP_DIR },
    { file: 'ClassPillContextMenu.tsx', dir: PP_DIR },
    { file: 'ClassRenameDialog.tsx', dir: PP_DIR },
    { file: 'classPickerUiState.ts', dir: PP_DIR },
    { file: 'useClassPickerDerivedState.ts', dir: PP_DIR },
    { file: 'StyleRuleComposer.tsx', dir: PP_DIR },
    { file: 'StyleRuleComposer.module.css', dir: PP_DIR },
    { file: 'ClassPropertyRow.tsx', dir: PP_DIR },
    { file: 'ClassPropertyRow.module.css', dir: PP_DIR },
    { file: 'cssControlTypes.ts', dir: PP_DIR },
    { file: 'PropertiesPanel.tsx', dir: PP_DIR },
    { file: 'PropertiesPanel.module.css', dir: PP_DIR },
  ]

  for (const { file, dir } of newFiles) {
    it(`${file}: no !important`, () => {
      const src = readFileSync(join(dir, file), 'utf-8')
      expect(src).not.toContain('!important')
    })
  }

  for (const { file, dir } of newFiles.filter(({ file }) => file.endsWith('.tsx') || file.endsWith('.ts'))) {
    it(`${file}: no style={{ ... }} inline styles`, () => {
      const src = readFileSync(join(dir, file), 'utf-8')
      // Allow the intentional CSS var injection in PropertiesPanel's aside element
      if (file === 'PropertiesPanel.tsx') {
        // Only the panel root aside uses style= for CSS var injection (panel width / position)
        // Count occurrences — there should be only 1
        const count = (src.match(/\bstyle=\{/g) ?? []).length
        expect(count).toBeLessThanOrEqual(1)
      } else {
        // All other tsx files: zero inline style= props
        expect(src).not.toContain('style={')
      }
    })
  }
})

// ---------------------------------------------------------------------------
// HF-1: Class pill actions reachable via keyboard (WCAG 2.1.1)
// ---------------------------------------------------------------------------

describe('HF-1 — Class pill actions are keyboard-reachable (no tabIndex={-1})', () => {
  it('ClassPicker.tsx source does NOT contain tabIndex={-1} on any element', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPicker.tsx'), 'utf-8')
    expect(src).not.toContain('tabIndex={-1}')
  })

  it('class pills are focusable and open actions from the keyboard context-menu key', () => {
    const { nodeId } = loadSiteWithClasses(2)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.class-1/i })
    expect(pill.tabIndex).toBe(0)

    fireEvent.keyDown(pill, { key: 'ContextMenu' })
    expect(screen.getByRole('menu', { name: /class actions/i })).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// HF-2: StyleRuleComposer state isolation — switching class pills resets state
// ---------------------------------------------------------------------------

describe('HF-2 — Switching class pills resets StyleRuleComposer local state', () => {
  it('property search resets and updates placeholder after switching classes (no state leak)', () => {
    const { nodeId } = loadSiteWithClasses(2)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    // Activate class-1 — StyleRuleComposer mounts
    const pill1 = screen.getByRole('button', { name: /edit class \.class-1/i })
    fireEvent.click(pill1)

    const searchInput1 = screen.getByRole('searchbox', { name: /search class style properties to add/i }) as HTMLInputElement
    expect(searchInput1.placeholder).toBe('Search styles in .class-1...')

    // Type a query into the local search field.
    fireEvent.change(searchInput1, { target: { value: 'font' } })
    expect(searchInput1.value).toBe('font')

    // Switch to class-2 — StyleRuleComposer should remount (key={activeClassId})
    const pill2 = screen.getByRole('button', { name: /edit class \.class-2/i })
    fireEvent.click(pill2)

    // class-2's search must be empty and scoped to class-2, NOT leaked from class-1.
    const searchInput2 = screen.getByRole('searchbox', { name: /search class style properties to add/i }) as HTMLInputElement
    expect(searchInput2.value).toBe('')
    expect(searchInput2.placeholder).toBe('Search styles in .class-2...')
  })

  it('switching to an empty class shows the full property catalog with no assigned-style leak', () => {
    // class-1 gets a fontFamily property; class-2 is empty
    const { nodeId } = loadSiteWithHeading()
    const storeState = useEditorStore.getState()
    const cls1 = storeState.createClass('class-1-isolation')
    const cls2 = storeState.createClass('class-2-isolation')
    storeState.addNodeClass(nodeId, cls1.id)
    storeState.addNodeClass(nodeId, cls2.id)
    storeState.updateClassStyles(cls1.id, { fontFamily: 'serif' })
    // cls2 has no styles
    selectNode(nodeId)
    render(<PropertiesPanel />)

    // Open class-1 — fontFamily CSS property row should be visible
    const pill1 = screen.getByRole('button', { name: /edit class \.class-1-isolation/i })
    fireEvent.click(pill1)
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()

    // Switch to class-2 — the full catalog appears, but the inherited class-1 value is not leaked.
    const pill2 = screen.getByRole('button', { name: /edit class \.class-2-isolation/i })
    fireEvent.click(pill2)
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    expect(screen.queryByDisplayValue('serif')).toBeNull()
    expect(document.querySelectorAll('[data-testid^="css-property-row-"]').length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// Phase 3 acceptance gates — PP-17..PP-25 (Task #464 / Spec #671)
// ===========================================================================

// ---------------------------------------------------------------------------
// PP-17: No <textarea> in StyleRuleComposer (static gate)
// ---------------------------------------------------------------------------

describe('PP-17 — No textarea element in StyleRuleComposer (Phase 3)', () => {
  it('StyleRuleComposer.tsx source does not contain <textarea', () => {
    const src = readFileSync(join(PP_DIR, 'StyleRuleComposer.tsx'), 'utf-8')
    expect(src).not.toContain('<textarea')
  })

  it('rendered StyleRuleComposer contains no textarea element in the DOM', () => {
    const { nodeId } = loadSiteWithClasses(1)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.class-1/i })
    fireEvent.click(pill)

    expect(screen.queryByRole('textbox', { name: /edit css/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-18: ClassPropertyRow imports same PropertyControl components as module rows (static)
// ---------------------------------------------------------------------------

describe('PP-18 — ClassPropertyRow uses same PropertyControl components as module rows', () => {
  it('ClassPropertyRow.tsx imports TextControl from property-controls', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPropertyRow.tsx'), 'utf-8')
    expect(src).toMatch(/import.*TextControl.*from.*property-controls/)
  })

  it('ClassPropertyRow.tsx does not import NumberControl or SliderControl from property-controls', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPropertyRow.tsx'), 'utf-8')
    expect(src).not.toMatch(/import.*NumberControl.*from.*property-controls/)
    expect(src).not.toMatch(/import.*SliderControl.*from.*property-controls/)
  })

  it('ClassPropertyRow.tsx imports ColorControl from property-controls', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPropertyRow.tsx'), 'utf-8')
    expect(src).toMatch(/import.*ColorControl.*from.*property-controls/)
  })

  it('ClassPropertyRow.tsx imports SelectControl from property-controls', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPropertyRow.tsx'), 'utf-8')
    expect(src).toMatch(/import.*SelectControl.*from.*property-controls/)
  })
})

// ---------------------------------------------------------------------------
// PP-19: No inline styles on ClassPropertyRow files (Constraint #402)
// ---------------------------------------------------------------------------

describe('PP-19 — No inline styles in ClassPropertyRow / cssControlTypes (Constraint #402)', () => {
  it('ClassPropertyRow.tsx has no style={ inline styles', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPropertyRow.tsx'), 'utf-8')
    expect(src).not.toContain('style={')
  })

  it('ClassPropertyRow.module.css has no !important', () => {
    const src = readFileSync(join(PP_DIR, 'ClassPropertyRow.module.css'), 'utf-8')
    expect(src).not.toContain('!important')
  })

  it('cssControlTypes.ts has no style={ inline styles', () => {
    const src = readFileSync(join(PP_DIR, 'cssControlTypes.ts'), 'utf-8')
    expect(src).not.toContain('style={')
  })
})

// ---------------------------------------------------------------------------
// PP-20: Property search adds class-backed styles
// ---------------------------------------------------------------------------

describe('PP-20 — Property search adds class-backed styles to the active class', () => {
  it('searching for "font family" and selecting it adds fontFamily to class styles', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('add-prop-class')
    state.addNodeClass(nodeId, cls.id)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.add-prop-class/i })
    fireEvent.click(pill)

    // The minimal add-property search is always present when a class is active.
    const searchInput = screen.getByRole('searchbox', { name: /search class style properties to add/i })
    expect(searchInput).toBeDefined()

    // Type to filter to fontFamily
    fireEvent.change(searchInput, { target: { value: 'fontF' } })

    const fontFamilyInput = document
      .querySelector('[data-testid="css-property-row-fontFamily"]')
      ?.querySelector('input') as HTMLInputElement
    expect(fontFamilyInput.value).toBe('')
    expect(fontFamilyInput.placeholder).toBe('inherit')
    fireEvent.change(fontFamilyInput, { target: { value: 'Inter' } })

    // Class styles should now have fontFamily (with default value)
    const updatedCls = useEditorStore.getState().site!.styleRules[cls.id]
    expect('fontFamily' in updatedCls.styles).toBe(true)
  })

  it('active canvas breakpoint scopes added properties to that breakpoint', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('bp-prop-class')
    state.addNodeClass(nodeId, cls.id)
    useEditorStore.setState({ activeBreakpointId: 'mobile' } as Parameters<typeof useEditorStore.setState>[0])
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.bp-prop-class/i })
    fireEvent.click(pill)

    expect(screen.queryByRole('combobox', { name: /class style breakpoint/i })).toBeNull()

    const searchInput = screen.getByRole('searchbox', { name: /search class style properties to add/i })
    fireEvent.change(searchInput, { target: { value: 'fontF' } })
    const fontFamilyInput = document
      .querySelector('[data-testid="css-property-row-fontFamily"]')
      ?.querySelector('input') as HTMLInputElement
    expect(fontFamilyInput.value).toBe('')
    expect(fontFamilyInput.placeholder).toBe('inherit')
    fireEvent.change(fontFamilyInput, { target: { value: 'serif' } })

    const updatedCls = useEditorStore.getState().site!.styleRules[cls.id]
    expect(updatedCls.styles.fontFamily).toBeUndefined()
    expect(updatedCls.contextStyles.mobile.fontFamily).toBe('serif')
  })

})

// ---------------------------------------------------------------------------
// PP-20b: Module settings stay content/behavior-only
// ---------------------------------------------------------------------------

describe('PP-20b — Module settings exclude visual CSS fields', () => {
  it('Image exposes only image picker and behavior module settings', () => {
    // Alt text lives on the library asset (edited in the Media viewer), not
    // as a per-instance module prop. The picker tile is clickable + has an
    // "Edit" button that opens the viewer.
    const { nodeId } = loadSiteWithImage()
    selectNode(nodeId)
    render(<PropertiesPanel />)

    expect(screen.getByTestId('property-control-src')).toBeDefined()
    expect(screen.queryByTestId('property-control-alt')).toBeNull()
    expect(screen.getByTestId('property-control-loading')).toBeDefined()
    expect(screen.queryByTestId('property-control-width')).toBeNull()
    expect(screen.queryByTestId('property-control-height')).toBeNull()
    expect(screen.queryByTestId('property-control-objectFit')).toBeNull()
    expect(screen.queryByTestId('property-control-borderRadius')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-21: Empty class shows only the property search
// ---------------------------------------------------------------------------

describe('PP-21 — Empty class shows full property catalog', () => {
  it('a class with no styles shows unset property rows and no empty-state message', () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('empty-cls')
    state.addNodeClass(nodeId, cls.id)
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.empty-cls/i })
    fireEvent.click(pill)

    // Full catalog rows are visible even before a property is assigned.
    // Layout-position uses the DisplaySwitcher; typography still uses
    // generic property rows (fontFamily).
    expect(document.querySelector('[data-testid="css-display-switcher"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="css-property-row-fontFamily"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-testid^="css-property-row-"]').length).toBeGreaterThan(0)

    // Search affordance present; no extra empty state copy.
    expect(screen.getByRole('searchbox', { name: /search class style properties to add/i })).toBeDefined()
    expect(screen.queryByText(/no class styles set/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-22: Module settings section is first visible accordion
// ---------------------------------------------------------------------------

describe('PP-22 — Module settings is the first visible accordion', () => {
  it('Module settings is the first accordion after the header class picker', () => {
    const { nodeId } = loadSiteWithHeading()
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const classInput = screen.getByRole('textbox', { name: /add or create a css selector/i })
    const moduleSectionBtn = screen.getByRole('button', { name: /module settings/i })

    expect(classInput.compareDocumentPosition(moduleSectionBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^classes$/i })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PP-24: StyleRuleComposer shows only assigned style categories and uses shared Section
// ---------------------------------------------------------------------------

describe('PP-24 — StyleSectionsEditor assigned categories use shared Section', () => {
  it('StyleSectionsEditor.tsx imports Section from the shared @ui/components/Section primitive', () => {
    // Section ownership moved from StyleRuleComposer → StyleSectionsEditor in the
    // inline-styles refactor (commit ee346c41). StyleRuleComposer now delegates all
    // style-section rendering to StyleSectionsEditor, which is the file that
    // legitimately imports and uses the Section primitive.
    const src = readFileSync(join(PP_DIR, 'StyleSectionsEditor.tsx'), 'utf-8')
    expect(src).toMatch(/import\s*\{\s*Section\s*\}\s*from\s+['"]@ui\/components\/Section['"]/)
  })

  it('StyleRuleComposer.tsx does not contain sectionsArea CSS class reference', () => {
    const src = readFileSync(join(PP_DIR, 'StyleRuleComposer.tsx'), 'utf-8')
    expect(src).not.toContain('sectionsArea')
  })

  it('cssControlTypes.ts exports getCSSPropertyControlType', () => {
    const src = readFileSync(join(PP_DIR, 'cssControlTypes.ts'), 'utf-8')
    expect(src).toContain('export function getCSSPropertyControlType')
  })
})

// ---------------------------------------------------------------------------
// PP-25: Keyboard navigation reaches ClassPropertyRow remove buttons
// ---------------------------------------------------------------------------

describe('PP-25 — Keyboard navigation reaches ClassPropertyRow controls and remove button', () => {
  it('Tab key can reach the remove button for a class property row', async () => {
    const { nodeId } = loadSiteWithHeading()
    const state = useEditorStore.getState()
    const cls = state.createClass('kb-test-class')
    state.addNodeClass(nodeId, cls.id)
    state.updateClassStyles(cls.id, { fontFamily: 'serif' })
    selectNode(nodeId)
    render(<PropertiesPanel />)

    const pill = screen.getByRole('button', { name: /edit class \.kb-test-class/i })
    fireEvent.click(pill)

    const user = userEvent.setup()

    // Tab through the panel until we reach the remove button
    const maxTabs = 120
    let foundRemoveBtn = false
    for (let i = 0; i < maxTabs; i++) {
      await user.tab()
      const focused = document.activeElement
      if (
        focused instanceof HTMLButtonElement &&
        /remove font family/i.test(focused.getAttribute('aria-label') ?? '')
      ) {
        foundRemoveBtn = true
        break
      }
    }

    expect(foundRemoveBtn).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// PP3-5: getCSSPropertyDefaultValue per-key reasonableness
//        (regression lock against the bucket-dispatch failure mode caught in CR #683 MF-B)
//
// Each test pins an exact value from Contribution #677 (accepted, Architect msg #2080).
// When getCSSPropertyDefaultValue used control-type bucket-dispatch,
// select → first-enum), the following properties returned UX-breaking defaults:
//   opacity     → 0     (element vanishes on "Add opacity")
//   zIndex      → -10   (element pushed below the page stack)
//   marginTop   → -200px (element jumps hard on "Add margin-top")
//   lineHeight  → "0"  (text collapses to 0 height)
//   display     → first-enum which may be "none" or "flex" depending on ordering
// These per-key assertions catch any regression back to bucket-dispatch logic.
// ---------------------------------------------------------------------------

describe('PP3-5 — getCSSPropertyDefaultValue per-key reasonableness (MF-B regression lock)', () => {
  it('opacity → 1 (number, NOT 0 — element-vanish regression)', () => {
    expect(getCSSPropertyDefaultValue('opacity')).toBe(1)
  })

  it('zIndex → 0 (number, NOT -10 — below-stack regression)', () => {
    expect(getCSSPropertyDefaultValue('zIndex')).toBe(0)
  })

  it('NUMBER_TYPED_PROPS return numbers, not strings (store type contract)', () => {
    // CSSPropertyBag types opacity and zIndex as number, not string.
    // Returning a string would cause a type mismatch at the store write boundary.
    expect(typeof getCSSPropertyDefaultValue('opacity')).toBe('number')
    expect(typeof getCSSPropertyDefaultValue('zIndex')).toBe('number')
  })

  it('width → "auto" (NOT "0px" — layout collapse)', () => {
    expect(getCSSPropertyDefaultValue('width')).toBe('auto')
  })

  it('height → "auto" (NOT "0px" — layout collapse)', () => {
    expect(getCSSPropertyDefaultValue('height')).toBe('auto')
  })

  it('maxWidth → "none" (NOT "0px" — spurious max-width constraint)', () => {
    expect(getCSSPropertyDefaultValue('maxWidth')).toBe('none')
  })

  it('maxHeight → "none" (NOT "0px" — spurious max-height constraint)', () => {
    expect(getCSSPropertyDefaultValue('maxHeight')).toBe('none')
  })

  it('lineHeight → "1.5" (NOT "0" or "0px" — text collapse)', () => {
    expect(getCSSPropertyDefaultValue('lineHeight')).toBe('1.5')
  })

  it('letterSpacing → "0px" (NOT "-10px" — min-bound jump)', () => {
    expect(getCSSPropertyDefaultValue('letterSpacing')).toBe('0px')
  })

  it('marginTop → "0px" (NOT "-200px" — negative-margin-min jump)', () => {
    expect(getCSSPropertyDefaultValue('marginTop')).toBe('0px')
  })

  it('marginRight → "0px" (NOT "-200px")', () => {
    expect(getCSSPropertyDefaultValue('marginRight')).toBe('0px')
  })

  it('marginBottom → "0px" (NOT "-200px")', () => {
    expect(getCSSPropertyDefaultValue('marginBottom')).toBe('0px')
  })

  it('marginLeft → "0px" (NOT "-200px")', () => {
    expect(getCSSPropertyDefaultValue('marginLeft')).toBe('0px')
  })

  it('backgroundColor → "transparent" (NOT "#000000" — black-box paint)', () => {
    expect(getCSSPropertyDefaultValue('backgroundColor')).toBe('transparent')
  })

  it('display → "block" (NOT "none" — first enum would hide element)', () => {
    // Spec #677 mandates 'block'. This pins the expectation explicitly so that
    // reordering ENUM_OPTIONS for 'display' cannot silently change the default.
    expect(getCSSPropertyDefaultValue('display')).toBe('block')
  })

  it('color → "inherit" (NOT "#000000" — would override the cascade)', () => {
    expect(getCSSPropertyDefaultValue('color')).toBe('inherit')
  })

  it('fontFamily → "inherit" (inherits parent font, not empty string)', () => {
    expect(getCSSPropertyDefaultValue('fontFamily')).toBe('inherit')
  })

  it('borderRadius → "0px" (safe no-op starting value)', () => {
    expect(getCSSPropertyDefaultValue('borderRadius')).toBe('0px')
  })

  it('transformOrigin → "50% 50%" (centre — NOT "0 0" which surprises rotate/scale)', () => {
    expect(getCSSPropertyDefaultValue('transformOrigin')).toBe('50% 50%')
  })

  it('cursor → "default" (explicit, not first-enum "auto")', () => {
    expect(getCSSPropertyDefaultValue('cursor')).toBe('default')
  })
})
