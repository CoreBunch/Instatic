/**
 * CSP-as-data model (`src/core/publisher/cspPlan.ts`) + end-to-end determinism
 * through the frontend-injection pipeline.
 *
 * The bug this fleet locks in: the published-page CSP used to be regex-rewritten
 * in two passes (plugin relaxation + media origins), serializing source sets
 * from JS `Set`s whose order depended on which pass ran first — so the SAME
 * plugins + adapters could emit DIFFERENT CSP strings across runs, breaking
 * content-hashing. The plan models the CSP as data and `serializeCsp` sorts
 * directives + sources, so identical inputs always yield a byte-identical CSP.
 */
import { describe, it, expect } from 'bun:test'
import {
  addCspSources,
  createBaseCspPlan,
  cspMetaTag,
  parseCspContent,
  publishPage,
  serializeCsp,
  setCspDirective,
} from '@core/publisher'
import type { AnyModuleDefinition } from '@core/module-engine'
import {
  injectFrontendAssets,
  type FrontendInjections,
} from '../../../server/publish/frontendInjections'
import { VideoModule } from '@modules/base/video'
import { GoogleMapModule } from '@modules/base/googleMap'
import { ContainerModule } from '@modules/base/container'
import { BodyModule } from '@modules/base/body'
import { makeModule, makeRegistry, makePage, makeSite } from './helpers'

describe('CspPlan — serialization is deterministic and sorted', () => {
  it('sorts directives by name and sources within each directive', () => {
    const plan = createBaseCspPlan({ anyScriptTag: false })
    const csp = serializeCsp(plan)
    // Directives alphabetical: default-src < frame-src < img-src < media-src
    //   < script-src < style-src < worker-src
    expect(csp).toBe(
      "default-src 'self'; frame-src 'none'; img-src 'self' data: https:; " +
        "media-src 'self' data: https:; " +
        "script-src 'none'; style-src 'self' 'unsafe-inline'; worker-src 'none';",
    )
  })

  it('lets a cross-origin video load, exactly like a cross-origin image', () => {
    // Without an explicit `media-src` the browser falls back to
    // `default-src 'self'` and blocks every remote `<video>`/`<audio>` — a
    // page could show a remote image but never play a remote video. The
    // element and URL are both correct, so the only symptom is silence.
    const csp = serializeCsp(createBaseCspPlan({ anyScriptTag: true }))
    expect(csp).toContain("media-src 'self' data: https:;")
    const img = /img-src ([^;]+);/.exec(csp)?.[1]
    const media = /media-src ([^;]+);/.exec(csp)?.[1]
    expect(media).toBe(img)
  })

  it('produces a byte-identical policy regardless of source insertion order', () => {
    const a = createBaseCspPlan({ anyScriptTag: true, importmapSha: 'ABC123' })
    const b = createBaseCspPlan({ anyScriptTag: true, importmapSha: 'ABC123' })
    // Add the same sources in opposite orders.
    addCspSources(a, 'connect-src', ['https://b.example', 'https://a.example'])
    addCspSources(b, 'connect-src', ['https://a.example', 'https://b.example'])
    expect(serializeCsp(a)).toBe(serializeCsp(b))
  })

  it('addCspSources drops `\'none\'` when a real source is unioned in', () => {
    const plan = createBaseCspPlan({ anyScriptTag: false }) // script-src 'none'
    addCspSources(plan, 'script-src', ["'self'"])
    expect(serializeCsp(plan)).toContain("script-src 'self';")
    expect(serializeCsp(plan)).not.toContain("'none' 'self'")
  })

  it('setCspDirective replaces the source list outright', () => {
    const plan = createBaseCspPlan({ anyScriptTag: true, importmapSha: 'XYZ' })
    setCspDirective(plan, 'script-src', ["'self'"])
    expect(serializeCsp(plan)).toContain("script-src 'self';")
    expect(serializeCsp(plan)).not.toContain('XYZ')
  })

  it('parseCspContent round-trips through serializeCsp (sorted)', () => {
    const content = "default-src 'self'; script-src 'none'; img-src 'self' data:;"
    const plan = parseCspContent(content)
    expect(serializeCsp(plan)).toBe(
      "default-src 'self'; img-src 'self' data:; script-src 'none';",
    )
  })

  it('cspMetaTag matches the CSP_META_PATTERN the pipeline rewrites', () => {
    const plan = createBaseCspPlan({ anyScriptTag: false })
    const tag = cspMetaTag(plan)
    expect(tag).toMatch(
      /<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i,
    )
  })
})

// ---------------------------------------------------------------------------
// End-to-end: the same plugins + adapters yield a byte-identical CSP across
// repeated builds, and the order of mediaCspOrigins / networkAllowedHosts in
// the plan does not affect the output.
// ---------------------------------------------------------------------------

