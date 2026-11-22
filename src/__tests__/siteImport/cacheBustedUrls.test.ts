/**
 * Cache-busted asset URLs (`site.css?v=8f3a1c`) resolve to the file they address.
 *
 * Static site generators routinely append a content hash or version to stylesheet, script and media URLs.
 * The FileMap is keyed by path, so a query has to be stripped before the lookup — otherwise the reference
 * resolves to a key that cannot exist and the import reports `missing-stylesheet` / `missing-script` while
 * the file is sitting in the archive.
 *
 * These are end-to-end over `buildImportPlan` rather than unit tests of the resolver, because the unit was
 * never the thing that broke: `resolveHref` returned a plausible-looking key and every consumer of it
 * dutifully failed to find that key. The defect was only visible as warnings and missing style rules.
 */
import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { buildImportPlan } from '@core/siteImport'
import type { FileMap } from '@core/siteImport'
import { makeEmptySiteDocument } from './mockSite'

const enc = new TextEncoder()
const txt = (s: string): Uint8Array => enc.encode(s)

const CSS = ':root{--brand:#0055ff}.hero{color:var(--brand);background:url(img/hero.png?v=9)}'

/** One page whose every local reference carries a cache-busting query. */
function cacheBustedSite(): FileMap {
  return {
    files: {
      'index.html': {
        bytes: txt(
          '<!doctype html><html><head>' +
            '<link rel="stylesheet" href="assets/site.css?v=8f3a1c">' +
            '<script src="assets/app.js?v=8f3a1c"></script>' +
            '</head><body>' +
            '<img src="assets/img/hero.png?v=9" alt="Hero">' +
            '<a href="about.html?utm_source=nav">About</a>' +
            '</body></html>',
        ),
        mimeType: 'text/html',
      },
      'about.html': { bytes: txt('<!doctype html><html><body><h1>About</h1></body></html>'), mimeType: 'text/html' },
      'assets/site.css': { bytes: txt(CSS), mimeType: 'text/css' },
      'assets/app.js': { bytes: txt('console.log("app")'), mimeType: 'application/javascript' },
      'assets/img/hero.png': { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png' },
    },
  }
}

/** The same site with every query removed — the control. */
function plainSite(): FileMap {
  const src = cacheBustedSite()
  const files: FileMap['files'] = {}
  for (const [k, v] of Object.entries(src.files)) {
    files[k] = k.endsWith('.html') || k.endsWith('.css')
      ? { ...v, bytes: txt(new TextDecoder().decode(v.bytes).replace(/\?(?:v=\w+|utm_source=nav)/g, '')) }
      : v
  }
  return { files }
}

describe('cache-busted asset URLs', () => {
  it('a stylesheet with ?v= is found, not reported missing', () => {
    const plan = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    const missing = plan.warnings.filter((w) => w.kind === 'missing-stylesheet')
    expect(missing).toHaveLength(0)
    // Select by source — page order is not part of this contract.
    const index = plan.pages.find((p) => p.source === 'index.html')!
    expect(index.linkedCssPaths).toContain('assets/site.css')
  })

  it('a script with ?v= is found, not reported missing', () => {
    const plan = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    expect(plan.warnings.filter((w) => w.kind === 'missing-script')).toHaveLength(0)
  })

  it('its style rules and root colour tokens are actually parsed', () => {
    // The user-visible cost of the bug: the sheet was skipped, so every rule and token in it was lost.
    const plan = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    expect(plan.styleRules.length).toBeGreaterThan(0)
    expect(plan.colors.some((c) => c.value.toLowerCase() === '#0055ff')).toBe(true)
  })

  it('a cache-busted image is queued as an asset', () => {
    const plan = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    expect(plan.assets.some((a) => a.sourcePath === "assets/img/hero.png")).toBe(true)
  })

  it('a cache-busted url() inside CSS resolves too', () => {
    const plan = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    expect(plan.warnings.filter((w) => w.kind === 'unresolved-asset')).toHaveLength(0)
  })

  it('produces the same plan as the identical site without query strings', () => {
    // The strongest statement available: cache-busting is addressing, not content, so it must make no
    // difference to the outcome at all.
    const busted = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    const plain = buildImportPlan({ fileMap: plainSite(), currentSite: makeEmptySiteDocument() })
    expect(busted.pages).toHaveLength(plain.pages.length)
    expect(busted.styleRules).toHaveLength(plain.styleRules.length)
    expect(busted.colors).toHaveLength(plain.colors.length)
    expect(busted.assets).toHaveLength(plain.assets.length)
    expect(busted.warnings).toHaveLength(plain.warnings.length)
  })

  it('an internal page link keeps working when it carries a query', () => {
    // linkRewrite used to strip the query itself before calling resolveHref. That strip now lives in
    // resolveHref, so this pins that the behaviour survived the move.
    const plan = buildImportPlan({ fileMap: cacheBustedSite(), currentSite: makeEmptySiteDocument() })
    expect(plan.pages.map((p) => p.slug).sort()).toEqual(['about', 'index'])
  })
})
