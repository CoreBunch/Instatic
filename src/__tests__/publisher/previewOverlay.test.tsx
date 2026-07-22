/**
 * Preview Overlay — Integration & Source-Scan Tests (Phase 7 / J15)
 *
 * ─── Test groups ────────────────────────────────────────────────────────────
 *   1. uiSlice preview actions — openPreview / closePreview store contract
 *   2. PreviewOverlay DOM — renders dialog, iframe, close behaviours
 *   3. PreviewOverlay source — sandbox attr, WCAG focus-return pattern
 *   4. Happy-path golden: 2-node tree → expected HTML (Phase 7 requirement)
 *
 * Group 3 uses readFileSync source scanning (same pattern as toolbar.test.ts).
 * Groups 1–2 use @testing-library/react DOM integration (same as settingsModal.test.tsx).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { readFileSync } from 'fs'
import { PreviewOverlay } from '@site/preview/PreviewOverlay'
import { useEditorStore } from '@site/store/store'
import { publishPage } from '@core/publisher'
import { makeModule, makeRegistry, makePage, makeSite } from './helpers'

// ---------------------------------------------------------------------------
// Store reset
// ---------------------------------------------------------------------------

function resetStore() {
  useEditorStore.setState({
    site: null,
    activePageId: null,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    isSettingsOpen: false,
    activeSection: 'pages',
    previewOpen: false,
    hasUnsavedChanges: false,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

/** Open the preview with a simple one-page site loaded in the store. */
function openPreviewWithSite() {
  const page = {
    id: 'page-1',
    slug: 'index',
    title: 'Home',
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        moduleId: 'base.body',
        props: {},
        children: ['h1'],
        breakpointOverrides: {},
        locked: false,
        hidden: false,
      },
      h1: {
        id: 'h1',
        moduleId: 'base.text',
        props: { text: 'Welcome', level: 1 },
        children: [],
        breakpointOverrides: {},
        locked: false,
        hidden: false,
      },
    },
  }
  const site = makeSite({ name: 'Test Site', pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    previewOpen: true,
  } as Parameters<typeof useEditorStore.setState>[0])
}

const originalFetch = globalThis.fetch
const runtimePreviewCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
let runtimePreviewHtml = '<!DOCTYPE html><html><head><title>Test Site</title></head><body><h1>Welcome</h1></body></html>'