const PAGE_WITH_CSP = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'none'; worker-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src 'none';">
</head>
<body></body>
</html>`

function extractCsp(html: string): string {
  const m = html.match(/content="([^"]*)"/)
  if (!m) throw new Error('no CSP meta found')
  return m[1]!
}

function planWith(overrides: Partial<FrontendInjections>): FrontendInjections {
  return {
    tags: { head: [], 'head-end': [], 'body-start': [], 'body-end': [] },
    hasInlineScript: false,
    hasExternalScript: false,
    hasInlineStyle: false,
    networkAllowedHosts: [],
    mediaCspOrigins: [],
    cspSources: [],
    ...overrides,
  }
}

describe('frontend injection — CSP determinism', () => {
  it('repeated builds with the same plugins + adapters produce byte-identical CSP', () => {
    const make = (): FrontendInjections =>
      planWith({
        hasExternalScript: true,
        tags: {
          head: [],
          'head-end': [],
          'body-start': [],
          'body-end': ['<script src="/uploads/plugins/acme/1.0.0/t.js" defer></script>'],
        },
        networkAllowedHosts: ['api.acme.com', 'cdn.acme.com'],
        mediaCspOrigins: [
          { directive: 'img-src', origin: 'cdn.images.example' },
          { directive: 'connect-src', origin: 'api.media.example' },
        ],
      })

    const first = extractCsp(injectFrontendAssets(PAGE_WITH_CSP, make()))
    const second = extractCsp(injectFrontendAssets(PAGE_WITH_CSP, make()))
    expect(first).toBe(second)
  })

  it('is insensitive to mediaCspOrigins / networkAllowedHosts ordering', () => {
    const a = planWith({
      hasExternalScript: true,
      tags: { head: [], 'head-end': [], 'body-start': [], 'body-end': ['<script src="/x/a.js"></script>'] },
      networkAllowedHosts: ['z.example', 'a.example'],
      mediaCspOrigins: [
        { directive: 'connect-src', origin: 'm2.example' },
        { directive: 'img-src', origin: 'm1.example' },
      ],
    })
    const b = planWith({
      hasExternalScript: true,
      tags: { head: [], 'head-end': [], 'body-start': [], 'body-end': ['<script src="/x/a.js"></script>'] },
      networkAllowedHosts: ['a.example', 'z.example'],
      mediaCspOrigins: [
        { directive: 'img-src', origin: 'm1.example' },
        { directive: 'connect-src', origin: 'm2.example' },
      ],
    })
    expect(extractCsp(injectFrontendAssets(PAGE_WITH_CSP, a))).toBe(
      extractCsp(injectFrontendAssets(PAGE_WITH_CSP, b)),
    )
  })

  it('every directive and its sources are sorted in the emitted CSP', () => {
    const plan = planWith({
      hasExternalScript: true,
      tags: { head: [], 'head-end': [], 'body-start': [], 'body-end': ['<script src="/x/a.js"></script>'] },
      networkAllowedHosts: ['z.example', 'a.example'],
      mediaCspOrigins: [{ directive: 'media-src', origin: 'stream.example' }],
    })
    const csp = extractCsp(injectFrontendAssets(PAGE_WITH_CSP, plan))
    const directives = csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
    const names = directives.map((d) => d.split(/\s+/)[0]!)
    expect(names).toEqual([...names].sort())
    for (const directive of directives) {
      const sources = directive.split(/\s+/).slice(1)
      expect(sources).toEqual([...sources].sort())
    }
  })
})

// ---------------------------------------------------------------------------
// publishPage — CSP frame-src lifted by module cspSources
//
// Locks in the fix for the pre-existing publisher gap where frame-src was
// hardcoded to 'none', blocking YouTube embeds on published pages even though
// they rendered correctly in the editor canvas.
// ---------------------------------------------------------------------------

/** Extract the CSP policy string from a full publishPage HTML document. */
function extractPublishedCsp(html: string): string {
  const m = html.match(/<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i)
  if (!m) throw new Error('no CSP meta found in published HTML')
  return m[1]!
}

describe('publishPage — CSP frame-src from module cspSources', () => {
  it('page with a youtube video has youtube.com in frame-src (not none)', () => {
    const page = makePage({
      root: {
        moduleId: 'base.video',
        props: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      },
    })
    const reg = makeRegistry({ 'base.video': VideoModule as AnyModuleDefinition })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(csp).toContain('https://www.youtube.com')
    expect(csp).toContain('https://www.youtube-nocookie.com')
    expect(csp).not.toContain("frame-src 'none'")
  })

  it('page with no video keeps frame-src none (no youtube leakage)', () => {
    const page = makePage({
      root: { moduleId: 'test.plain', props: {} },
    })
    const reg = makeRegistry({ 'test.plain': makeModule('test.plain') })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(csp).toContain("frame-src 'none'")
    expect(csp).not.toContain('youtube')
  })

  it('page with an official Google Maps embed permits only www.google.com in frame-src', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['map'] },
      map: {
        moduleId: 'base.google-map',
        props: {
          embedUrl: 'https://www.google.com/maps/embed?pb=official',
          title: 'Bernie’s Heating and A/C Service location on Google Maps',
        },
      },
    })
    const reg = makeRegistry({
      'base.body': BodyModule as AnyModuleDefinition,
      'base.google-map': GoogleMapModule as AnyModuleDefinition,
    })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"')
    expect(csp).toContain('frame-src https://www.google.com;')
    expect(csp).not.toContain("frame-src 'none'")
  })

  it('does not relax frame-src for a Google Maps URL outside the exact allowed origin', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['map'] },
      map: {
        moduleId: 'base.google-map',
        props: {
          embedUrl: 'https://google.com/maps/embed?pb=not-allowed',
          title: 'Map',
        },
      },
    })
    const reg = makeRegistry({
      'base.body': BodyModule as AnyModuleDefinition,
      'base.google-map': GoogleMapModule as AnyModuleDefinition,
    })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(html).not.toContain('<iframe')
    expect(csp).toContain("frame-src 'none'")
  })

  it('keeps legacy custom-iframe containers working for the exact Google Maps embed origin', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['map'] },
      map: {
        moduleId: 'base.container',
        props: {
          tag: 'custom',
          customTag: 'iframe',
          htmlAttributes: {
            src: 'https://www.google.com/maps/embed?pb=legacy',
            title: 'Bernie’s Heating and A/C Service on Google Maps',
          },
        },
      },
    })
    const reg = makeRegistry({
      'base.body': BodyModule as AnyModuleDefinition,
      'base.container': ContainerModule as AnyModuleDefinition,
    })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(html).toContain('<iframe')
    expect(csp).toContain('frame-src https://www.google.com;')
    expect(csp).not.toContain("frame-src 'none'")
  })

  it('repairs sanitized legacy map divs without requiring a page re-import', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['map'] },
      map: {
        moduleId: 'base.container',
        props: {
          tag: 'div',
          customTag: '',
          htmlAttributes: {
            src: 'https://www.google.com/maps/embed?pb=sanitized-legacy',
            title: 'Bernie’s Heating and A/C Service on Google Maps',
          },
        },
      },
    })
    const reg = makeRegistry({
      'base.body': BodyModule as AnyModuleDefinition,
      'base.container': ContainerModule as AnyModuleDefinition,
    })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(html).toContain('<iframe')
    expect(html).not.toContain('<div src="https://www.google.com/maps/embed')
    expect(csp).toContain('frame-src https://www.google.com;')
    expect(csp).not.toContain("frame-src 'none'")
  })

  it('does not widen CSP for other legacy custom-iframe container origins', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['map'] },
      map: {
        moduleId: 'base.container',
        props: {
          tag: 'custom',
          customTag: 'iframe',
          htmlAttributes: {
            src: 'https://example.com/embed',
            title: 'Untrusted embed',
          },
        },
      },
    })
    const reg = makeRegistry({
      'base.body': BodyModule as AnyModuleDefinition,
      'base.container': ContainerModule as AnyModuleDefinition,
    })
    const { html } = publishPage(page, makeSite(), reg)
    expect(extractPublishedCsp(html)).toContain("frame-src 'none'")
  })

  it('youtube sources are sorted deterministically across repeated builds', () => {
    const page = makePage({
      root: {
        moduleId: 'base.video',
        props: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      },
    })
    const reg = makeRegistry({ 'base.video': VideoModule as AnyModuleDefinition })
    const html1 = publishPage(page, makeSite(), reg).html
    const html2 = publishPage(page, makeSite(), reg).html
    expect(extractPublishedCsp(html1)).toBe(extractPublishedCsp(html2))
    expect(extractPublishedCsp(html1)).not.toBe('')
  })

  it('frame-src contains both youtube.com and youtube-nocookie.com for the youtu.be URL form', () => {
    const page = makePage({
      root: {
        moduleId: 'base.video',
        props: { videoUrl: 'https://youtu.be/dQw4w9WgXcQ' },
      },
    })
    const reg = makeRegistry({ 'base.video': VideoModule as AnyModuleDefinition })
    const { html } = publishPage(page, makeSite(), reg)
    const csp = extractPublishedCsp(html)
    expect(csp).toContain('https://www.youtube-nocookie.com')
  })
})
