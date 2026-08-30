/**
 * Coverage for the multi-source render context + token interpolation
 * engine (Phases 1-3 of the binding system refactor).
 *
 * What we assert:
 *   - resolveDynamicProps dispatches on each source
 *     (page / site / route / currentEntry)
 *   - missing frames resolve to empty / static fallback
 *   - dotted field paths walk plain objects safely
 *   - parseTokenString round-trips text + tokens, including backslash escapes
 *   - interpolateTokens substitutes against the named frames
 *   - resolveDynamicProps applies tokens to string-typed props
 *
 * No publisher harness here — these are unit tests on the resolver
 * itself. End-to-end rendering is covered by dynamicRender.test.ts.
 */

import { describe, expect, it } from 'bun:test'
import { resolveDynamicProps, type TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import {
  containsTokens,
  interpolateTokens,
  parseTokenString,
} from '@core/templates/tokenInterpolation'
import {
  buildPageFrame,
  buildSiteFrame,
  buildRouteFrame,
} from '@core/templates/contextFrames'
import type { Page, SiteDocument } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ctx(overrides: Partial<TemplateRenderDataContext> = {}): TemplateRenderDataContext {
  const fakePage = {
    id: 'page_1',
    slug: 'about',
    title: 'About Us',
    template: undefined,
  } as unknown as Page
  const fakeSite = { id: 'site_1', name: 'Acme' } as SiteDocument

  return {
    entryStack: [],
    page: buildPageFrame(fakePage),
    site: buildSiteFrame(fakeSite),
    route: buildRouteFrame('/about'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// resolveDynamicProps — new sources
// ---------------------------------------------------------------------------

describe('resolveDynamicProps — system sources', () => {
  it('resolves page.title against the page frame', () => {
    const props = resolveDynamicProps(
      { text: 'Static fallback' },
      { text: { source: 'page', field: 'title' } },
      ctx(),
    )
    expect(props.text).toBe('About Us')
  })

  it('resolves site.name against the site frame', () => {
    const props = resolveDynamicProps(
      { text: 'Static' },
      { text: { source: 'site', field: 'name' } },
      ctx(),
    )
    expect(props.text).toBe('Acme')
  })

  it('resolves route.path against the route frame', () => {
    const props = resolveDynamicProps(
      { text: 'Static' },
      { text: { source: 'route', field: 'path' } },
      ctx(),
    )
    expect(props.text).toBe('/about')
  })

  it('resolves route.query tokens against the route frame', () => {
    const props = resolveDynamicProps(
      { text: 'Search: {route.query.q}' },
      undefined,
      ctx({ route: buildRouteFrame('/search?q=dynamic') }),
    )
    expect(props.text).toBe('Search: dynamic')
  })

  it('keeps the static fallback when currentEntry frame is missing and fallback is not set', () => {
    // Outside a loop, the entryStack is empty so `currentEntry.*` has no frame.
    const props = resolveDynamicProps(
      { text: 'Untitled' },
      { text: { source: 'currentEntry', field: 'title' } },
      ctx({ entryStack: [] }),
    )
    expect(props.text).toBe('Untitled')
  })

  it('substitutes empty when currentEntry frame is missing and fallback is empty', () => {
    const props = resolveDynamicProps(
      { text: 'Untitled' },
      { text: { source: 'currentEntry', field: 'title', fallback: 'empty' } },
      ctx({ entryStack: [] }),
    )
    expect(props.text).toBe('')
  })

  it('resolves currentEntry.title when an entry is on the stack', () => {
    const props = resolveDynamicProps(
      { text: 'Untitled' },
      { text: { source: 'currentEntry', field: 'title' } },
      ctx({
        entryStack: [{ id: 'r1', fields: { title: 'Hello world' } }],
      }),
    )
    expect(props.text).toBe('Hello world')
  })

  it('supports dotted field paths (no relation traversal, just plain object dive)', () => {
    // Synthetic frame with a nested object value to prove the walker.
    const props = resolveDynamicProps(
      { text: '-' },
      { text: { source: 'currentEntry', field: 'nested.deep' } },
      ctx({
        entryStack: [
          { id: 'r1', fields: { nested: { deep: 'OK' } } },
        ],
      }),
    )
    expect(props.text).toBe('OK')
  })

  it('does NOT walk through arrays for dotted paths (defensive — leaf semantics only)', () => {
    const props = resolveDynamicProps(
      { text: 'Static' },
      { text: { source: 'currentEntry', field: 'tags.0' } },
      ctx({
        entryStack: [
          { id: 'r1', fields: { tags: ['a', 'b'] } },
        ],
      }),
    )
    expect(props.text).toBe('Static')
  })
})

// ---------------------------------------------------------------------------
// Token interpolation engine
// ---------------------------------------------------------------------------

describe('containsTokens', () => {
  it('returns false for empty strings and plain text', () => {
    expect(containsTokens('')).toBe(false)
    expect(containsTokens('plain text')).toBe(false)
  })

  it('returns true when an unescaped { is present', () => {
    expect(containsTokens('Hello {site.name}')).toBe(true)
  })

  it('returns true even for escaped { (the parser resolves it to a literal)', () => {
    // Cheap check is conservative — an escaped `\{` still needs a parse so
    // the backslash is stripped; a false positive only costs one parse.
    expect(containsTokens('Literal \\{not-a-token}')).toBe(true)
  })
})

describe('parseTokenString', () => {
  it('parses pure text as a single text segment', () => {
    const segs = parseTokenString('just plain text')
    expect(segs).toEqual([{ kind: 'text', value: 'just plain text' }])
  })

  it('parses a single token surrounded by text', () => {
    const segs = parseTokenString('Hello {site.name}!')
    expect(segs).toEqual([
      { kind: 'text', value: 'Hello ' },
      { kind: 'token', source: 'site', field: 'name', raw: '{site.name}' },
      { kind: 'text', value: '!' },
    ])
  })

  it('honors backslash escape — \\{ emits a literal {', () => {
    const segs = parseTokenString('Literal \\{not-a-token}')
    expect(segs).toEqual([{ kind: 'text', value: 'Literal {not-a-token}' }])
  })

  it('emits malformed tokens verbatim (unknown source)', () => {
    const segs = parseTokenString('{unknown.field} stays as text')
    expect(segs[0]).toEqual({ kind: 'text', value: '{unknown.field} stays as text' })
  })

  it('handles unterminated { gracefully', () => {
    const segs = parseTokenString('Hello {site.name')
    expect(segs).toEqual([{ kind: 'text', value: 'Hello {site.name' }])
  })

  it('parses dotted field paths', () => {
    const segs = parseTokenString('{currentEntry.author.name}')
    expect(segs).toEqual([
      { kind: 'token', source: 'currentEntry', field: 'author.name', raw: '{currentEntry.author.name}' },
    ])
  })

  it('parses a fallback after the path with `|`', () => {
    const segs = parseTokenString('{site.name|My Site}')
    expect(segs).toEqual([
      {
        kind: 'token',
        source: 'site',
        field: 'name',
        fallback: 'My Site',
        raw: '{site.name|My Site}',
      },
    ])
  })

  it('preserves additional `|` characters inside the fallback verbatim', () => {
    const segs = parseTokenString('{currentEntry.title|Anonymous | Visitor}')
    expect(segs).toEqual([
      {
        kind: 'token',
        source: 'currentEntry',
        field: 'title',
        fallback: 'Anonymous | Visitor',
        raw: '{currentEntry.title|Anonymous | Visitor}',
      },
    ])
  })

  it('treats an empty fallback (`|` immediately before `}`) as an empty string fallback, not undefined', () => {
    const segs = parseTokenString('{site.name|}')
    expect(segs).toEqual([
      {
        kind: 'token',
        source: 'site',
        field: 'name',
        fallback: '',
        raw: '{site.name|}',
      },
    ])
  })
})

describe('interpolateTokens', () => {
  it('substitutes a single token', () => {
    const out = interpolateTokens('Hello {site.name}', ctx())
    expect(out).toBe('Hello Acme')
  })

  it('substitutes multiple tokens in one string', () => {
    const out = interpolateTokens('{site.name} — {page.title}', ctx())
    expect(out).toBe('Acme — About Us')
  })

  it('omits unknown values silently (empty substitution)', () => {
    const out = interpolateTokens('Before [{site.missing}] After', ctx())
    expect(out).toBe('Before [] After')
  })

  it('omits unresolved `currentEntry.*` outside a loop silently', () => {
    const out = interpolateTokens('Hi {currentEntry.title}!', ctx({ entryStack: [] }))
    expect(out).toBe('Hi !')
  })

  it('handles booleans and numbers via String()', () => {
    const c = ctx({
      entryStack: [{ id: 'r1', fields: { count: 42, isOn: true } }],
    })
    expect(interpolateTokens('count={currentEntry.count} on={currentEntry.isOn}', c)).toBe(
      'count=42 on=true',
    )
  })

  it('emits the fallback when the value is missing', () => {
    const c = ctx({ entryStack: [] })
    expect(interpolateTokens('Welcome, {currentEntry.title|guest}!', c)).toBe(
      'Welcome, guest!',
    )
  })

  it('emits the fallback when the value resolves to an empty string', () => {
    const c = ctx({
      entryStack: [{ id: 'r1', fields: { title: '' } }],
    })
    expect(interpolateTokens('{currentEntry.title|Untitled}', c)).toBe('Untitled')
  })

  it('prefers the real value over the fallback when present', () => {
    const c = ctx({
      entryStack: [{ id: 'r1', fields: { title: 'Hello' } }],
    })
    expect(interpolateTokens('{currentEntry.title|Untitled}', c)).toBe('Hello')
  })

  it('emits empty when the value is missing and there is no fallback', () => {
    const c = ctx({ entryStack: [] })
    expect(interpolateTokens('Welcome, {currentEntry.title}!', c)).toBe('Welcome, !')
  })

  it('strips the backslash of an escaped `\\{` and emits a literal `{`', () => {
    expect(interpolateTokens('Literal \\{not-a-token}', ctx())).toBe('Literal {not-a-token}')
  })

  it('strips the escape even when the string carries no real token', () => {
    expect(interpolateTokens('\\{just-braces}', ctx())).toBe('{just-braces}')
  })
})

// ---------------------------------------------------------------------------
// resolveDynamicProps — token interpolation applies to string props
// ---------------------------------------------------------------------------

describe('resolveDynamicProps — token interpolation', () => {
  it('substitutes tokens embedded in static string props', () => {
    const props = resolveDynamicProps(
      { text: 'Welcome to {site.name} — {page.title}!' },
      undefined,
      ctx(),
    )
    expect(props.text).toBe('Welcome to Acme — About Us!')
  })

  it('leaves non-string props untouched', () => {
    const props = resolveDynamicProps(
      { text: 'Hello {site.name}', count: 7 },
      undefined,
      ctx(),
    )
    expect(props.text).toBe('Hello Acme')
    expect(props.count).toBe(7)
  })

  it('skips strings that contain no tokens without allocating', () => {
    const input = { text: 'static text', label: 'No braces here' }
    const props = resolveDynamicProps(input, undefined, ctx())
    // Same reference back since no mutation happened.
    expect(props).toBe(input)
  })

  it('combines structured binding and token paths', () => {
    const props = resolveDynamicProps(
      {
        text: 'static fallback',
        // This prop value contains tokens AND has a structured binding —
        // the binding wins, then tokens apply to the result.
        heading: 'Welcome to {site.name}',
      },
      { text: { source: 'page', field: 'title' } },
      ctx(),
    )
    expect(props.text).toBe('About Us')
    expect(props.heading).toBe('Welcome to Acme')
  })
})

// ---------------------------------------------------------------------------
// Frame builders
// ---------------------------------------------------------------------------

describe('frame builders', () => {
  it('buildPageFrame derives permalink with index normalisation', () => {
    const home = buildPageFrame({ id: 'p_index', slug: '/index', title: 'Home' } as unknown as Page)
    expect(home.permalink).toBe('/')
    const inner = buildPageFrame({ id: 'p_about', slug: 'about', title: 'About' } as unknown as Page)
    expect(inner.permalink).toBe('/about')
  })

  it('buildRouteFrame derives slug and segments', () => {
    const route = buildRouteFrame('/posts/hello-world')
    expect(route.slug).toBe('hello-world')
    expect(route.segments).toEqual(['posts', 'hello-world'])
    expect(route.path).toBe('/posts/hello-world')
  })

  it('buildRouteFrame preserves query params for route.query bindings', () => {
    const route = buildRouteFrame('/search?q=dynamic&page=2')
    expect(route.query).toEqual({ q: 'dynamic', page: '2' })
  })

  it('buildRouteFrame handles a root URL', () => {
    const route = buildRouteFrame('/')
    expect(route.slug).toBe(null)
    expect(route.segments).toEqual([])
    expect(route.path).toBe('/')
  })
})

// ---------------------------------------------------------------------------
// Tokens inside htmlAttributes
// ---------------------------------------------------------------------------

describe('resolveDynamicProps — tokens in htmlAttributes', () => {
  const entry = { id: 'r1', fields: { 'video-link': 'https://cdn.example.com/hover.mp4', title: 'Peak' } }

  it('interpolates a token written on an author-set attribute', () => {
    // The case this exists for: a custom `<source>` tag whose `src` is bound
    // per loop item. `href` on a link already worked because it is a
    // first-class string prop; an attribute is one level down and was skipped,
    // so the token shipped to the browser as literal text.
    const props = resolveDynamicProps(
      { tag: 'custom', customTag: 'source', htmlAttributes: { src: '{currentEntry.video-link}' } },
      undefined,
      ctx({ entryStack: [entry] }),
    )
    expect(props.htmlAttributes).toEqual({ src: 'https://cdn.example.com/hover.mp4' })
  })

  it('leaves attributes without tokens untouched, and does not copy needlessly', () => {
    const staticProps = { htmlAttributes: { 'data-w-id': 'abc-123', loading: 'lazy' } }
    const props = resolveDynamicProps(staticProps, undefined, ctx({ entryStack: [entry] }))
    expect(props).toBe(staticProps)
  })

  it('interpolates only the attributes that carry tokens', () => {
    const props = resolveDynamicProps(
      { htmlAttributes: { src: '{currentEntry.video-link}', 'data-w-id': 'abc-123' } },
      undefined,
      ctx({ entryStack: [entry] }),
    )
    expect(props.htmlAttributes).toEqual({
      src: 'https://cdn.example.com/hover.mp4',
      'data-w-id': 'abc-123',
    })
  })

  it('does not mutate the caller’s props object', () => {
    const staticProps = { htmlAttributes: { src: '{currentEntry.video-link}' } }
    resolveDynamicProps(staticProps, undefined, ctx({ entryStack: [entry] }))
    expect(staticProps.htmlAttributes.src).toBe('{currentEntry.video-link}')
  })

  it('an unresolvable token becomes empty rather than shipping the literal', () => {
    const props = resolveDynamicProps(
      { htmlAttributes: { src: '{currentEntry.nope}' } },
      undefined,
      ctx({ entryStack: [entry] }),
    )
    expect(String((props.htmlAttributes as Record<string, string>).src)).not.toContain('{currentEntry')
  })

  it('never markdown-renders an attribute value', () => {
    // `isRichtextPropKey` must not reach attribute values — an attribute is a
    // value, not a body, and wrapping it in <p> would corrupt the URL.
    const props = resolveDynamicProps(
      { htmlAttributes: { html: '{currentEntry.title}' } },
      undefined,
      ctx({ entryStack: [entry] }),
    )
    expect((props.htmlAttributes as Record<string, string>).html).toBe('Peak')
  })

  it('ignores a malformed htmlAttributes bag instead of throwing', () => {
    const props = resolveDynamicProps(
      { htmlAttributes: { nested: { deep: 'x' } } as unknown as Record<string, string> },
      undefined,
      ctx({ entryStack: [entry] }),
    )
    expect(props.htmlAttributes).toEqual({ nested: { deep: 'x' } })
  })
})