beforeEach(() => {
  resetStore()
  runtimePreviewCalls.length = 0
  runtimePreviewHtml = '<!DOCTYPE html><html><head><title>Test Site</title></head><body><h1>Welcome</h1></body></html>'
  globalThis.fetch = async (input, init) => {
    runtimePreviewCalls.push({ input, init })
    return new Response(JSON.stringify({
      html: runtimePreviewHtml,
      assets: [],
      runtimeAssets: { scripts: [] },
      diagnostics: [],
    }), { status: 200 })
  }
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// 1 — uiSlice preview actions
// ---------------------------------------------------------------------------

describe('uiSlice — preview state', () => {
  it('previewOpen defaults to false', () => {
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('openPreview() sets previewOpen to true', () => {
    useEditorStore.getState().openPreview()
    expect(useEditorStore.getState().previewOpen).toBe(true)
  })

  it('closePreview() sets previewOpen to false', () => {
    useEditorStore.getState().openPreview()
    useEditorStore.getState().closePreview()
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('openPreview and closePreview are defined as functions', () => {
    const state = useEditorStore.getState()
    expect(typeof state.openPreview).toBe('function')
    expect(typeof state.closePreview).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 2 — PreviewOverlay DOM integration
// ---------------------------------------------------------------------------

describe('PreviewOverlay — DOM rendering', () => {
  it('renders nothing when previewOpen is false', async () => {
    render(<PreviewOverlay />)
    expect(document.querySelector('[data-testid="preview-overlay"]')).toBeNull()
    expect(document.querySelector('[data-testid="preview-iframe"]')).toBeNull()
    await act(async () => {})
  })

  it('renders nothing when previewOpen=true but no site is loaded', async () => {
    useEditorStore.setState({ previewOpen: true } as Parameters<typeof useEditorStore.setState>[0])
    render(<PreviewOverlay />)
    expect(document.querySelector('[data-testid="preview-overlay"]')).toBeNull()
    await act(async () => {})
  })

  it('renders the dialog overlay when previewOpen=true with a site', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    expect(document.querySelector('[data-testid="preview-overlay"]')).not.toBeNull()
    await screen.findByTestId('preview-iframe')
  })

  it('overlay has role="dialog" and aria-modal="true"', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeDefined()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    await screen.findByTestId('preview-iframe')
  })

  it('renders the preview iframe inside the dialog', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const iframe = await screen.findByTestId('preview-iframe')
    expect(iframe).not.toBeNull()
  })

  it('iframe has a non-empty srcdoc attribute', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const iframe = await screen.findByTestId('preview-iframe')
    const srcdoc = iframe.getAttribute('srcdoc') ?? ''
    expect(srcdoc.length).toBeGreaterThan(0)
    expect(srcdoc).toContain('<!DOCTYPE html>')
  })

  it('iframe srcdoc contains the page title', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const iframe = await screen.findByTestId('preview-iframe')
    const srcdoc = iframe.getAttribute('srcdoc') ?? ''
    // The site name "Test Site" should appear as the page title
    expect(srcdoc).toMatch(/<title>[^<]*<\/title>/)
  })

  it('renders server-resolved loop content from the current draft (ISS-234)', async () => {
    runtimePreviewHtml = '<!DOCTYPE html><html><body><p>ISS-234 LOOP ROW</p></body></html>'
    openPreviewWithSite()
    const currentSite = useEditorStore.getState().site
    render(<PreviewOverlay />)

    const iframe = await screen.findByTestId('preview-iframe')
    expect(iframe.getAttribute('srcdoc')).toContain('ISS-234 LOOP ROW')
    expect(runtimePreviewCalls).toHaveLength(1)
    expect(runtimePreviewCalls[0]?.input).toBe('/admin/api/cms/runtime/preview')
    expect(JSON.parse(String(runtimePreviewCalls[0]?.init?.body))).toMatchObject({
      site: currentSite,
      pageId: 'page-1',
    })
  })

  it('close button has aria-label="Close preview"', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    const closeBtn = screen.getByLabelText('Close preview')
    expect(closeBtn).toBeDefined()
    await screen.findByTestId('preview-iframe')
  })

  it('clicking the close button closes the overlay (sets previewOpen=false)', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    await screen.findByTestId('preview-iframe')
    const closeBtn = screen.getByLabelText('Close preview')
    fireEvent.click(closeBtn)
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('pressing Escape closes the overlay', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    await screen.findByTestId('preview-iframe')
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('clicking the backdrop closes the overlay', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    await screen.findByTestId('preview-iframe')
    // Backdrop is the first aria-hidden element
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement | null
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)
    expect(useEditorStore.getState().previewOpen).toBe(false)
  })

  it('overlay header shows page title', async () => {
    openPreviewWithSite()
    render(<PreviewOverlay />)
    // Header reads "Preview — {page.title}"
    expect(document.body.textContent).toContain('Preview — Home')
    await screen.findByTestId('preview-iframe')
  })
})

// ---------------------------------------------------------------------------
// 3 — PreviewOverlay source-scan assertions
// ---------------------------------------------------------------------------

describe('PreviewOverlay — source enforcement', () => {
  const overlaySrc = readFileSync(
    new URL('../../admin/pages/site/preview/PreviewOverlay.tsx', import.meta.url),
    'utf-8',
  )

  it('has data-testid="preview-overlay" on the dialog', () => {
    expect(overlaySrc).toContain('data-testid="preview-overlay"')
  })

  it('has data-testid="preview-iframe" on the iframe', () => {
    expect(overlaySrc).toContain('data-testid="preview-iframe"')
  })

  it('iframe uses sandbox="" (fully sandboxed — maximum security)', () => {
    // sandbox="" with no value applies all restrictions (no scripts, no navigation, etc.)
    expect(overlaySrc).toContain('sandbox=""')
  })

  it('handles Escape key to close (Guideline #225)', () => {
    expect(overlaySrc).toContain("e.key === 'Escape'")
    expect(overlaySrc).toContain('closePreview()')
  })

  it('captures document.activeElement on open (WCAG 2.4.3 focus return)', () => {
    expect(overlaySrc).toContain('document.activeElement')
    expect(overlaySrc).toContain('triggerRef.current = document.activeElement')
  })

  it('restores focus to trigger on close (WCAG 2.4.3)', () => {
    expect(overlaySrc).toMatch(/else\s*\{[\s\S]*?\.focus\(\)/)
  })

  it('close button has aria-label="Close preview"', () => {
    expect(overlaySrc).toContain('aria-label="Close preview"')
  })

  it('close button uses the shared 44px Button size', () => {
    const closeActionStart = overlaySrc.indexOf('aria-label="Close preview"')
    const closeActionBlock = overlaySrc.slice(closeActionStart - 250, closeActionStart + 250)

    expect(closeActionBlock).toContain('<Button')
    expect(closeActionBlock).toContain('size="lg"')
  })

  it('backdrop has aria-hidden="true" (screen readers ignore it)', () => {
    expect(overlaySrc).toContain('aria-hidden="true"')
  })

  it('uses the CMS runtime preview boundary instead of bypassing server prefetch', () => {
    expect(overlaySrc).toContain('buildCmsRuntimePreview(')
    expect(overlaySrc).not.toContain('publishPage(')
  })
})

// ---------------------------------------------------------------------------
// 4 — Happy-path golden: 2-node tree → expected HTML (Phase 7 deliverable)
//
// Task #185 requires: "Unit test: render a simple 2-node tree and assert the
// HTML output matches expected string."
// ---------------------------------------------------------------------------

describe('publishPage — 2-node tree golden test (Phase 7)', () => {
  const rootModule = makeModule('base.body', {
    canHaveChildren: true,
    render: (_props, children) => ({ html: children.join('') }),
  })

  const headingModule = makeModule('base.text', {
    canHaveChildren: false,
    render: (props) => ({
      html: `<h1 class="instatic-heading">${props['text'] ?? ''}</h1>`,
      css: '/* base.text */\n.instatic-heading { font-family: sans-serif; margin: 0; }',
    }),
  })

  const reg = makeRegistry({ 'base.body': rootModule, 'base.text': headingModule })

  it('renders a 2-node tree (root + heading) to a complete HTML document', () => {
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['h1'] },
        h1: { moduleId: 'base.text', props: { text: 'Hello World' } },
      },
      'root',
    )
    const site = makeSite({ name: 'Golden Test', pages: [page] })

    const { html, filename } = publishPage(page, site, reg)

    // Document structure
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html')
    expect(html).toContain('<body>')
    expect(html).toContain('</html>')

    // Page content
    expect(html).toContain('<h1 class="instatic-heading">Hello World</h1>')

    // CSS injection (deduplicated)
    expect(html).toContain('.instatic-heading { font-family: sans-serif; margin: 0; }')

    // Filename derivation
    expect(filename).toBe('index.html')
  })

  it('HTML-escapes text props — XSS cannot reach the output', () => {
    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['h1'] },
        h1: { moduleId: 'base.text', props: { text: '<script>alert(1)</script>' } },
      },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, reg)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('CSS deduplication — 3 heading nodes produce 1 CSS entry', () => {
    const containerModule = makeModule('base.container', {
      canHaveChildren: true,
      render: (_props, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const regWithContainer = makeRegistry({
      'base.body': makeModule('base.body', {
        canHaveChildren: true,
        render: (_props, children) => ({ html: children.join('') }),
      }),
      'base.container': containerModule,
      'base.text': headingModule,
    })

    const page = makePage(
      {
        root: { moduleId: 'base.body', children: ['wrap'] },
        wrap: { moduleId: 'base.container', children: ['h1', 'h2', 'h3'] },
        h1: { moduleId: 'base.text', props: { text: 'A' } },
        h2: { moduleId: 'base.text', props: { text: 'B' } },
        h3: { moduleId: 'base.text', props: { text: 'C' } },
      },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, regWithContainer)

    // The text-module CSS marker appears exactly once
    const occurrences = (html.match(/\/\* base\.text \*\//g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('output contains CSP meta tag (Constraint #227)', () => {
    const page = makePage(
      { root: { moduleId: 'base.body', children: [] } },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, reg)
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("script-src 'none'")
  })

  it('output has zero editor artefacts', () => {
    const page = makePage(
      { root: { moduleId: 'base.body', children: [] } },
      'root',
    )
    const site = makeSite({ pages: [page] })
    const { html } = publishPage(page, site, reg)
    expect(html).not.toContain('data-testid')
    expect(html).not.toContain('zustand')
    expect(html).not.toContain('data-reactroot')
    expect(html).not.toContain('__editor')
  })
})
