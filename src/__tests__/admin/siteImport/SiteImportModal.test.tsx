/**
 * SiteImportModal — DOM integration tests.
 *
 * Test groups:
 *   1.  Global modal state — siteImportOpen / open / close actions
 *   2.  Render             — dialog initial state
 *   3.  DropStep errors — role="alert" rendered from errorMessage prop
 *   4.  Helper logic    — filterPlanBySelection, makeDefaultSelection, describeIngestError
 *   5.  ImportStep      — running / complete / failed states from RunProgress
 *   6.  ConflictsStep   — shows/hides sections based on conflict lists
 *   7.  AnalyzeStep     — media rows render from plan.assets
 *
 * Uses @testing-library/react with the happy-dom GlobalWindow from setup.ts.
 * Store is reset in beforeEach; DOM is cleaned in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import React from 'react'
import { render, screen, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react'
import { useEditorStore } from '@site/store/store'
import { useAdminUi } from '@admin/state/adminUi'
import { subscribeToasts, type Toast } from '@ui/components/Toast/toastBus'
import { DropStep } from '@admin/modals/SiteImport/steps/DropStep'
import { ImportStep } from '@admin/modals/SiteImport/steps/ImportStep'
import {
  makeInitialRunProgress,
  type RunProgress,
} from '@admin/modals/SiteImport/shared/importProgress'
import { ConflictsStep } from '@admin/modals/SiteImport/steps/ConflictsStep'
import { AnalyzeStep } from '@admin/modals/SiteImport/steps/AnalyzeStep'
import { SiteImportModal } from '@admin/modals/SiteImport'
import type { ImportSelection } from '@admin/modals/SiteImport'
import { commitImportPlan } from '@core/siteImport'
import { pageToCells } from '@core/data/pageFromRow'
// Static-site import maps HTML into base modules during plan analysis.
import '@modules/base'
import type {
  ImportPlan,
  ImportResult,
  ConflictResolution,
  FileMap,
  NewStyleRule,
  SiteImportAdapter,
} from '@core/siteImport'
import type { DataRow, DataTable } from '@core/data/schemas'
import type { SiteBundle } from '@core/data/bundleSchema'
import type { Page, SiteDocument } from '@core/page-tree'
import { makeSite } from '../../fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset store to a known state between tests. */
function resetStore() {
  useEditorStore.setState({
    site: null,
  } as Parameters<typeof useEditorStore.setState>[0])
  useAdminUi.setState({
    siteImportOpen: false,
  } as Parameters<typeof useAdminUi.setState>[0])
}

beforeEach(resetStore)
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  cleanup()
})

// ---------------------------------------------------------------------------
// Minimal plan + result fixtures for subcomponent tests
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000

function makeStyleRule(overrides: Partial<NewStyleRule> = {}): NewStyleRule {
  return {
    name: overrides.name ?? 'test-class',
    kind: overrides.kind ?? 'class',
    selector: overrides.selector ?? '.test-class',
    order: overrides.order ?? 0,
    styles: {},
    contextStyles: {},
  }
}

function makeMinimalPlan(overrides: Partial<ImportPlan> = {}): ImportPlan {
  return {
    pages: overrides.pages ?? [],
    styleRules: overrides.styleRules ?? [],
    styleRuleSources: overrides.styleRuleSources ?? [],
    fonts: overrides.fonts ?? [],
    googleFonts: overrides.googleFonts ?? [],
    fontTokens: overrides.fontTokens ?? [],
    conditions: overrides.conditions ?? [],
    assets: overrides.assets ?? [],
    colors: overrides.colors ?? [],
    scripts: overrides.scripts ?? [],
    linkedStylesheets: overrides.linkedStylesheets ?? [],
    stylesheets: overrides.stylesheets ?? [],
    conflicts: overrides.conflicts ?? { pages: [], rules: [], tokens: [], crossSheetClasses: [] },
    warnings: overrides.warnings ?? [],
    droppedAtRules: overrides.droppedAtRules ?? [],
    unusedCss: overrides.unusedCss ?? [],
  }
}

function makeMinimalResult(overrides: Partial<ImportResult> = {}): ImportResult {
  return {
    pages: overrides.pages ?? [],
    styleRules: overrides.styleRules ?? [],
    fonts: overrides.fonts ?? [],
    fontTokens: overrides.fontTokens ?? [],
    assets: overrides.assets ?? [],
    colors: overrides.colors ?? [],
    scripts: overrides.scripts ?? [],
    stylesheets: overrides.stylesheets ?? [],
    conflicts: overrides.conflicts ?? { pages: [], rules: [], tokens: [], crossSheetClasses: [] },
    warnings: overrides.warnings ?? [],
  }
}

