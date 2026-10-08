/**
 * buildPublishedSiteCssBundle — version-keyed memoisation of the page-invariant
 * CSS bundles (reset / framework). Authored CSS is page-scoped.
 *
 * The `framework` file is built by walking EVERY page's node tree to harvest
 * module CSS — work that scales with whole-site size, not the rendered page,
 * and is invariant across renders at the same publish version. These tests
 * prove:
 *
 *  (a) the expensive all-pages walk runs ONCE across many renders at the same
 *      publish version (the page-invariant files are reused by reference, and
 *      the module-metadata walk is not repeated);
 *  (b) `bumpPublishVersion()` invalidates the memo so a content change can never
 *      serve stale framework CSS;
 *  (c) the EMITTED CSS is byte-identical to the un-memoised `buildSiteCssBundle`
 *      — memoisation changes cost, never bytes;
 *  (d) `style` and `userStyles` are rebuilt per call, never memoised.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  buildSiteCssBundle,
  buildPublishedSiteCssBundle,
} from '../../../server/publish/siteCssBundle'
import {
  bumpPublishVersion,
  resetPublishStateForTests,
} from '../../../server/publish/publishState'
import { makeModule, makeRegistry, makePage, makeSite } from '../publisher/helpers'
import type { SiteDocument } from '@core/page-tree'

describe('buildPublishedSiteCssBundle — page-invariant memo', () => {
  let assetReads = 0
  const styledTextDef = makeModule('base.text', {
    assets: { css: 'h1 { color: black; }' },
    render: () => { throw new Error('Asset discovery must never invoke render') },
  })
  const registry = makeRegistry({ 'base.text': styledTextDef })
  const getDefinition = registry.get
  registry.get = (id) => { assetReads++; return getDefinition(id) }

  function makeMultiPageSite(): SiteDocument {
    const site = makeSite()
    site.pages = [
      makePage({ id: 'p1', root: { moduleId: 'base.text', props: { text: 'A' } } }),
      makePage({ id: 'p2', root: { moduleId: 'base.text', props: { text: 'B' } } }),
      makePage({ id: 'p3', root: { moduleId: 'base.text', props: { text: 'C' } } }),
    ]
    return site
  }

  beforeEach(() => {
    resetPublishStateForTests()
    assetReads = 0
  })

  it('runs the all-pages walk once across many renders at the same version', () => {
    const site = makeMultiPageSite()

    const first = buildPublishedSiteCssBundle(site, registry, site.pages[0])
    const callsAfterFirst = assetReads
    expect(callsAfterFirst).toBeGreaterThan(0)

    // Render the other two pages at the SAME publish version.
    buildPublishedSiteCssBundle(site, registry, site.pages[1])
    buildPublishedSiteCssBundle(site, registry, site.pages[2])

    // The expensive walk did not run again — the framework files came
    // from the memo, not a fresh O(all-pages) traversal.
    expect(assetReads).toBe(callsAfterFirst)

    // The page-invariant files are the very same objects (memo hit by reference).
    const second = buildPublishedSiteCssBundle(site, registry, site.pages[1])
    expect(second.reset).toBe(first.reset)
    expect(second.framework).toBe(first.framework)
    expect(second.style).not.toBe(first.style)
  })

  it('rebuilds both authored layers per call — never memoised (page-scoped)', () => {
    const site = makeMultiPageSite()
    const a = buildPublishedSiteCssBundle(site, registry, site.pages[0])
    const b = buildPublishedSiteCssBundle(site, registry, site.pages[1])
    // Fresh object each call (page-scoped), even though these fixture pages
    // carry no user stylesheets so the content/hash coincide.
    expect(b.userStyles).not.toBe(a.userStyles)
    expect(b.style).not.toBe(a.style)
  })

  it('recomputes after bumpPublishVersion (no stale CSS after publish)', () => {
    const site = makeMultiPageSite()

    const before = buildPublishedSiteCssBundle(site, registry, site.pages[0])
    const callsAfterFirst = assetReads

    bumpPublishVersion()

    const after = buildPublishedSiteCssBundle(site, registry, site.pages[0])
    // The walk ran again for the new version — the memo was invalidated.
    expect(assetReads).toBeGreaterThan(callsAfterFirst)
    // New file objects (recomputed, not the stale cached ones).
    expect(after.framework).not.toBe(before.framework)
    expect(after.style).not.toBe(before.style)
  })

  it('memo key is the publish version ALONE — a different site object at the same version reuses it', () => {
    // Every consumer loads the published snapshot fresh from the DB (a new
    // JSON-parsed object per query), so a site-identity key would never hit.
    // Published content is fixed per version (every snapshot writer bumps), so
    // the version alone is a sound key — and two distinct site objects at the
    // same version must share one walk.
    const firstSite = makeMultiPageSite()
    const secondSite = makeMultiPageSite()

    const first = buildPublishedSiteCssBundle(firstSite, registry, firstSite.pages[0])
    const callsAfterFirstSite = assetReads

    const second = buildPublishedSiteCssBundle(secondSite, registry, secondSite.pages[0])

    expect(assetReads).toBe(callsAfterFirstSite)
    expect(second.framework).toBe(first.framework)
    expect(second.style).not.toBe(first.style)
  })

  it('an explicit publishVersion argument (publish-time bake) gets its own memo slot', () => {
    // The bake renders the NEXT version's content before bumpPublishVersion()
    // runs, passing `nextPublishVersion` explicitly — it must not be served the
    // current version's cached bundles.
    const site = makeMultiPageSite()

    const current = buildPublishedSiteCssBundle(site, registry, site.pages[0])
    const callsAfterCurrent = assetReads

    const next = buildPublishedSiteCssBundle(site, registry, site.pages[0], 1)
    expect(assetReads).toBeGreaterThan(callsAfterCurrent)
    expect(next.framework).not.toBe(current.framework)
  })

  it('emits byte-identical CSS to the un-memoised builder', () => {
    const site = makeMultiPageSite()
    const page = site.pages[0]

    const plain = buildSiteCssBundle(site, registry, page)
    const memoised = buildPublishedSiteCssBundle(site, registry, page)

    for (const id of ['reset', 'framework', 'style', 'userStyles'] as const) {
      expect(memoised[id].content).toBe(plain[id].content)
      expect(memoised[id].hash).toBe(plain[id].hash)
      expect(memoised[id].filename).toBe(plain[id].filename)
    }
  })

  it('serves identical bytes from the memo as a fresh build at the same version', () => {
    const site = makeMultiPageSite()
    const page = site.pages[0]

    // Snapshot a representative page's bundle, then read it back from the memo.
    const fresh = buildPublishedSiteCssBundle(site, registry, page)
    const cached = buildPublishedSiteCssBundle(site, registry, page)

    expect(cached.framework.content).toBe(fresh.framework.content)
    expect(cached.style.content).toBe(fresh.style.content)
    expect(cached.reset.content).toBe(fresh.reset.content)
  })
})
