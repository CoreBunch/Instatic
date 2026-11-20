/**
 * What a static site keeps through Site Import, checked on the published page:
 * sprite icons, authored attributes on form controls, head scripts, member
 * form wording, and links that stay links.
 *
 * Drives the real pipeline end to end: `buildImportPlan` → the editor store's
 * commit (`createSiteImportAdapter`) → the runtime build → `publishPage`.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import '@modules/base'
import { registry } from '@core/module-engine'
import { importHtml } from '@core/htmlImport'
import { applyConflictResolutions, buildImportPlan, commitImportPlan } from '@core/siteImport'
import type { FileMap, SiteImportAdapter } from '@core/siteImport'
import { publishPage } from '@core/publisher'
import { useEditorStore } from '@site/store/store'
import { createSiteImportAdapter } from '@admin/modals/SiteImport/shared/createSiteImportAdapter'
import { buildSiteRuntimeScripts } from '../../../server/publish/runtime/bundleScripts'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()

const SPRITE = '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor">'
  + '<symbol id="logo" viewBox="0 0 24 24"><path d="M1 1h22v22z"/></symbol>'
  + '<symbol id="arrow" viewBox="0 0 24 24"><use href="#logo"/></symbol>'
  + '</svg>'

const INDEX_HTML = `<!doctype html><html><head><title>Home</title>
<script src="shared/theme.js"></script>
<script src="shared/later.js" defer></script>
</head><body>
<a class="brand" href="/"><svg class="icon brand__mark" aria-hidden="true"><use href="shared/icons.svg#logo"/></svg>Home</a>
<svg class="icon"><use href="shared/icons.svg#arrow"/></svg>
<svg class="icon"><use href="shared/icons.svg#missing"/></svg>
<form method="post" action="/_instatic/members/login" data-instatic-form-mode="member">
  <label for="qty">Seats</label>
  <input id="qty" name="seats" type="number" inputmode="numeric" step="1" data-seat-input aria-describedby="qty-help">
  <p id="qty-help">Up to 50</p>
  <button class="btn" type="submit" data-busy-label="Saving">Save</button>
</form>
<a class="btn" href="#" data-open-drawer>Buy</a>
<a href="/pricing">Pricing</a>
<script src="shared/app.js"></script>
</body></html>`

function fileMap(): FileMap {
  const file = (text: string, mimeType: string) => ({ bytes: enc.encode(text), mimeType })
  return {
    files: {
      'index.html': file(INDEX_HTML, 'text/html'),
      'shared/icons.svg': file(SPRITE, 'image/svg+xml'),
      'shared/theme.js': file('document.documentElement.dataset.theme = "dark"', 'text/javascript'),
      'shared/later.js': file('window.later = 1', 'text/javascript'),
      'shared/app.js': file('window.app = 1', 'text/javascript'),
    },
  }
}

let html = ''
let warnings: ReturnType<typeof buildImportPlan>['warnings'] = []

beforeAll(async () => {
  useEditorStore.setState({ site: makeSite({ pages: [] }) } as Parameters<typeof useEditorStore.setState>[0])
  const plan = buildImportPlan({ fileMap: fileMap(), currentSite: useEditorStore.getState().site! })
  warnings = plan.warnings
  const resolved = applyConflictResolutions(
    plan,
    plan.conflicts.pages,
    plan.conflicts.rules,
    plan.conflicts.tokens,
    plan.conflicts.crossSheetClasses,
  )
  const adapter: SiteImportAdapter = {
    ...createSiteImportAdapter({ sessionId: 'import-fidelity-test' }),
    uploadAsset: async (asset) => {
      throw new Error(`no asset should upload, got ${asset.sourcePath}`)
    },
  }
  await commitImportPlan(resolved, adapter)

  const site = useEditorStore.getState().site!
  const page = site.pages.find((p) => p.slug === 'index' || p.slug === '')!
  const runtime = await buildSiteRuntimeScripts({
    site,
    page,
    target: 'publish',
    assetBasePath: '/_instatic/assets/runtime/',
  })
  expect(runtime.diagnostics).toEqual([])
  html = publishPage(page, site, registry, { runtimeAssets: runtime.runtimeAssets }).html
})

describe('Site Import keeps what the page needs to work', () => {
  it('copies sprite icons inline instead of publishing empty <svg>s', () => {
    expect(html).toContain('<path d="M1 1h22v22z"></path>')
    // The symbol's own box and the nested <use> inside the sprite both resolve.
    expect(html.match(/viewBox="0 0 24 24"/g)?.length).toBeGreaterThanOrEqual(3)
    expect(html).not.toContain('<use')
    expect(warnings).toContainEqual(expect.objectContaining({
      kind: 'missing-svg-sprite',
      path: 'shared/icons.svg#missing',
    }))
  })

  it('puts an SVG\'s classes on it once', () => {
    expect(html).toContain('class="icon brand__mark"')
    expect(html).not.toMatch(/class="[^"]*\bicon\b[^"]*\bicon\b/)
  })

  it('keeps authored attributes on form controls and the submit button', () => {
    const input = html.match(/<input[^>]*name="seats"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('inputmode="numeric"')
    expect(input).toContain('step="1"')
    expect(input).toContain('data-seat-input=""')
    expect(input).toContain('aria-describedby="qty-help"')
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*data-busy-label="Saving"/)
  })

  it('keeps a blocking head script in the head and the rest after the body', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    const body = html.slice(html.indexOf('<body'))
    expect(head).toMatch(/<script src="[^"]*theme[^"]*"/)
    expect(body).not.toContain('theme')
    expect(body).toMatch(/<script src="[^"]*later[^"]*"/)
    expect(body).toMatch(/<script src="[^"]*app[^"]*"/)
  })

  it('gives an imported member form its action\'s success wording', () => {
    expect(html).toContain('data-instatic-success-message="You are signed in."')
  })

  it('keeps a .btn anchor with href="#" as an <a> and adds no target="_self"', () => {
    expect(html).toContain('<a class="btn" data-open-drawer="" href="#">Buy</a>')
    expect(html).toContain('<a href="/pricing">Pricing</a>')
    expect(html).not.toContain('target="_self"')
  })
})

describe('importHtml sprite inlining', () => {
  it('resolves same-page sprite symbols without a loader', () => {
    const result = importHtml(
      '<svg hidden><symbol id="dot" viewBox="0 0 2 2"><circle r="1"/></symbol></svg>'
      + '<svg class="icon"><use href="#dot" width="2"/></svg>',
    )
    const icon = Object.values(result.nodes).find((n) => n.classIds?.includes('icon'))!
    expect(icon.props.svg).toBe('<svg><svg viewBox="0 0 2 2" width="2"><circle r="1"></circle></svg></svg>')
    expect(result.unresolvedSvgRefs).toEqual([])
  })

  it('reports a reference it cannot resolve and leaves it in place', () => {
    const result = importHtml('<svg><use href="sprite.svg#gone"/></svg>', { loadSvgSprite: () => null })
    expect(result.unresolvedSvgRefs).toEqual(['sprite.svg#gone'])
  })
})