const CMS_BUNDLE_TABLE: DataTable = {
  id: 'posts',
  name: 'Posts',
  slug: 'posts',
  kind: 'postType',
  singularLabel: 'Post',
  pluralLabel: 'Posts',
  routeBase: '/posts',
  primaryFieldId: 'title',
  fields: [],
  system: true,
  createdByUserId: null,
  updatedByUserId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const CMS_BUNDLE_ROW: DataRow = {
  id: 'cms-row-1',
  tableId: 'posts',
  cells: { title: 'Imported post', slug: 'imported-post' },
  slug: 'imported-post',
  status: 'published',
  authorUserId: null,
  createdByUserId: null,
  updatedByUserId: null,
  publishedByUserId: null,
  author: null,
  createdBy: null,
  updatedBy: null,
  publishedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  publishedAt: null,
  scheduledPublishAt: null,
  deletedAt: null,
}

const CMS_BUNDLE: SiteBundle = {
  schemaVersion: 1,
  exportedAt: '2026-05-19T10:00:00.000Z',
  sourceSiteName: 'Fixture CMS Site',
  tables: [CMS_BUNDLE_TABLE],
  rows: [CMS_BUNDLE_ROW],
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function siteShell(site: SiteDocument): Omit<SiteDocument, 'pages' | 'visualComponents'> {
  const { pages: _pages, visualComponents: _visualComponents, ...shell } = site
  return shell
}

function pageRow(page: Page): DataRow {
  return {
    id: page.id,
    tableId: 'pages',
    cells: pageToCells(page),
    slug: page.slug,
    status: 'draft',
    authorUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    publishedByUserId: null,
    author: null,
    createdBy: null,
    updatedBy: null,
    publishedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    scheduledPublishAt: null,
    deletedAt: null,
  }
}

function mockDraftSiteLoad(site: SiteDocument): string[] {
  const requested: string[] = []
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    if (url === '/admin/api/cms/site') {
      return jsonResponse({ site: siteShell(site) })
    }
    if (url === '/admin/api/cms/pages') {
      return jsonResponse({ rows: site.pages.map(pageRow) })
    }
    if (url === '/admin/api/cms/components') {
      return jsonResponse({ rows: [] })
    }
    return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
  }
  return requested
}

function dropCmsBundleFile(bundle: SiteBundle, name = 'site-bundle.json') {
  const bundleFile = new File([JSON.stringify(bundle)], name, {
    type: 'application/json',
  })
  fireEvent.drop(screen.getByLabelText(/drop site files/i), {
    dataTransfer: { files: [bundleFile] },
  })
}

function SiteImportHarness({ onCmsBundleImportComplete }: { onCmsBundleImportComplete?: () => void }) {
  const open = useAdminUi((s) => s.siteImportOpen)
  return open ? <SiteImportModal onCmsBundleImportComplete={onCmsBundleImportComplete} /> : null
}

// ---------------------------------------------------------------------------
// 1 — Admin UI state: siteImportOpen / openSiteImport / closeSiteImport
// ---------------------------------------------------------------------------

describe('SiteImportModal — global modal state', () => {
  it('opens and closes the modal flag idempotently', () => {
    expect(useAdminUi.getState().siteImportOpen).toBe(false)

    useAdminUi.getState().openSiteImport()
    useAdminUi.getState().openSiteImport()
    expect(useAdminUi.getState().siteImportOpen).toBe(true)

    useAdminUi.getState().closeSiteImport()
    useAdminUi.getState().closeSiteImport()
    expect(useAdminUi.getState().siteImportOpen).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2 — Render: initial drop step
// ---------------------------------------------------------------------------

describe('SiteImportModal — render', () => {
  it('renders the initial drop-step dialog when opened', () => {
    const site = makeSite()
    useEditorStore.setState({ site } as Parameters<typeof useEditorStore.setState>[0])
    render(<SiteImportModal />)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(screen.getByText('Import site')).toBeDefined()
    expect(screen.getByText('Choose files')).toBeDefined()
  })
})

describe('SiteImportModal — CMS bundle import', () => {
  it('routes a CMS-exported JSON bundle into the bundle preview flow', async () => {
    let previewRequestBody: unknown = null
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/import/preview') {
        previewRequestBody = JSON.parse(String(init?.body ?? '{}'))
        return jsonResponse({
          meta: {
            exportedAt: CMS_BUNDLE.exportedAt,
            sourceSiteName: CMS_BUNDLE.sourceSiteName,
            schemaVersion: 1,
          },
          tables: [
            {
              id: 'posts',
              name: 'Posts',
              kind: 'postType',
              inBundle: 1,
              willReplace: 0,
              willAdd: 1,
              currentLocal: 0,
            },
          ],
          totals: {
            rows: 1,
            mediaFiles: 0,
            mediaEmbedded: false,
          },
        })
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    useEditorStore.setState({
      site: makeSite(),
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<SiteImportModal />)

    dropCmsBundleFile(CMS_BUNDLE)

    expect(await screen.findByText(/diff against current site/i)).toBeDefined()
    expect(screen.getByText(/fixture cms site/i)).toBeDefined()
    expect(screen.getByText(/import strategy/i)).toBeDefined()
    expect((previewRequestBody as SiteBundle).schemaVersion).toBe(1)
  })

  it('imports the CMS bundle with the selected strategy and closes through the store flag', async () => {
    let importUrl: string | null = null
    let importBody: unknown = null
    let callbackCalled = false
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/admin/api/cms/import/preview') {
        return jsonResponse({
          meta: {
            exportedAt: CMS_BUNDLE.exportedAt,
            sourceSiteName: CMS_BUNDLE.sourceSiteName,
            schemaVersion: 1,
          },
          tables: [
            {
              id: 'posts',
              name: 'Posts',
              kind: 'postType',
              inBundle: 1,
              willReplace: 0,
              willAdd: 1,
              currentLocal: 0,
            },
          ],
          totals: {
            rows: 1,
            mediaFiles: 0,
            mediaEmbedded: false,
          },
        })
      }
      if (url.startsWith('/admin/api/cms/import')) {
        importUrl = url
        importBody = JSON.parse(String(init?.body ?? '{}'))
        return jsonResponse({
          ok: true,
          strategy: 'merge-add',
          tablesAffected: 1,
          rowsInserted: 1,
          rowsReplaced: 0,
          rowsSkipped: 0,
          mediaImported: 0,
        })
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }
    let capturedToasts: Toast[] = []
    const unsubscribe = subscribeToasts((snapshot) => { capturedToasts = [...snapshot] })

    try {
      useEditorStore.setState({
        site: makeSite(),
      } as Parameters<typeof useEditorStore.setState>[0])
      useAdminUi.getState().openSiteImport()

      render(
        <SiteImportHarness
          onCmsBundleImportComplete={() => { callbackCalled = true }}
        />,
      )

      dropCmsBundleFile(CMS_BUNDLE)
      expect(await screen.findByText(/diff against current site/i)).toBeDefined()

      fireEvent.click(screen.getByRole('button', { name: /add rows/i }))

      await waitFor(() => {
        expect(callbackCalled).toBe(true)
      })
      expect(useAdminUi.getState().siteImportOpen).toBe(false)
      expect(importUrl).toContain('strategy=merge-add')
      expect((importBody as SiteBundle).schemaVersion).toBe(1)
      expect(capturedToasts.some((toast) => toast.kind === 'success' && toast.title === 'Import complete')).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('keeps CMS bundle import disabled when the preview has no rows or media', async () => {
    const emptyBundle: SiteBundle = {
      ...CMS_BUNDLE,
      sourceSiteName: 'Empty Fixture Site',
      rows: [],
    }
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/admin/api/cms/import/preview') {
        return jsonResponse({
          meta: {
            exportedAt: emptyBundle.exportedAt,
            sourceSiteName: emptyBundle.sourceSiteName,
            schemaVersion: 1,
          },
          tables: [
            {
              id: 'posts',
              name: 'Posts',
              kind: 'postType',
              inBundle: 0,
              willReplace: 0,
              willAdd: 0,
              currentLocal: 5,
            },
          ],
          totals: {
            rows: 0,
            mediaFiles: 0,
            mediaEmbedded: false,
          },
        })
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 500)
    }

    useEditorStore.setState({
      site: makeSite(),
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<SiteImportModal />)

    dropCmsBundleFile(emptyBundle, 'empty-site-bundle.json')

    expect(await screen.findByText(/no content in this bundle/i)).toBeDefined()
    expect((screen.getByRole('button', { name: /add rows/i }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SiteImportModal — global static import', () => {
  it('loads the CMS draft before analyzing static files when the editor store is empty', async () => {
    const draftSite = makeSite({ name: 'Global Draft Site' })
    const requested = mockDraftSiteLoad(draftSite)

    useEditorStore.setState({
      site: null,
    } as Parameters<typeof useEditorStore.setState>[0])

    render(<SiteImportModal />)

    const htmlFile = new File(
      ['<!doctype html><html><head><title>Imported page</title></head><body><h1>Imported page</h1></body></html>'],
      'imported.html',
      { type: 'text/html' },
    )
    fireEvent.drop(screen.getByLabelText(/drop site files/i), {
      dataTransfer: { files: [htmlFile] },
    })

    expect(await screen.findByText('Review import')).toBeDefined()
    expect(screen.queryByText(/editor has no site loaded/i)).toBeNull()
    expect(useEditorStore.getState().site?.name).toBe('Global Draft Site')
    expect(requested).toEqual([
      '/admin/api/cms/site',
      '/admin/api/cms/pages',
      '/admin/api/cms/components',
    ])
  })
})

// ---------------------------------------------------------------------------
// 3 — DropStep error handling
// ---------------------------------------------------------------------------

describe('DropStep — error message rendering', () => {
  const noop = () => {}

  it('renders no role="alert" when errorMessage is null', () => {
    render(
      <DropStep
        busy={false}
        errorMessage={null}
        onFilesReady={noop}
        onZipReady={noop}
      />,
    )
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders role="alert" with the error text when errorMessage is set', () => {
    render(
      <DropStep
        busy={false}
        errorMessage="No importable files found."
        onFilesReady={noop}
        onZipReady={noop}
      />,
    )
    const alert = document.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('No importable files found.')
  })

  it('renders "Ingesting files and analyzing…" status when busy', () => {
    render(
      <DropStep
        busy={true}
        errorMessage={null}
        onFilesReady={noop}
        onZipReady={noop}
      />,
    )
    const status = document.querySelector('[aria-live="polite"]')
    expect(status).not.toBeNull()
    expect(status!.textContent).toContain('Ingesting files and analyzing')
  })

  it('buttons are disabled when busy', () => {
    render(
      <DropStep
        busy={true}
        errorMessage={null}
        onFilesReady={noop}
        onZipReady={noop}
      />,
    )
    const buttons = Array.from(document.querySelectorAll('button'))
    // Both "Choose files" and "Choose folder" buttons should be disabled
    const chooseFilesBtn = buttons.find((b) => b.textContent?.includes('Choose files'))
    const chooseFolderBtn = buttons.find((b) => b.textContent?.includes('Choose folder'))
    expect(chooseFilesBtn?.disabled).toBe(true)
    expect(chooseFolderBtn?.disabled).toBe(true)
  })

  it('calls onFilesReady when a non-zip file is selected', async () => {
    let receivedFiles: File[] = []
    render(
      <DropStep
        busy={false}
        errorMessage={null}
        onFilesReady={(files) => { receivedFiles = files }}
        onZipReady={noop}
      />,
    )
    const htmlFile = new File(['<html><body>hello</body></html>'], 'index.html', { type: 'text/html' })
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).not.toBeNull()

    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [htmlFile] } })
    })
    // dispatchFiles is async but tiny; allow microtask queue to settle
    await act(async () => {})
    expect(receivedFiles).toHaveLength(1)
    expect(receivedFiles[0].name).toBe('index.html')
  })
})

// ---------------------------------------------------------------------------
// 4 — Helper logic: filterPlanBySelection / makeDefaultSelection / describeIngestError
//     These are module-private in SiteImportModal.tsx — tested via inline re-
//     implementation to validate the logic independently of the component.
// ---------------------------------------------------------------------------

describe('filterPlanBySelection — page filtering', () => {
  const pageA = {
    source: 'a.html',
    title: 'Page A',
    slug: 'a',
    linkedCssPaths: [],
    scripts: [],
    nodeFragment: { rootNodeId: 'r', nodes: {} },
  }
  const pageB = {
    source: 'b.html',
    title: 'Page B',
    slug: 'b',
    linkedCssPaths: [],
    scripts: [],
    nodeFragment: { rootNodeId: 'r', nodes: {} },
  }
  const rule0 = makeStyleRule({ name: 'rule-0' })
  const rule1 = makeStyleRule({ name: 'rule-1' })
  const assetA = { sourcePath: 'img/a.png', mimeType: 'image/png', bytes: new Uint8Array() }
  const assetB = { sourcePath: 'img/b.png', mimeType: 'image/png', bytes: new Uint8Array() }

  const plan = makeMinimalPlan({
    pages: [pageA, pageB],
    styleRules: [rule0, rule1],
    assets: [assetA, assetB],
    scripts: [
      { path: 'scripts/a.js', content: '', format: 'classic', pageSources: ['a.html'], priority: 100 },
      { path: 'scripts/shared.js', content: '', format: 'classic', pageSources: ['a.html', 'b.html'], priority: 101 },
    ],
  })

  function filterPlanBySelection(
    p: ImportPlan,
    sel: {
      pagesIncluded: Set<string>
      styleRulesIncluded: Set<number>
      assetsIncluded: Set<string>
      fontsIncluded: Set<string>
      scriptsIncluded: Set<string>
    },
  ): ImportPlan {
    return {
      ...p,
      pages: p.pages.filter((pg) => sel.pagesIncluded.has(pg.source)),
      styleRules: p.styleRules.filter((_, i) => sel.styleRulesIncluded.has(i)),
      assets: p.assets.filter((a) => sel.assetsIncluded.has(a.sourcePath)),
      fonts: p.fonts.filter((f) => sel.fontsIncluded.has(f.family)),
      googleFonts: p.googleFonts.filter((f) => sel.fontsIncluded.has(f.family)),
      scripts: p.scripts
        .filter((script) => sel.scriptsIncluded.has(script.path))
        .map((script) => ({
          ...script,
          pageSources: script.pageSources.filter((source) => sel.pagesIncluded.has(source)),
        }))
        .filter((script) => script.pageSources.length > 0),
    }
  }

  it('keeps all items when selection includes everything', () => {
    const sel = {
      pagesIncluded: new Set(['a.html', 'b.html']),
      styleRulesIncluded: new Set([0, 1]),
      assetsIncluded: new Set(['img/a.png', 'img/b.png']),
      fontsIncluded: new Set<string>(),
      scriptsIncluded: new Set(['scripts/a.js', 'scripts/shared.js']),
    }
    const filtered = filterPlanBySelection(plan, sel)
    expect(filtered.pages).toHaveLength(2)
    expect(filtered.styleRules).toHaveLength(2)
    expect(filtered.assets).toHaveLength(2)
    expect(filtered.scripts).toHaveLength(2)
  })

  it('removes deselected page', () => {
    const sel = {
      pagesIncluded: new Set(['a.html']),       // b.html excluded
      styleRulesIncluded: new Set([0, 1]),
      assetsIncluded: new Set(['img/a.png', 'img/b.png']),
      fontsIncluded: new Set<string>(),
      scriptsIncluded: new Set(['scripts/a.js', 'scripts/shared.js']),
    }
    const filtered = filterPlanBySelection(plan, sel)
    expect(filtered.pages).toHaveLength(1)
    expect(filtered.pages[0].source).toBe('a.html')
    expect(filtered.scripts.map((script) => ({ path: script.path, pageSources: script.pageSources }))).toEqual([
      { path: 'scripts/a.js', pageSources: ['a.html'] },
      { path: 'scripts/shared.js', pageSources: ['a.html'] },
    ])
  })

  it('removes deselected style rule by index', () => {
    const sel = {
      pagesIncluded: new Set(['a.html', 'b.html']),
      styleRulesIncluded: new Set([1]),           // rule 0 excluded
      assetsIncluded: new Set(['img/a.png', 'img/b.png']),
      fontsIncluded: new Set<string>(),
      scriptsIncluded: new Set(['scripts/a.js', 'scripts/shared.js']),
    }
    const filtered = filterPlanBySelection(plan, sel)
    expect(filtered.styleRules).toHaveLength(1)
    expect(filtered.styleRules[0].name).toBe('rule-1')
  })

  it('removes deselected asset', () => {
    const sel = {
      pagesIncluded: new Set(['a.html', 'b.html']),
      styleRulesIncluded: new Set([0, 1]),
      assetsIncluded: new Set(['img/a.png']),     // img/b.png excluded
      fontsIncluded: new Set<string>(),
      scriptsIncluded: new Set(['scripts/a.js', 'scripts/shared.js']),
    }
    const filtered = filterPlanBySelection(plan, sel)
    expect(filtered.assets).toHaveLength(1)
    expect(filtered.assets[0].sourcePath).toBe('img/a.png')
  })

  it('produces empty arrays when nothing is selected', () => {
    const sel = {
      pagesIncluded: new Set<string>(),
      styleRulesIncluded: new Set<number>(),
      assetsIncluded: new Set<string>(),
      fontsIncluded: new Set<string>(),
      scriptsIncluded: new Set<string>(),
    }
    const filtered = filterPlanBySelection(plan, sel)
    expect(filtered.pages).toHaveLength(0)
    expect(filtered.styleRules).toHaveLength(0)
    expect(filtered.assets).toHaveLength(0)
  })
})

describe('makeDefaultSelection — selects all items in the plan', () => {
  function makeDefaultSelection(plan: ImportPlan) {
    return {
      pagesIncluded: new Set(plan.pages.map((p) => p.source)),
      styleRulesIncluded: new Set(plan.styleRules.map((_, i) => i)),
      assetsIncluded: new Set(plan.assets.map((a) => a.sourcePath)),
      fontsIncluded: new Set(plan.fonts.map((f) => f.family)),
      scriptsIncluded: new Set(plan.scripts.map((s) => s.path)),
    }
  }

  it('selects all pages by source path', () => {
    const plan = makeMinimalPlan({
      pages: [
        { source: 'a.html', title: 'A', slug: 'a', linkedCssPaths: [], scripts: [], nodeFragment: { rootNodeId: 'r', nodes: {} } },
        { source: 'b.html', title: 'B', slug: 'b', linkedCssPaths: [], scripts: [], nodeFragment: { rootNodeId: 'r', nodes: {} } },
      ],
    })
    const sel = makeDefaultSelection(plan)
    expect(sel.pagesIncluded.has('a.html')).toBe(true)
    expect(sel.pagesIncluded.has('b.html')).toBe(true)
    expect(sel.pagesIncluded.size).toBe(2)
  })

  it('selects all style rules by index', () => {
    const plan = makeMinimalPlan({
      styleRules: [
        makeStyleRule({ name: 'hero' }),
        makeStyleRule({ name: 'footer' }),
        makeStyleRule({ name: 'nav' }),
      ],
    })
    const sel = makeDefaultSelection(plan)
    expect(sel.styleRulesIncluded.has(0)).toBe(true)
    expect(sel.styleRulesIncluded.has(1)).toBe(true)
    expect(sel.styleRulesIncluded.has(2)).toBe(true)
  })

  it('selects all assets by sourcePath', () => {
    const plan = makeMinimalPlan({
      assets: [
        { sourcePath: 'img/hero.png', mimeType: 'image/png', bytes: new Uint8Array() },
        { sourcePath: 'img/logo.svg', mimeType: 'image/svg+xml', bytes: new Uint8Array() },
      ],
    })
    const sel = makeDefaultSelection(plan)
    expect(sel.assetsIncluded.has('img/hero.png')).toBe(true)
    expect(sel.assetsIncluded.has('img/logo.svg')).toBe(true)
  })

  it('selects all scripts by source path', () => {
    const plan = makeMinimalPlan({
      scripts: [
        { path: 'scripts/vendor.js', content: '', format: 'classic', pageSources: ['a.html'], priority: 100 },
        { path: 'scripts/app.js', content: '', format: 'module', pageSources: ['a.html'], priority: 101 },
      ],
    })
    const sel = makeDefaultSelection(plan)
    expect(sel.scriptsIncluded.has('scripts/vendor.js')).toBe(true)
    expect(sel.scriptsIncluded.has('scripts/app.js')).toBe(true)
    expect(sel.scriptsIncluded.size).toBe(2)
  })

  it('produces empty sets for an empty plan', () => {
    const sel = makeDefaultSelection(makeMinimalPlan())
    expect(sel.pagesIncluded.size).toBe(0)
    expect(sel.styleRulesIncluded.size).toBe(0)
    expect(sel.assetsIncluded.size).toBe(0)
    expect(sel.fontsIncluded.size).toBe(0)
    expect(sel.scriptsIncluded.size).toBe(0)
  })
})

describe('describeIngestError — human-readable error messages', () => {
  // Inline the error classification logic matching SiteImportModal.tsx
  // so we can verify the correct messages without rendering the full modal.
  function formatByteLimit(bytes: number): string {
    const mb = Math.round(bytes / (1024 * 1024))
    if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024} GB`
    return `${mb} MB`
  }

  function describeIngestError(err: unknown): string {
    const { EmptyImportError, OversizeImportError, ZipBombError, TooManyFilesError, PathTraversalError } = require('@core/siteImport')
    if (err instanceof EmptyImportError) return 'No importable files found. Drop at least one HTML or CSS file.'
    if (err instanceof OversizeImportError) return `Import is too large (${Math.round((err as InstanceType<typeof OversizeImportError>).sizeBytes / 1024 / 1024)} MB). Maximum is ${formatByteLimit((err as InstanceType<typeof OversizeImportError>).limitBytes)}.`
    if (err instanceof ZipBombError) return 'ZIP archive is too large when uncompressed. Maximum uncompressed size is 5 GB.'
    if (err instanceof TooManyFilesError) return `Too many files (${(err as InstanceType<typeof TooManyFilesError>).count}). Maximum is ${(err as InstanceType<typeof TooManyFilesError>).limit}.`
    if (err instanceof PathTraversalError) return `Unsafe path detected: "${(err as InstanceType<typeof PathTraversalError>).path}".`
    return err instanceof Error ? err.message : 'Unknown import error'
  }

  it('EmptyImportError → "No importable files found…"', () => {
    const { EmptyImportError } = require('@core/siteImport')
    const err = new EmptyImportError()
    expect(describeIngestError(err)).toContain('No importable files found')
  })

  it('OversizeImportError → includes size in MB', () => {
    const { OversizeImportError } = require('@core/siteImport')
    const err = new OversizeImportError(250 * 1024 * 1024, 200 * 1024 * 1024)
    const msg = describeIngestError(err)
    expect(msg).toContain('250 MB')
    expect(msg).toContain('Maximum is 200 MB')
  })

  it('ZipBombError → "ZIP archive is too large when uncompressed"', () => {
    const { ZipBombError } = require('@core/siteImport')
    const err = new ZipBombError(6 * 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024)
    expect(describeIngestError(err)).toContain('ZIP archive is too large')
  })

  it('TooManyFilesError → includes count and limit', () => {
    const { TooManyFilesError } = require('@core/siteImport')
    const err = new TooManyFilesError(15000, 10000)
    const msg = describeIngestError(err)
    expect(msg).toContain('15000')
    expect(msg).toContain('10000')
  })

  it('PathTraversalError → includes unsafe path', () => {
    const { PathTraversalError } = require('@core/siteImport')
    const err = new PathTraversalError('../evil/file.html')
    const msg = describeIngestError(err)
    expect(msg).toContain('../evil/file.html')
  })

  it('generic Error → returns err.message', () => {
    expect(describeIngestError(new Error('boom'))).toBe('boom')
  })

  it('non-Error unknown → "Unknown import error"', () => {
    expect(describeIngestError(42)).toBe('Unknown import error')
  })
})

// ---------------------------------------------------------------------------
// 5 — ImportStep — running / complete / failed states from RunProgress
// ---------------------------------------------------------------------------

describe('ImportStep — progress + completion states', () => {
  afterEach(cleanup)

  /** A RunProgress in the complete state, reconciled to an ImportResult. */
  function makeDoneProgress(result: ImportResult): RunProgress {
    return {
      phase: 'done',
      currentItem: '',
      categories: {
        pages: { done: result.pages.length, total: result.pages.length },
        styles: { done: result.styleRules.length, total: result.styleRules.length },
        media: { done: result.assets.length, total: result.assets.length },
        colors: { done: result.colors.length, total: result.colors.length },
        fonts: {
          done: result.fonts.length + result.fontTokens.length,
          total: result.fonts.length + result.fontTokens.length,
        },
        scripts: { done: result.scripts.length, total: result.scripts.length },
      },
    }
  }

  function renderImportStep(progress: RunProgress, result: ImportResult | null, logOpen = false) {
    return render(
      <ImportStep
        progress={progress}
        siteName="My Site"
        result={result}
        droppedAtRules={0}
        logOpen={logOpen}
      />,
    )
  }

  it('complete state shows "Imported into <siteName>"', () => {
    const result = makeMinimalResult({
      pages: [{ id: 'p1', title: 'Home', slug: 'index', source: 'index.html' }],
    })
    renderImportStep(makeDoneProgress(result), result)
    expect(screen.getByText('Imported into My Site')).toBeDefined()
  })

  it('complete summary line reflects the result counts', () => {
    const result = makeMinimalResult({
      pages: [
        { id: 'p1', title: 'Home', slug: 'index', source: 'index.html' },
        { id: 'p2', title: 'About', slug: 'about', source: 'about.html' },
      ],
      styleRules: [
        { id: 'r1', selector: '.hero', kind: 'class' },
        { id: 'r2', selector: '.footer', kind: 'class' },
        { id: 'r3', selector: 'h1', kind: 'ambient' },
      ],
      assets: [{ sourcePath: 'images/hero.png', mediaUrl: '/uploads/hero.png' }],
    })
    renderImportStep(makeDoneProgress(result), result)
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim()
    const sub = Array.from(document.querySelectorAll('p')).find((p) =>
      normalize(p.textContent ?? '').includes('2 pages'),
    )
    expect(sub).not.toBeUndefined()
    expect(normalize(sub!.textContent ?? '')).toContain('3 rules')
    expect(normalize(sub!.textContent ?? '')).toContain('1 media')
  })

  it('import log (when open) lists per-category counts', () => {
    const result = makeMinimalResult({
      pages: [{ id: 'p1', title: 'Home', slug: 'index', source: 'index.html' }],
      assets: [{ sourcePath: 'images/hero.png', mediaUrl: '/uploads/hero.png' }],
    })
    renderImportStep(makeDoneProgress(result), result, true)
    expect(screen.getByText('1 page imported')).toBeDefined()
    expect(screen.getByText('1 asset uploaded')).toBeDefined()
  })

  it('import log (when open) renders warnings', () => {
    const result = makeMinimalResult({
      warnings: [{ kind: 'dropped-at-rule', message: 'Dropped @keyframes slideIn' }],
    })
    renderImportStep(makeDoneProgress(result), result, true)
    expect(screen.getByText('Dropped @keyframes slideIn')).toBeDefined()
  })

  it('running state shows a determinate percentage from media uploads', () => {
    const progress = makeInitialRunProgress()
    progress.phase = 'uploading'
    progress.categories.media = { done: 1, total: 2 }
    renderImportStep(progress, null)
    // 1/2 uploaded → 46% (½ of the 92% upload slice), rounded.
    expect(screen.getByText('46%')).toBeDefined()
  })

  it('running state renders every category row label', () => {
    const progress = makeInitialRunProgress()
    progress.phase = 'uploading'
    progress.categories.media = { done: 0, total: 3 }
    renderImportStep(progress, null)
    for (const label of ['Pages', 'Style rules', 'Media', 'Color tokens', 'Fonts', 'Scripts']) {
      expect(screen.getByText(label)).toBeDefined()
    }
  })

  it('category rows use diverse smart rail accents', () => {
    const progress = makeInitialRunProgress()
    progress.phase = 'uploading'
    progress.categories.media = { done: 0, total: 3 }
    renderImportStep(progress, null)

    const rows = ['pages', 'styles', 'media', 'colors', 'fonts', 'scripts'].map((id) =>
      screen.getByTestId(`site-import-category-${id}`),
    )
    const accents = rows.map((row) => row.getAttribute('data-accent'))
    expect(accents.every(Boolean)).toBe(true)
    expect(new Set(accents).size).toBe(rows.length)
  })

  it('failed state surfaces the error message via role="alert"', () => {
    const progress = makeInitialRunProgress()
    progress.phase = 'failed'
    progress.errorMessage = 'Commit failed: editor store rejected the mutation'
    renderImportStep(progress, null)
    const alert = document.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('Commit failed: editor store rejected the mutation')
  })
})

// ---------------------------------------------------------------------------
// 6 — ConflictsStep — shows / hides sections based on conflict lists
// ---------------------------------------------------------------------------

describe('ConflictsStep — conflict rendering', () => {
  afterEach(cleanup)

  const noopResChange = () => {}
  const emptyPageRes = new Map<string, ConflictResolution>()
  const emptyRuleRes = new Map<string, ConflictResolution>()

  it('returns null (renders nothing) when plan has no conflicts', () => {
    const plan = makeMinimalPlan()
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )
    expect(document.querySelector('h3')).toBeNull()
  })

  it('shows "Page slug conflicts" section when page conflicts exist', () => {
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'about.html',
            desiredSlug: 'about',
            existingPageId: 'p-1',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
        ],
        rules: [],
      },
    })
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )
    expect(screen.getByText(/Page slug conflicts/i)).toBeDefined()
  })

  it('shows "Class name conflicts" section when rule conflicts exist', () => {
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [],
        rules: [
          {
            source: 'styles/main.css',
            desiredName: 'hero-title',
            existingRuleId: 'r-1',
            defaultResolution: { action: 'auto-rename', resolvedName: 'hero-title-2' },
          },
        ],
      },
    })
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )
    expect(screen.getByText(/Class name conflicts/i)).toBeDefined()
  })

  it('shows both sections when both conflict types exist', () => {
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'about.html',
            desiredSlug: 'about',
            existingPageId: 'p-1',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
        ],
        rules: [
          {
            source: 'styles/main.css',
            desiredName: 'hero-title',
            existingRuleId: 'r-1',
            defaultResolution: { action: 'auto-rename', resolvedName: 'hero-title-2' },
          },
        ],
      },
    })
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )
    expect(screen.getByText(/Page slug conflicts/i)).toBeDefined()
    expect(screen.getByText(/Class name conflicts/i)).toBeDefined()
  })

  it('hides the "Overwrite" option for intra-batch page conflicts (empty existingPageId)', () => {
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'home.html',
            desiredSlug: 'home',
            existingPageId: '', // intra-batch collision — nothing to overwrite
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'home-2' },
          },
        ],
        rules: [],
      },
    })
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )
    const rowControls = within(screen.getByRole('group', { name: 'Conflict resolution for home.html' }))
    expect(rowControls.getByRole('button', { name: 'Rename' })).toBeDefined()
    expect(rowControls.getByRole('button', { name: 'Skip' })).toBeDefined()
    expect(rowControls.queryByRole('button', { name: 'Overwrite' })).toBeNull()
  })

  it('offers the "Overwrite" option when a real existing page id is present', () => {
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'about.html',
            desiredSlug: 'about',
            existingPageId: 'p-1',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
        ],
        rules: [],
      },
    })
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )
    const rowControls = within(screen.getByRole('group', { name: 'Conflict resolution for about.html' }))
    expect(rowControls.getByRole('button', { name: 'Overwrite' })).toBeDefined()
    expect(rowControls.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Rename',
      'Skip',
      'Overwrite',
      'Custom',
    ])
  })

  it('calls onPageResolutionChange when a row resolution changes', () => {
    const changes: [string, ConflictResolution][] = []
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'about.html',
            desiredSlug: 'about',
            existingPageId: 'p-1',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
        ],
        rules: [],
      },
    })
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={(source, res) => changes.push([source, res])}
        onRuleResolutionChange={noopResChange}
      />,
    )
    const rowControls = within(screen.getByRole('group', { name: 'Conflict resolution for about.html' }))
    fireEvent.click(rowControls.getByRole('button', { name: 'Overwrite' }))
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0][0]).toBe('about.html')
    expect(changes[0][1].action).toBe('overwrite')
  })

  it('marks the current row resolution as pressed in the segmented control', () => {
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [],
        rules: [
          {
            source: 'styles/main.css',
            desiredName: 'hero-title',
            existingRuleId: 'r-1',
            defaultResolution: { action: 'auto-rename', resolvedName: 'hero-title-2' },
          },
        ],
      },
    })
    const ruleRes = new Map<string, ConflictResolution>([
      ['hero-title', { action: 'skip' }],
    ])
    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={ruleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={noopResChange}
      />,
    )

    const rowControls = within(screen.getByRole('group', { name: 'Conflict resolution for hero-title' }))
    expect(rowControls.getByRole('button', { name: 'Skip' }).getAttribute('aria-pressed')).toBe('true')
    expect(rowControls.getByRole('button', { name: 'Rename' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('applies one resolution to every class conflict from the section controls', () => {
    const changes: [string, ConflictResolution][] = []
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [],
        rules: [
          {
            source: 'styles/auth.css',
            desiredName: 'auth-back',
            existingRuleId: 'r-auth',
            defaultResolution: { action: 'auto-rename', resolvedName: 'auth-back-2' },
          },
          {
            source: 'styles/form.css',
            desiredName: 'field',
            existingRuleId: 'r-field',
            defaultResolution: { action: 'auto-rename', resolvedName: 'field-2' },
          },
          {
            source: 'styles/form.css',
            desiredName: 'control',
            existingRuleId: 'r-control',
            defaultResolution: { action: 'auto-rename', resolvedName: 'control-2' },
          },
        ],
      },
    })

    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={noopResChange}
        onRuleResolutionChange={(desiredName, res) => changes.push([desiredName, res])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Skip all class name conflicts' }))

    expect(changes).toEqual([
      ['auth-back', { action: 'skip' }],
      ['field', { action: 'skip' }],
      ['control', { action: 'skip' }],
    ])
  })

  it('omits bulk overwrite for page conflicts when any page has no overwrite target', () => {
    const changes: [string, ConflictResolution][] = []
    const plan = makeMinimalPlan({
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'about.html',
            desiredSlug: 'about',
            existingPageId: 'p-about',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-2' },
          },
          {
            source: 'about-copy.html',
            desiredSlug: 'about',
            existingPageId: '',
            defaultResolution: { action: 'auto-rename', resolvedSlug: 'about-3' },
          },
        ],
        rules: [],
      },
    })

    render(
      <ConflictsStep
        plan={plan}
        pageResolutions={emptyPageRes}
        ruleResolutions={emptyRuleRes}
        onPageResolutionChange={(source, res) => changes.push([source, res])}
        onRuleResolutionChange={noopResChange}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Overwrite all page slug conflicts' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Skip all page slug conflicts' }))

    expect(changes).toEqual([
      ['about.html', { action: 'skip' }],
      ['about-copy.html', { action: 'skip' }],
    ])
  })
})

// ---------------------------------------------------------------------------
// 7 — AnalyzeStep MEDIA group: renders from plan.assets, not classifiedFiles
//
// Regression guard for the bug where anchor <a href="about.html"> caused
// HTML pages to appear in plan.assets (and therefore in the MEDIA section
// and the upload loop).  The MEDIA section must render exactly the entries
// in plan.assets — never derive its list from the FileMap by role.
// ---------------------------------------------------------------------------

describe('AnalyzeStep — MEDIA group renders from plan.assets only', () => {
  afterEach(cleanup)

  // Fixture: 3 pages, 17 style rules, 1 PNG asset, 1 dropped JS.
  // FileMap also contains the HTML and CSS sources so that the left-pane file
  // tree is populated — verifying that those files do NOT bleed into MEDIA.
  const assetEntry = {
    sourcePath: 'assets/logo.png',
    mimeType: 'image/png',
    bytes: new Uint8Array(),
  }

  const syntheticPlan = makeMinimalPlan({
    pages: [
      {
        source: 'index.html',
        title: 'Home',
        slug: 'index',
        linkedCssPaths: ['styles/main.css'],
        scripts: [{ kind: 'external', path: 'scripts/app.js', format: 'classic' }],
        nodeFragment: { nodes: {}, rootIds: [] },
      },
      {
        source: 'about.html',
        title: 'About',
        slug: 'about',
        linkedCssPaths: ['styles/main.css'],
        scripts: [],
        nodeFragment: { nodes: {}, rootIds: [] },
      },
      {
        source: 'pricing.html',
        title: 'Pricing',
        slug: 'pricing',
        linkedCssPaths: ['styles/main.css'],
        scripts: [],
        nodeFragment: { nodes: {}, rootIds: [] },
      },
    ],
    styleRules: Array.from({ length: 17 }, (_, i) =>
      makeStyleRule({ name: `rule-${i}`, selector: `.rule-${i}`, order: i }),
    ),
    assets: [assetEntry],
    scripts: [{
      path: 'scripts/app.js',
      content: '',
      format: 'classic',
      pageSources: ['index.html'],
      priority: 100,
    }],
  })

  const syntheticFileMap: FileMap = {
    files: {
      'index.html':       { bytes: new Uint8Array(), mimeType: 'text/html' },
      'about.html':       { bytes: new Uint8Array(), mimeType: 'text/html' },
      'pricing.html':     { bytes: new Uint8Array(), mimeType: 'text/html' },
      'styles/main.css':  { bytes: new Uint8Array(), mimeType: 'text/css' },
      'styles/theme.css': { bytes: new Uint8Array(), mimeType: 'text/css' },
      'assets/logo.png':  { bytes: new Uint8Array(), mimeType: 'image/png' },
      'scripts/app.js':   { bytes: new Uint8Array(), mimeType: 'application/javascript' },
    },
  }

  const syntheticSelection: ImportSelection = {
    pagesIncluded: new Set(['index.html', 'about.html', 'pricing.html']),
    styleRulesIncluded: new Set(Array.from({ length: 17 }, (_, i) => i)),
    assetsIncluded: new Set(['assets/logo.png']),
    fontsIncluded: new Set(),
    scriptsIncluded: new Set(),
    stylesheetsIncluded: new Set(),
  }

  // The navigator no longer needs the FileMap (it binds to the plan), but the
  // map is kept here to document that HTML/CSS sources must NOT leak into the
  // Media pane via plan.assets.
  void syntheticFileMap

  function renderAnalyzeStep() {
    return render(
      <AnalyzeStep
        plan={syntheticPlan}
        siteName="My Site"
        selection={syntheticSelection}
        pageSlugOverrides={new Map()}
        busy={false}
        onSelectionChange={() => {}}
        onStylesheetModeChange={() => {}}
        onAddFiles={() => {}}
        onSlugOverride={() => {}}
      />,
    )
  }

  /** Switch the detail pane to the Media category by clicking its nav item. */
  function openMediaPane() {
    fireEvent.click(screen.getByText('Media'))
  }

  it('Media nav item count reflects plan.assets length (1)', () => {
    renderAnalyzeStep()
    // The "Media" nav button renders its label + the total asset count.
    const mediaNav = screen.getByText('Media').closest('button')
    expect(mediaNav?.textContent).toContain('1')
  })

  it('review category nav uses diverse smart rail accents', () => {
    renderAnalyzeStep()

    const navItems = ['pages', 'styles', 'media', 'colors', 'fonts', 'scripts'].map((id) =>
      screen.getByTestId(`site-import-review-category-${id}`),
    )
    const accents = navItems.map((item) => item.getAttribute('data-accent'))
    expect(accents.every(Boolean)).toBe(true)
    expect(new Set(accents).size).toBe(navItems.length)
  })

  it('Media pane groups the PNG under an "Images" tile reading "1 file"', () => {
    renderAnalyzeStep()
    openMediaPane()
    expect(screen.getByText('Images')).toBeDefined()
    expect(screen.getByText('1 file')).toBeDefined()
  })

  it('does not surface HTML/CSS source MIME types anywhere — they are not assets', () => {
    renderAnalyzeStep()
    openMediaPane()
    // The Media pane is grouped by kind, not by raw MIME — and only plan.assets
    // feed it, so non-asset source types never appear.
    expect(screen.queryAllByText('text/html')).toHaveLength(0)
    expect(screen.queryAllByText('text/css')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 10 — commitImportPlan: uploadAsset called only for plan.assets entries
//
// Regression guard: given a plan with 3 HTML pages, 17 style rules, 1 PNG
// asset, and 1 linked JS file, the adapter's uploadAsset must be called exactly
// once — for the PNG — and must never receive any HTML or CSS source path.
// ---------------------------------------------------------------------------

describe('commitImportPlan — uploadAsset called only for entries in plan.assets', () => {
  it('calls uploadAsset exactly once with the image path, never with HTML or CSS', async () => {
    const plan = makeMinimalPlan({
      pages: [
        {
          source: 'index.html',
          title: 'Home',
          slug: 'index',
          linkedCssPaths: [],
          scripts: [{ kind: 'external', path: 'scripts/app.js', format: 'classic' }],
          nodeFragment: { nodes: {}, rootIds: [] },
        },
        {
          source: 'about.html',
          title: 'About',
          slug: 'about',
          linkedCssPaths: [],
          scripts: [],
          nodeFragment: { nodes: {}, rootIds: [] },
        },
        {
          source: 'pricing.html',
          title: 'Pricing',
          slug: 'pricing',
          linkedCssPaths: [],
          scripts: [],
          nodeFragment: { nodes: {}, rootIds: [] },
        },
      ],
      styleRules: Array.from({ length: 17 }, (_, i) =>
        makeStyleRule({ name: `rule-${i}`, selector: `.rule-${i}`, order: i }),
      ),
      assets: [
        // Exactly one uploadable asset — the PNG logo.
        { sourcePath: 'assets/logo.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50]) },
      ],
      scripts: [{
        path: 'scripts/app.js',
        content: '',
        format: 'classic',
        pageSources: ['index.html'],
        priority: 100,
      }],
    })

    const uploadedPaths: string[] = []
    const mockAdapter: SiteImportAdapter = {
      installGoogleFont: async (font) => ({
        id: `font-${font.family}`,
        source: 'google',
        family: font.family,
        variants: font.variants,
        subsets: font.subsets,
        files: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      uploadAsset: async ({ path }) => {
        uploadedPaths.push(path)
        return `/uploads/logo.png`
      },
      commit: async (recipe) => {
        recipe({
          addPage: (_input) => 'page-id',
          addStyleRule: (_rule) => 'rule-id',
          overwritePage: () => {},
          overwriteStyleRule: () => {},
          addConditions: () => {},
          addFonts: () => [],
          addInstalledFonts: () => [],
          addFontTokens: () => [],
          overwriteFontTokens: () => [],
          addColorTokens: () => [],
          overwriteColorTokens: () => [],
          addScripts: () => [],
        })
      },
    }

    await commitImportPlan(plan, mockAdapter)

    // Exactly one upload call — the PNG.
    expect(uploadedPaths).toHaveLength(1)
    expect(uploadedPaths[0]).toBe('assets/logo.png')

    // HTML and CSS source paths must never reach the upload endpoint.
    expect(uploadedPaths.includes('index.html')).toBe(false)
    expect(uploadedPaths.includes('about.html')).toBe(false)
    expect(uploadedPaths.includes('pricing.html')).toBe(false)
    expect(uploadedPaths.includes('styles/main.css')).toBe(false)
    expect(uploadedPaths.includes('styles/theme.css')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 11 — commitImportPlan: "overwrite" with no existing target falls back to add
//
// Regression guard for the "overwritePage: page not found" crash. An
// intra-batch slug collision carries an empty `existingPageId`; if the user
// picks "Overwrite" for it, commit must add a fresh page instead of calling
// overwritePage('') (which throws and aborts the whole import).
// ---------------------------------------------------------------------------

describe('commitImportPlan — overwrite with no existing target falls back to add', () => {
  function recordingAdapter() {
    const overwrotePageIds: string[] = []
    const addedPageIds: (string | undefined)[] = []
    const overwroteRuleIds: string[] = []
    const adapter: SiteImportAdapter = {
      installGoogleFont: async (font) => ({
        id: `font-${font.family}`,
        source: 'google',
        family: font.family,
        variants: font.variants,
        subsets: font.subsets,
        files: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      uploadAsset: async ({ path }) => `/uploads/${path}`,
      commit: async (recipe) => {
        recipe({
          addPage: (input) => {
            addedPageIds.push(input.id)
            return input.id ?? 'fresh-id'
          },
          addStyleRule: () => 'rule-id',
          overwritePage: (pageId) => {
            if (!pageId) throw new Error('overwritePage: page not found')
            overwrotePageIds.push(pageId)
          },
          overwriteStyleRule: (ruleId) => {
            if (!ruleId) throw new Error('overwriteStyleRule: style rule not found')
            overwroteRuleIds.push(ruleId)
          },
          addConditions: () => {},
          addFonts: () => [],
          addInstalledFonts: () => [],
          addFontTokens: () => [],
          overwriteFontTokens: () => [],
          addColorTokens: () => [],
          overwriteColorTokens: () => [],
          addScripts: () => [],
        })
      },
    }
    return { adapter, overwrotePageIds, addedPageIds, overwroteRuleIds }
  }

  it('does not throw and adds the page when overwrite target id is empty', async () => {
    const plan = makeMinimalPlan({
      pages: [
        {
          source: 'home.html',
          title: 'Home',
          slug: 'home',
          linkedCssPaths: [],
          scripts: [],
          nodeFragment: { nodes: {}, rootIds: [] },
        },
      ],
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        // Intra-batch collision → empty existingPageId, but user chose overwrite.
        pages: [
          {
            source: 'home.html',
            desiredSlug: 'home',
            existingPageId: '',
            defaultResolution: { action: 'overwrite' },
          },
        ],
        rules: [],
      },
    })

    const { adapter, overwrotePageIds, addedPageIds } = recordingAdapter()
    const result = await commitImportPlan(plan, adapter)

    // overwritePage('') was never called; the page was added instead.
    expect(overwrotePageIds).toHaveLength(0)
    expect(addedPageIds).toHaveLength(1)
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].slug).toBe('home')
  })

  it('still overwrites when a real existing page id is present', async () => {
    const plan = makeMinimalPlan({
      pages: [
        {
          source: 'home.html',
          title: 'Home',
          slug: 'home',
          linkedCssPaths: [],
          scripts: [],
          nodeFragment: { nodes: {}, rootIds: [] },
        },
      ],
      conflicts: {
        tokens: [],
        crossSheetClasses: [],
        pages: [
          {
            source: 'home.html',
            desiredSlug: 'home',
            existingPageId: 'existing-page-1',
            defaultResolution: { action: 'overwrite' },
          },
        ],
        rules: [],
      },
    })

    const { adapter, overwrotePageIds, addedPageIds } = recordingAdapter()
    await commitImportPlan(plan, adapter)

    expect(overwrotePageIds).toEqual(['existing-page-1'])
    expect(addedPageIds).toHaveLength(0)
  })
})
