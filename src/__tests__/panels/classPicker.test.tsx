/**
 * Component-level tests for `ClassPicker`.
 *
 * The unit-level derivation logic is covered by `useClassPickerSuggestions.test.ts`;
 * this file exercises the rendered component end-to-end (input ↔ store ↔ DOM)
 * to drive the parent component's coverage and push its CRAP score below the
 * "critical" threshold without further extraction.
 *
 * Each test stands up a fresh editor store, a single-node page, renders
 * `<ClassPicker nodeId={...} />`, and drives it through DOM events the same
 * way a user would. Class state lives in the store; assertions read it back
 * via `useEditorStore.getState()`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ClassPicker } from '@site/panels/PropertiesPanel/ClassPicker'
import { useEditorStore } from '@site/store/store'
import { makeSite, makePage, makeNode } from '../fixtures'
import '@modules/base/index'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Store setup
// ---------------------------------------------------------------------------

function resetStore() {
  localStorage.clear()
  document.body.innerHTML = ''
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

function loadSiteWithNode(): { nodeId: string } {
  const rootId = 'root-1'
  const nodeId = 'text-1'
  const rootNode = makeNode({ id: rootId, moduleId: 'base.body', children: [nodeId] })
  const textNode = makeNode({
    id: nodeId,
    moduleId: 'base.text',
    props: { text: 'Hello', tag: 'h2' },
    children: [],
  })
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: { [rootId]: rootNode, [nodeId]: textNode },
  })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({ site, activePageId: 'page-1' } as Parameters<typeof useEditorStore.setState>[0])
  return { nodeId }
}

function selectClass(nodeId: string, name: string) {
  const state = useEditorStore.getState()
  const cls = state.createClass(name)
  state.addNodeClass(nodeId, cls.id)
  return cls
}

function createAmbient(selector: string) {
  return useEditorStore.getState().createAmbientRule({ selector })
}

/**
 * Render node markup inside a canvas breakpoint frame — the only place
 * `findRenderedCanvasNodeElement` resolves nodes from (the admin document is
 * full of `data-node-id` chrome: tree rows, overlay rings, import previews).
 */
function addRenderedCanvasFrame(html: string) {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  if (!frame.contentDocument) throw new Error('Test iframe did not create a contentDocument')
  frame.contentDocument.body.setAttribute('data-breakpoint-id', 'bp-desktop')
  frame.contentDocument.body.innerHTML = html
}

type CssSupportsGlobal = {
  CSS?: {
    supports: (conditionText: string) => boolean
  }
}

async function withCssSupports(
  supports: (conditionText: string) => boolean,
  run: () => Promise<void>,
) {
  const cssGlobal = globalThis as CssSupportsGlobal
  const originalCss = cssGlobal.CSS
  cssGlobal.CSS = { supports }
  try {
    await run()
  } finally {
    if (originalCss === undefined) {
      delete cssGlobal.CSS
    } else {
      cssGlobal.CSS = originalCss
    }
  }
}

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------

