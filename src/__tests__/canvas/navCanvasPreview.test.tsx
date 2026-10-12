/**
 * Canvas preview of base.nav / base.nav-item.
 *
 * Covers the two canvas contracts those modules rely on:
 *   - `canvasViewportWidth` reaches a module's editor component with the
 *     width of the breakpoint frame it renders in
 *   - a module's `canvasCss` is injected at the published cascade position
 *     (after the reset, before class CSS, inside `@layer user-authored`), so
 *     author CSS overrides it the way it does on a published page.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { BreakpointFrame } from '@site/canvas/BreakpointFrame'
import { collectModuleCanvasCss, generateCanvasClassCSS } from '@site/canvas/canvasClassCss'
import { registry, type AnyModuleDefinition } from '@core/module-engine'
import { PUBLISHER_RESET_CSS } from '@core/publisher'
import { classKindSelector, type StyleRule } from '@core/page-tree'
import { NAV_CANVAS_CSS, NAV_CSS } from '@modules/base/nav/navCss'
import { NAV_ITEM_CANVAS_CSS, NAV_ITEM_CSS, navItemCollapseCss } from '@modules/base/nav-item/navItemCss'
import { waitForCanvasFrameDocument, waitForCanvasNodeInFrame } from './iframeCanvasQuery'
import '@modules/base'

beforeEach(() => {
  cleanup()
  useEditorStore.setState({
    site: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    activeDocument: null,
    activePageId: null,
    activeBreakpointId: 'desktop',
  })
})

function buildNavPage(collapseBreakpoint: number) {
  const store = useEditorStore.getState()
  const site = store.createSite('Nav Preview')
  const rootId = site.pages[0].rootNodeId
  const navId = store.insertNode('base.nav', { collapseBreakpoint }, rootId)
  const itemId = store.insertNode('base.nav-item', { label: 'Products' }, navId)
  const childId = store.insertNode('base.nav-item', { label: 'Pricing' }, itemId)
  return { navId, itemId, childId }
}

function renderFrame(id: string, width: number) {
  return render(
    <BreakpointFrame
      page={useEditorStore.getState().site!.pages[0]}
      breakpoint={{ id, label: id, width, icon: 'smartphone' }}
      isActive
      onActivate={() => {}}
    />,
  )
}

describe('canvasViewportWidth', () => {
  it('collapses the nav in a frame at or below its collapse width', async () => {
    const { navId } = buildNavPage(768)
    renderFrame('mobile', 375)
    const nav = await waitForCanvasNodeInFrame('mobile', navId)
    expect(nav.getAttribute('data-instatic-nav-canvas')).toBe('collapsed')
  })

  it('treats a frame exactly as wide as the collapse width as collapsed, like max-width', async () => {
    const { navId } = buildNavPage(768)
    renderFrame('tablet', 768)
    const nav = await waitForCanvasNodeInFrame('tablet', navId)
    expect(nav.getAttribute('data-instatic-nav-canvas')).toBe('collapsed')
  })

  it('keeps the desktop row in a frame wider than the collapse width', async () => {
    const { navId } = buildNavPage(768)
    renderFrame('desktop', 1280)
    const nav = await waitForCanvasNodeInFrame('desktop', navId)
    expect(nav.hasAttribute('data-instatic-nav-canvas')).toBe(false)
  })
})

describe('nav canvas markup', () => {
  it('uses the published classes and data attributes, with no inline layout styles', async () => {
    const { navId, itemId, childId } = buildNavPage(768)
    renderFrame('mobile', 375)
    const nav = await waitForCanvasNodeInFrame('mobile', navId)
    const item = await waitForCanvasNodeInFrame('mobile', itemId)
    const child = await waitForCanvasNodeInFrame('mobile', childId)

    expect(nav.classList.contains('instatic-nav')).toBe(true)
    expect(nav.getAttribute('data-instatic-nav-mode')).toBe('dropdown')
    expect(nav.getAttribute('data-instatic-nav-align')).toBe('start')
    // An inline style would beat any class the author puts on the node.
    expect(nav.hasAttribute('style')).toBe(false)
    expect(nav.querySelector('.instatic-nav__menu')?.hasAttribute('style')).toBe(false)
    expect(nav.querySelector('.instatic-nav__toggle')?.hasAttribute('style')).toBe(false)

    expect(item.classList.contains('instatic-nav-item')).toBe(true)
    expect(item.hasAttribute('style')).toBe(false)
    expect(item.querySelector(':scope > a.instatic-nav-item__link')?.textContent).toBe('Products')
    expect(item.querySelector(':scope > .instatic-nav-item__submenu')?.contains(child)).toBe(true)
  })

  it('carries the menu background as a custom property on the menu list only', async () => {
    const { navId } = buildNavPage(768)
    useEditorStore.getState().updateNodeProps(navId, { menuBackground: '#112233' })
    renderFrame('mobile', 375)
    const nav = await waitForCanvasNodeInFrame('mobile', navId)
    const menu = nav.querySelector<HTMLElement>('.instatic-nav__menu')
    expect(menu?.style.getPropertyValue('--instatic-nav-menu-bg')).toBe('#112233')
    expect(nav.hasAttribute('style')).toBe(false)
  })

  it('renders an unlinked parent label as the toggle button, not an anchor', async () => {
    const { itemId } = buildNavPage(768)
    useEditorStore.getState().updateNodeProps(itemId, { isLink: false })
    renderFrame('mobile', 375)
    const item = await waitForCanvasNodeInFrame('mobile', itemId)
    expect(item.querySelector(':scope > a')).toBeNull()
    const label = item.querySelector(':scope > button.instatic-nav-item__link')
    expect(label?.textContent).toBe('Products')
    expect(label?.querySelector('.instatic-nav-item__toggle-icon')).not.toBeNull()
    expect(item.querySelector(':scope > .instatic-nav-item__toggle')).toBeNull()
  })
})

describe('module canvasCss', () => {
  const className = 'author_card'
  const authorClass: StyleRule = {
    id: className,
    name: className,
    kind: 'class',
    selector: classKindSelector(className),
    order: 0,
    styles: { padding: '40px' },
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
  }

  it('sits after the reset and before class CSS, the position module CSS has when published', () => {
    const css = generateCanvasClassCSS(
      { [className]: authorClass }, [], [], null, null, null, null, null,
      { moduleCss: '.module-marker { padding: 8px; }' },
    )
    const reset = css.indexOf(PUBLISHER_RESET_CSS)
    const moduleRule = css.indexOf('.module-marker')
    const classRule = css.indexOf(`.${className}`)
    expect(reset).toBe(0)
    expect(moduleRule).toBeGreaterThan(reset)
    expect(classRule).toBeGreaterThan(moduleRule)
  })

  it('regenerates when the module CSS changes', () => {
    const classes = { [className]: authorClass }
    const breakpoints: never[] = []
    const conditions: never[] = []
    const first = generateCanvasClassCSS(classes, breakpoints, conditions, null, null, null, null, null, { moduleCss: '.a {}' })
    const second = generateCanvasClassCSS(classes, breakpoints, conditions, null, null, null, null, null, { moduleCss: '.b {}' })
    expect(first).toContain('.a {}')
    expect(second).toContain('.b {}')
    expect(second).not.toContain('.a {}')
  })

  it('collects canvasCss from trusted modules only', () => {
    const base = registry.get('base.nav')
    const modules = [
      { ...base, id: 'test.trusted', trusted: true, canvasCss: '.trusted {}' },
      { ...base, id: 'test.plugin', trusted: false, canvasCss: '.plugin {}' },
      { ...base, id: 'test.none', trusted: true, canvasCss: undefined },
    ] as AnyModuleDefinition[]
    expect(collectModuleCanvasCss(modules)).toBe('.trusted {}')
  })

  it('registers the nav stylesheets on their modules', () => {
    expect(registry.get('base.nav').canvasCss).toBe(NAV_CANVAS_CSS)
    expect(registry.get('base.nav-item').canvasCss).toBe(NAV_ITEM_CANVAS_CSS)
  })

  it('injects them into the frame inside the author layer, never the unlayered chrome sheet', async () => {
    buildNavPage(768)
    renderFrame('mobile', 375)
    const doc = await waitForCanvasFrameDocument('mobile')
    const classSheet = doc.getElementById('mc-classes')?.textContent ?? ''
    expect(classSheet.startsWith('@layer user-authored {')).toBe(true)
    expect(classSheet).toContain('.instatic-nav-item__link {')
    expect(classSheet).toContain('.instatic-nav[data-instatic-nav-canvas="collapsed"] > .instatic-nav__menu {')
    expect(classSheet).not.toContain('@layer instatic-module-preview')

    const chromeSheet = doc.getElementById('instatic-editor-chrome')?.textContent ?? ''
    expect(chromeSheet).not.toContain('instatic-nav')
  })
})

describe('nav canvas stylesheet', () => {
  const collapsed = '.instatic-nav[data-instatic-nav-canvas="collapsed"]'
  const selected = ':is([data-canvas-selected="true"], :has([data-canvas-selected="true"]))'

  it('starts with the published static CSS, verbatim', () => {
    expect(NAV_CANVAS_CSS.startsWith(NAV_CSS)).toBe(true)
  })

  it('applies the published collapse rules to a collapsed frame instead of a media query', () => {
    expect(NAV_CANVAS_CSS).not.toContain('@media')
    expect(NAV_CANVAS_CSS).toContain(`${collapsed} > .instatic-nav__toggle {\n    display: inline-flex;`)
    expect(NAV_CANVAS_CSS).toContain(`${collapsed}[data-instatic-nav-mode="dropdown"] > .instatic-nav__menu {`)
    expect(NAV_CANVAS_CSS).toContain(`${collapsed}[data-instatic-nav-mode="overlay"] > .instatic-nav__menu {`)
  })

  it('closes the collapsed menu and opens it while the nav or a node inside it is selected', () => {
    expect(NAV_CANVAS_CSS).toContain(`${collapsed} > .instatic-nav__menu {\n    display: none;`)
    expect(NAV_CANVAS_CSS).toContain(`${collapsed}${selected} > .instatic-nav__menu {\n    display: flex;`)
    // Module JS never runs in the canvas, so nothing keys on its state attribute.
    expect(NAV_CANVAS_CSS).not.toContain('data-instatic-nav-state')
  })

  it('caps the overlay at one viewport height so it cannot cover the whole page frame', () => {
    expect(NAV_CANVAS_CSS).toContain(
      `${collapsed}[data-instatic-nav-mode="overlay"] > .instatic-nav__menu {\n    inset: 0 0 auto;\n    height: 100vh;`,
    )
  })

  it('never scroll-locks the frame document', () => {
    expect(NAV_CANVAS_CSS).not.toContain('html:has(')
  })
})

describe('nav-item canvas stylesheet', () => {
  const collapsed = '.instatic-nav[data-instatic-nav-canvas="collapsed"]'
  const selected = ':is([data-canvas-selected="true"], :has([data-canvas-selected="true"]))'
  const publishedOpen = '[data-instatic-nav-item-state="open"]'

  it('is the published CSS with the canvas selectors swapped in', () => {
    const published = NAV_ITEM_CSS + navItemCollapseCss(768)
    const expected = published
      .replace('\n@media (max-width: 768px) {', '')
      .replace(/\n\}$/, '')
      .replaceAll('.instatic-nav[data-instatic-nav-collapse="768"]', collapsed)
      .replaceAll(publishedOpen, selected)
    expect(NAV_ITEM_CANVAS_CSS.trimEnd()).toBe(expected)
  })

  it('keeps the link padding and the per-level indents the published page has', () => {
    expect(NAV_ITEM_CANVAS_CSS).toContain('.instatic-nav-item__link {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  padding: 8px 12px;')
    expect(NAV_ITEM_CANVAS_CSS).toContain(
      `${collapsed} .instatic-nav-item__submenu .instatic-nav-item__link {\n    padding-left: 28px;`,
    )
  })

  it('opens a submenu while its item or a node inside it is selected', () => {
    expect(NAV_ITEM_CANVAS_CSS).toContain(`.instatic-nav-item${selected} > .instatic-nav-item__submenu {\n  display: flex;`)
    expect(NAV_ITEM_CANVAS_CSS).toContain(
      `${collapsed} .instatic-nav-item${selected} > .instatic-nav-item__submenu {\n    display: flex;`,
    )
  })
})