describe('ClassPicker — rendering', () => {
  it('renders the search input with the expected placeholder', () => {
    const { nodeId } = loadSiteWithNode()
    render(<ClassPicker nodeId={nodeId} />)
    expect(screen.getByPlaceholderText('Add or create selector…')).toBeTruthy()
  })

  it('renders an assigned class as a selector pill with a dotted class label', () => {
    const { nodeId } = loadSiteWithNode()
    selectClass(nodeId, 'header')
    render(<ClassPicker nodeId={nodeId} />)
    // Class-kind rules display as CSS selectors so they are visually distinct
    // from ambient selectors and plain text.
    expect(screen.getByRole('button', { name: /edit class \.header|deselect class \.header/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove class .header' })).toBeTruthy()
  })

  it('renders the trailing action node when supplied', () => {
    const { nodeId } = loadSiteWithNode()
    render(
      <ClassPicker nodeId={nodeId} trailingAction={<span data-testid="trailing">tt</span>} />,
    )
    expect(screen.getByTestId('trailing')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Input → suggestions flow
// ---------------------------------------------------------------------------

describe('ClassPicker — search + create', () => {
  it('shows the create-new affordance when typing a name no class has', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    await user.click(input)
    await user.type(input, 'brand-new')
    expect(screen.getByText('+ Create class “.brand-new”')).toBeTruthy()

    // Submit button tooltip surfaces the create intent.
    const submit = screen.getByRole('button', { name: 'Submit selector' })
    expect(submit.getAttribute('aria-label')).toBe('Submit selector')
    expect(submit.hasAttribute('disabled')).toBe(false)

    await user.click(submit)
    // Class should now exist on the node.
    const state = useEditorStore.getState()
    const node = state.site!.pages[0].nodes[nodeId]
    const classNames = node.classIds.map((id) => state.site!.styleRules[id]?.name)
    expect(classNames).toContain('brand-new')
  })

  it('disables the submit button when query is empty', () => {
    const { nodeId } = loadSiteWithNode()
    render(<ClassPicker nodeId={nodeId} />)
    const submit = screen.getByRole('button', { name: 'Submit selector' })
    // Button + tooltip combo uses aria-disabled rather than the native
    // attribute so mouseenter still fires the tooltip.
    expect(submit.getAttribute('aria-disabled')).toBe('true')
  })

  it('submitting an exact-match name on an unassigned class adds the class', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    // Pre-create a class that the node doesn't have yet.
    const cls = useEditorStore.getState().createClass('header')
    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    await user.click(input)
    await user.type(input, 'header')
    await user.keyboard('{Enter}')

    const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.classIds).toContain(cls.id)
  })

  it('Escape on a non-empty query closes the suggestions dropdown', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    useEditorStore.getState().createClass('alpha')
    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    await user.click(input)
    await user.type(input, 'a')

    // Suggestion menu is open. Escape closes it.
    await user.keyboard('{Escape}')
    // Submit button should still exist; the dropdown contextmenu is gone
    // (Suggestions dropdown is portaled; checking it disappears via DOM presence.)
    expect(screen.queryByRole('menu', { name: 'Selector suggestions' })).toBeNull()
  })

  it('validates selector creation before submit and never shows a create row for invalid CSS', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    render(<ClassPicker nodeId={nodeId} />)

    await withCssSupports((conditionText) => {
      if (conditionText === 'selector(*)') return true
      return conditionText !== 'selector(input:placeholder)'
    }, async () => {
      const input = screen.getByPlaceholderText('Add or create selector…')
      await user.click(input)
      await user.type(input, 'input:placeholder')

      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByTestId('class-picker-invalid-selector').textContent).toContain(
        'Invalid CSS selector: input:placeholder',
      )
      expect(screen.queryByText('+ Create selector “input:placeholder”')).toBeNull()
      expect(screen.getByRole('button', { name: 'Submit selector' }).getAttribute('aria-disabled')).toBe('true')

      await user.keyboard('{Enter}')
      expect(screen.queryByRole('alert')).toBeNull()
      expect(screen.getByTestId('class-picker-invalid-selector').textContent).toContain(
        'Invalid CSS selector: input:placeholder',
      )
      expect(screen.queryByText('+ Create selector “input:placeholder”')).toBeNull()
      expect(screen.getByRole('menu', { name: 'Selector suggestions' })).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// Pill interactions
// ---------------------------------------------------------------------------

describe('ClassPicker — assigned pill', () => {
  it('clicking a pill toggles activeClassId in the store', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    const cls = selectClass(nodeId, 'card')
    render(<ClassPicker nodeId={nodeId} />)

    const pill = screen.getByRole('button', { name: /edit class \.card|deselect class \.card/i })
    await user.click(pill)
    expect(useEditorStore.getState().activeClassId).toBe(cls.id)

    await user.click(pill)
    expect(useEditorStore.getState().activeClassId).toBeNull()
  })

  it('clicking the X removes the class from the node but keeps it in the registry', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    const cls = selectClass(nodeId, 'card')
    render(<ClassPicker nodeId={nodeId} />)

    const remove = screen.getByRole('button', { name: 'Remove class .card' })
    await user.click(remove)

    const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.classIds).not.toContain(cls.id)
    // Class definition itself survives.
    expect(useEditorStore.getState().site!.styleRules[cls.id]?.name).toBe('card')
  })

  it('Enter on a focused pill toggles activeClassId via keyboard', () => {
    const { nodeId } = loadSiteWithNode()
    const cls = selectClass(nodeId, 'header')
    render(<ClassPicker nodeId={nodeId} />)

    const pill = screen.getByRole('button', { name: /edit class \.header|deselect class \.header/i })
    const initiallyActive = useEditorStore.getState().activeClassId === cls.id
    pill.focus()
    fireEvent.keyDown(pill, { key: 'Enter' })

    expect(useEditorStore.getState().activeClassId).toBe(initiallyActive ? null : cls.id)
  })

  it('right-click on a pill opens a class context menu', () => {
    const { nodeId } = loadSiteWithNode()
    selectClass(nodeId, 'header')
    render(<ClassPicker nodeId={nodeId} />)

    const pill = screen.getByRole('button', { name: /edit class \.header|deselect class \.header/i })
    fireEvent.contextMenu(pill, { clientX: 0, clientY: 0 })

    // Context menu opens — assert at least the Remove item is present.
    expect(screen.getByRole('menuitem', { name: /remove from this element/i })).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Ambient selector pills + suggestions
// ---------------------------------------------------------------------------

describe('ClassPicker — ambient selectors', () => {
  it('auto-activates a matching ambient selector on selection, renders it without a remove action, and lets it be toggled', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    addRenderedCanvasFrame(`<section class="hero"><h1 data-node-id="${nodeId}" class="title"></h1></section>`)
    const ambient = createAmbient('.hero .title')

    render(<ClassPicker nodeId={nodeId} />)

    // The most specific matching selector auto-activates on selection, so an
    // element styled purely by a descendant selector opens straight into edit.
    expect(useEditorStore.getState().activeClassId).toBe(ambient.id)

    // The pill is present (now showing its active "Deselect" affordance) and
    // carries no remove action — an ambient rule isn't a class "on" the node.
    const pill = screen.getByRole('button', { name: 'Deselect selector .hero .title' })
    expect(pill).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Remove selector .hero .title' })).toBeNull()

    // Clicking the active pill toggles editing back off.
    await user.click(pill)
    expect(useEditorStore.getState().activeClassId).toBeNull()
  })

  it('shows non-matching ambient selectors as disabled dropdown rows', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    addRenderedCanvasFrame(`<h1 data-node-id="${nodeId}" class="title"></h1>`)
    createAmbient('.card')

    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    await user.click(input)

    expect(screen.getByText('Ambient selectors')).toBeTruthy()
    expect(screen.getByText("Doesn't match this element")).toBeTruthy()
    const row = screen.getByRole('menuitem', { name: /\.card doesn't match this element/i })
    expect(row.getAttribute('aria-disabled')).toBe('true')
  })

  it('matches ambient selectors against elements inside the canvas iframe', () => {
    const { nodeId } = loadSiteWithNode()
    addRenderedCanvasFrame(`<h1 data-node-id="${nodeId}" class="title"></h1>`)
    createAmbient('h1.title')

    render(<ClassPicker nodeId={nodeId} />)

    expect(
      screen.getByRole('button', { name: /edit selector h1\.title|deselect selector h1\.title/i }),
    ).toBeTruthy()
  })

  it('ignores the selection-ring overlay and matches the real canvas element', () => {
    const { nodeId } = loadSiteWithNode()
    // The selection ring duplicates the node id in the admin document but carries
    // none of the node's classes. It must not shadow the real rendered element —
    // otherwise class-dependent selectors like `.btn-primary:hover` silently fail
    // whenever the node is selected (the reported bug).
    const ring = document.createElement('div')
    ring.setAttribute('data-node-id', nodeId)
    ring.setAttribute('data-canvas-selection-ring', 'true')
    document.body.appendChild(ring)
    addRenderedCanvasFrame(`<a data-node-id="${nodeId}" class="btn-primary" href="#">Buy</a>`)
    createAmbient('.btn-primary:hover')

    render(<ClassPicker nodeId={nodeId} />)

    expect(screen.getByRole('button', { name: 'Edit selector .btn-primary:hover' })).toBeTruthy()
  })

  it('shows an inline undo affordance when a newly-created ambient selector does not match', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    addRenderedCanvasFrame(`<h1 data-node-id="${nodeId}" class="title"></h1>`)
    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    await user.click(input)
    await user.type(input, '.hero .missing')
    await user.keyboard('{Enter}')

    const created = Object.values(useEditorStore.getState().site!.styleRules).find(
      (rule) => rule.kind === 'ambient' && rule.selector === '.hero .missing',
    )
    expect(created).toBeDefined()
    expect(useEditorStore.getState().activeClassId).not.toBe(created!.id)
    expect(screen.getByText('.hero .missing')).toBeTruthy()
    expect(screen.getByText(/was added but does not match this element/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Undo selector .hero .missing creation' }))

    expect(useEditorStore.getState().site!.styleRules[created!.id]).toBeUndefined()
    expect(screen.queryByText(/was added but does not match this element/i)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Empty-query suggestions sections
// ---------------------------------------------------------------------------

describe('ClassPicker — empty-query suggestions', () => {
  it('opens the suggestions dropdown on focus and lists All-classes when there is no usage history', () => {
    const { nodeId } = loadSiteWithNode()
    useEditorStore.getState().createClass('alpha')
    useEditorStore.getState().createClass('beta')
    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    act(() => input.focus())

    // Both class-kind rules should appear with their CSS class selector prefix.
    expect(screen.getByRole('menuitem', { name: '.alpha' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: '.beta' })).toBeTruthy()
  })

  it('clicking a suggestion assigns it to the node', async () => {
    const user = userEvent.setup()
    const { nodeId } = loadSiteWithNode()
    const cls = useEditorStore.getState().createClass('alpha')
    render(<ClassPicker nodeId={nodeId} />)

    const input = screen.getByPlaceholderText('Add or create selector…')
    await user.click(input)

    const item = await screen.findByRole('menuitem', { name: '.alpha' })
    await user.click(item)

    const node = useEditorStore.getState().site!.pages[0].nodes[nodeId]
    expect(node.classIds).toContain(cls.id)
  })
})
