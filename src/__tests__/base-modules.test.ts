/**
 * Base Module Conformance Tests
 *
 * Runs the Module Conformance Suite against every base module.
 * If any base module fails the conformance suite, it cannot be merged (Guidelines #172).
 *
 * How to add a new base module to this suite:
 *   1. Import the module definition
 *   2. Call: runModuleConformanceSuite(MyModule)
 *
 * Additional module-specific tests (unique behaviour, edge cases) go below
 * the conformance suite calls in dedicated describe blocks.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync } from 'fs'
import React from 'react'
import { render as renderReact } from '@testing-library/react'
import './matchers'  // Register toBeCleanHTML

import { runModuleConformanceSuite, renderModule, withBannedGlobals } from './helpers'
import { escapeProps } from '@core/publisher'

// ---------------------------------------------------------------------------
// Import base modules (self-register into global registry on import)
// ---------------------------------------------------------------------------

// Module bootstrap files are `.ts` (no JSX) — editor components live in
// sibling `*Editor.tsx` files so React Fast Refresh can hot-patch them
// without re-running registry.registerOrReplace().
import { TextModule } from '@modules/base/text'
import { ButtonModule } from '@modules/base/button'
import { ContainerModule } from '@modules/base/container'
import { ImageModule } from '@modules/base/image'
import { VideoModule } from '@modules/base/video'
import { ListModule } from '@modules/base/list'
import { LinkModule } from '@modules/base/link'
import { BodyModule } from '@modules/base/body'
import { VisualComponentRefModule } from '@modules/base/visualComponentRef'
import { SlotOutletModule } from '@modules/base/slotOutlet'

// ---------------------------------------------------------------------------
// Run the full conformance suite for every canonical base module (7 total)
// Context #338 — Canonical Base Module List
// ---------------------------------------------------------------------------

runModuleConformanceSuite(TextModule)
runModuleConformanceSuite(ButtonModule)
runModuleConformanceSuite(ContainerModule)
runModuleConformanceSuite(ImageModule)
runModuleConformanceSuite(VideoModule)
runModuleConformanceSuite(ListModule)
runModuleConformanceSuite(LinkModule)
runModuleConformanceSuite(VisualComponentRefModule)
runModuleConformanceSuite(SlotOutletModule)

describe('base module registration', () => {
  it('only imports available production base modules', async () => {
    const baseIndex = await Bun.file('src/modules/base/index.ts').text()

    expect(baseIndex).not.toContain("import './columns'")
    expect(baseIndex).not.toContain("import './spacer'")
    expect(baseIndex).not.toContain("import './divider'")
    expect(baseIndex).not.toContain("import './demoCard'")
    expect(baseIndex).not.toContain("import './demoScene'")
    expect(baseIndex).not.toContain("import './heading'")
    expect(baseIndex).not.toContain("import './paragraph'")

    // Component system modules — registered and shipped
    expect(baseIndex).toContain("import './visualComponentRef'")
    expect(baseIndex).toContain("import './slotOutlet'")
  })

  it('does not keep retired module directories around', () => {
    for (const retiredPath of [
      'src/modules/base/columns',
      'src/modules/base/spacer',
      'src/modules/base/divider',
      'src/modules/base/demoCard',
      'src/modules/base/demoScene',
      'src/modules/base/heading',
      'src/modules/base/paragraph',
    ]) {
      expect(existsSync(retiredPath)).toBe(false)
    }
  })

  it('keeps visual styling out of all base module schemas', () => {
    // All base module settings should be content/structural, not visual/CSS.
    // Visual styling is handled via class assignment and the CSS editor.
    for (const mod of [
      BodyModule,
      ContainerModule,
      TextModule,
      ListModule,
      ImageModule,
      VideoModule,
      ButtonModule,
      LinkModule,
      VisualComponentRefModule,
      SlotOutletModule,
    ]) {
      // No module should declare CSS-only props as module schema fields.
      const cssOnlyPropNames = ['backgroundColor', 'color', 'fontSize', 'padding', 'margin', 'border']
      for (const propName of cssOnlyPropNames) {
        expect(Object.keys(mod.schema)).not.toContain(propName)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// base.text — unified text module replacement
// ---------------------------------------------------------------------------

describe('base.text — unified text module', () => {
  it('is the only registered base typography module', async () => {
    const baseIndex = await Bun.file('src/modules/base/index.ts').text()

    expect(baseIndex).toContain("import './text'")
    expect(baseIndex).not.toContain("import './heading'")
    expect(baseIndex).not.toContain("import './paragraph'")
  })

  it('has only content, tag, and HTML attribute module settings', async () => {
    expect(TextModule.id).toBe('base.text')
    expect(Object.keys(TextModule.schema).sort()).toEqual(['htmlAttributes', 'tag', 'text'])
  })

  it('renders the selected semantic tag', async () => {
    for (const tag of ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      const { html } = renderModule(TextModule, { tag, text: 'Test' })
      expect(html).toContain(`<${tag}`)
      expect(html).toContain(`</${tag}>`)
    }
  })

  it('renders an authored HTML id', () => {
    const { html } = renderModule(TextModule, {
      tag: 'p',
      text: 'Test',
      htmlAttributes: { id: 'intro-copy' },
    })
    expect(html).toContain('<p id="intro-copy">Test</p>')
  })

  it('renders authored HTML attributes', () => {
    const { html } = renderModule(TextModule, {
      tag: 'span',
      text: 'Test',
      htmlAttributes: {
        'aria-label': 'Intro',
        class: 'skip',
        'data-aos': 'fade-up',
        'data-instatic-node': 'skip',
        onclick: 'alert(1)',
        role: 'note',
      },
    })
    expect(html).toContain(' aria-label="Intro"')
    expect(html).toContain(' data-aos="fade-up"')
    expect(html).toContain(' role="note"')
    expect(html).not.toContain('class="skip"')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('data-instatic-node')
  })

  it('escapes text content through the publisher pipeline', async () => {
    const safeProps = escapeProps({ ...TextModule.defaults, text: '<script>xss()</script>' }, TextModule.schema)
    const { html } = TextModule.render(safeProps, [])

    expect(html).toBeCleanHTML()
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// base.button — module-specific tests
// ---------------------------------------------------------------------------

describe('base.button — render() specifics', () => {
  it('has only content and behavior module settings', () => {
    expect(Object.keys(ButtonModule.schema).sort()).toEqual(['disabled', 'href', 'htmlAttributes', 'label', 'target'])
  })

  it('renders an <a> element when href is set', () => {
    const { html } = renderModule(ButtonModule, { href: 'https://example.com' })
    expect(html).toMatch(/<a[\s>]/)
    expect(html).toContain('href="https://example.com"')
  })

  it('renders a <button> element when href is empty', () => {
    const { html } = renderModule(ButtonModule, { href: '' })
    expect(html).toMatch(/<button[\s>]/)
  })

  it('renders an authored HTML id on button and anchor output', () => {
    expect(renderModule(ButtonModule, { href: '', htmlAttributes: { id: 'back-top' } }).html).toContain(
      '<button id="back-top"',
    )
    expect(renderModule(ButtonModule, { href: '/start', htmlAttributes: { id: 'cta' } }).html).toContain(
      '<a id="cta"',
    )
  })

  it('renders authored HTML attributes on button and anchor output', () => {
    expect(renderModule(ButtonModule, {
      href: '',
      htmlAttributes: { 'aria-label': 'Open modal', 'data-bs-toggle': 'modal' },
    }).html).toContain(' data-bs-toggle="modal"')
    expect(renderModule(ButtonModule, {
      href: '/start',
      htmlAttributes: { 'data-canvas-empty-container': 'true', 'data-track': 'cta' },
    }).html).toContain(' data-track="cta"')
  })

  it('XSS: strips javascript: href', () => {
    const { html } = renderModule(ButtonModule, { href: 'javascript:alert(1)' })
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('javascript:')
  })

  it('XSS: escapes label text', () => {
    // Simulate the publisher pipeline (Constraint #211)
    const safeProps = escapeProps({ ...ButtonModule.defaults, label: '<script>alert(1)</script>', href: '' }, ButtonModule.schema)
    const { html } = ButtonModule.render(safeProps, [])
    expect(html).toBeCleanHTML()
    expect(html).toContain('&lt;script&gt;')
  })

  it('adds rel="noopener noreferrer" for target="_blank" links', () => {
    const { html } = renderModule(ButtonModule, {
      href: 'https://example.com',
      target: '_blank',
    })
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => ButtonModule.render(ButtonModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.container — module-specific tests
// ---------------------------------------------------------------------------

describe('base.container — render() specifics', () => {
  it('is a container module (canHaveChildren: true)', () => {
    expect(ContainerModule.canHaveChildren).toBe(true)
  })

  it('exposes HTML tag selection (built-in tag + custom override)', () => {
    expect(Object.keys(ContainerModule.schema).sort()).toEqual(['customTag', 'htmlAttributes', 'tag'])
  })

  it('renders children HTML inside the container', () => {
    const child1 = '<h1>Title</h1>'
    const child2 = '<p>Body</p>'
    const { html } = renderModule(ContainerModule, {}, [child1, child2])
    expect(html).toContain(child1)
    expect(html).toContain(child2)
  })

  it('renders an authored HTML id', () => {
    const { html } = renderModule(ContainerModule, { htmlAttributes: { id: 'smooth-wrapper' } }, ['<p>child</p>'])
    expect(html).toBe('<div id="smooth-wrapper"><p>child</p></div>')
  })

  it('renders authored HTML attributes and escapes their values', () => {
    const { html } = renderModule(ContainerModule, {
      htmlAttributes: {
        'aria-label': 'Hero',
        'data-bg-src': '/uploads/hero.png',
        'data-title': 'Cats & "Dogs"',
        'data-node-id': 'reserved',
        role: 'region',
      },
    }, ['<p>child</p>'])
    expect(html).toBe(
      '<div aria-label="Hero" data-bg-src="/uploads/hero.png" data-title="Cats &amp; &quot;Dogs&quot;" role="region"><p>child</p></div>',
    )
    expect(html).not.toContain('data-node-id')
  })

  it('renders an empty container when no children are provided', () => {
    const { html } = renderModule(ContainerModule, {}, [])
    expect(typeof html).toBe('string')
    expect(html.trim().length).toBeGreaterThan(0)
    expect(html).not.toContain('data-canvas-empty-container')
  })

  it('renders a void custom tag (br) as a single tag, not <br></br>', () => {
    const { html } = renderModule(ContainerModule, { tag: 'custom', customTag: 'br' }, [])
    expect(html).toBe('<br>')
    // </br> would be reparsed by the HTML tokenizer as a SECOND <br>.
    expect(html).not.toContain('</br>')
  })

  it('renders an authored HTML id on void custom tags', () => {
    const { html } = renderModule(ContainerModule, { tag: 'custom', customTag: 'hr', htmlAttributes: { id: 'rule' } }, [])
    expect(html).toBe('<hr id="rule">')
  })

  it('renders a void custom tag (hr) with no closing tag', () => {
    const { html } = renderModule(ContainerModule, { tag: 'custom', customTag: 'hr' }, [])
    expect(html).toBe('<hr>')
  })

  it('renders safely when persisted props are missing tag', () => {
    const Component = ContainerModule.component

    expect(() => {
      renderReact(React.createElement(Component, {
        props: {},
        nodeId: 'container-with-missing-tag',
        isSelected: false,
      }))
    }).not.toThrow()
  })

  it('marks empty editor containers with a canvas-only pickable affordance', () => {
    const Component = ContainerModule.component
    const { container } = renderReact(React.createElement(Component, {
      props: {},
      nodeId: 'empty-container',
      isSelected: false,
    }))

    expect(container.firstElementChild?.getAttribute('data-canvas-empty-container')).toBe('true')
  })

  it('does not mark editor containers with children as empty', () => {
    const Component = ContainerModule.component
    const { container } = renderReact(React.createElement(Component, {
      props: {},
      nodeId: 'filled-container',
      isSelected: false,
      children: React.createElement('p', null, 'Child'),
    }))

    expect(container.firstElementChild?.hasAttribute('data-canvas-empty-container')).toBe(false)
  })

  it('renders the shared CanvasModulePlaceholder inside empty containers', () => {
    // The empty-state affordance is now the unified CanvasModulePlaceholder
    // (same primitive used by base.image, base.video, base.outlet, base.loop,
    // base.slot-outlet, base.visual-component-ref) so an empty container reads
    // the same way as every other empty module — one consistent stripe-pattern
    // language across the canvas. The legacy `.emptyCanvasContainer` CSS rule
    // (dashed outline + 72×48 min bounds) has been retired.
    const Component = ContainerModule.component
    const { container } = renderReact(React.createElement(Component, {
      props: {},
      nodeId: 'empty-container',
      isSelected: false,
    }))

    // The user's resolved tag still wraps the placeholder so the semantic
    // element is preserved on canvas (matches what the publisher emits).
    const outer = container.firstElementChild
    expect(outer?.getAttribute('data-canvas-empty-container')).toBe('true')

    // The placeholder primitive emits this data attribute on its root so
    // the canvas can identify the shared affordance unambiguously.
    const placeholder = outer?.querySelector('[data-canvas-module-placeholder]')
    expect(placeholder).not.toBeNull()
    expect(placeholder?.textContent).toContain('Empty container')
  })

  it('suppresses the empty-state placeholder when the container has a class', () => {
    // A class supplies the author's own styling (background image, shape,
    // spacer). The "Empty container" icon + label would be visual noise that
    // fights that styling, so a class-bearing empty container renders bare —
    // no placeholder and no data-canvas-empty-container marker.
    const Component = ContainerModule.component
    const { container } = renderReact(React.createElement(Component, {
      props: {},
      nodeId: 'decorative-container',
      isSelected: false,
      mcClassName: 'hero-bg',
    }))

    const outer = container.firstElementChild
    expect(outer?.classList.contains('hero-bg')).toBe(true)
    expect(outer?.hasAttribute('data-canvas-empty-container')).toBe(false)
    expect(outer?.querySelector('[data-canvas-module-placeholder]')).toBeNull()
  })

  it('falls back to div for invalid published tag values', () => {
    const { html } = ContainerModule.render({ tag: undefined }, ['<p>child</p>'])

    expect(html).toContain('<div>')
    expect(html).toContain('</div>')
    expect(html).not.toContain('<undefined')
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() =>
        ContainerModule.render(ContainerModule.defaults, ['<p>child</p>'])
      )
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.image — module-specific tests
// ---------------------------------------------------------------------------

describe('base.image — render() specifics', () => {
  // Image module returns empty HTML when src is absent (Guideline #226 —
  // no editor-only chrome in published output). Tests needing <img> must supply src.

  it('has only content and behavior module settings', () => {
    // N4: responsive pipeline added `fetchPriority` / `decoding` knobs
    // alongside the existing `src` / `loading` settings. `sizes` has NO knob —
    // the publisher derives it from the layout (sizesResolver.ts). Alt text
    // is sourced from the library asset row (single source of truth) — no
    // per-instance `alt` prop exists on the module.
    expect(Object.keys(ImageModule.schema).sort()).toEqual(
      ['decoding', 'fetchPriority', 'htmlAttributes', 'loading', 'src'],
    )
  })

  it('returns empty html when src is empty (Guideline #226)', () => {
    const { html } = renderModule(ImageModule, { src: '' })
    expect(html).toBe('')
    expect(html).not.toMatch(/<div[\s>]/)
    expect(html).not.toMatch(/<img[\s>]/)
  })

  it('renders an <img> element when src is provided', () => {
    const { html } = renderModule(ImageModule, { src: '/images/hero.jpg' })
    expect(html).toMatch(/<img[\s>]/)
    expect(html).toContain('src="/images/hero.jpg"')
  })

  it('renders an authored HTML id', () => {
    const { html } = renderModule(ImageModule, {
      src: '/images/hero.jpg',
      htmlAttributes: { id: 'hero-image' },
    })
    expect(html).toContain('<img id="hero-image"')
  })

  it('renders authored HTML attributes', () => {
    const { html } = renderModule(ImageModule, {
      src: '/images/hero.jpg',
      htmlAttributes: { 'aria-describedby': 'caption', 'data-lazy': 'hero' },
    })
    expect(html).toContain(' aria-describedby="caption"')
    expect(html).toContain(' data-lazy="hero"')
  })

  it('XSS: strips javascript: src — safeUrl() returns "#" → renders <img src="#">', () => {
    // javascript: src → safeUrl() returns '#' (truthy) → renders <img src="#">.
    // This is safe: no XSS payload reaches the output. The src="#" case is
    // semantically imperfect but the malicious scheme is fully neutralised.
    const { html } = renderModule(ImageModule, { src: 'javascript:alert(1)' })
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('javascript:')
  })

  it('XSS: escapes library alt text in <img>', () => {
    // Alt text comes from the library asset (`_resolvedMediaByKey.src.altText`),
    // which is raw — the module's render() HTML-escapes at the boundary so
    // malicious metadata in a library row can't break out of the attribute.
    const safeProps = escapeProps({ ...ImageModule.defaults, src: '/img.jpg' }, ImageModule.schema)
    const html = ImageModule.render(
      {
        ...safeProps,
        _resolvedMediaByKey: {
          src: {
            publicPath: '/img.jpg',
            mimeType: 'image/jpeg',
            width: 100,
            height: 100,
            altText: '"><script>alert(1)</script>',
            blurHash: null,
            variants: [],
            posterPath: null,
          },
        },
      },
      [],
    ).html
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('<script>')
  })

  it('includes alt attribute from the library asset for accessibility', () => {
    const safeProps = escapeProps({ ...ImageModule.defaults, src: '/img.jpg' }, ImageModule.schema)
    const html = ImageModule.render(
      {
        ...safeProps,
        _resolvedMediaByKey: {
          src: {
            publicPath: '/img.jpg',
            mimeType: 'image/jpeg',
            width: 100,
            height: 100,
            altText: 'Profile photo',
            blurHash: null,
            variants: [],
            posterPath: null,
          },
        },
      },
      [],
    ).html
    expect(html).toContain('alt="Profile photo"')
  })

  it('emits empty alt attribute when no library asset is resolved', () => {
    const { html } = renderModule(ImageModule, { src: '/img.jpg' })
    expect(html).toContain('alt=""')
  })

  it('includes loading="lazy" by default', () => {
    const { html } = renderModule(ImageModule, { src: '/img.jpg' })
    expect(html).toContain('loading="lazy"')
  })

  it('does not paint BlurHash placeholders behind transparent-capable image formats', () => {
    const safeProps = escapeProps({ ...ImageModule.defaults, src: '/logo.svg' }, ImageModule.schema)
    const html = ImageModule.render(
      {
        ...safeProps,
        _resolvedMediaByKey: {
          src: {
            publicPath: '/logo.svg',
            mimeType: 'image/svg+xml',
            width: 60,
            height: 60,
            altText: 'Logo',
            blurHash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4',
            variants: [],
            posterPath: null,
          },
        },
      },
      [],
    ).html

    expect(html).not.toContain('background-image')
  })

  it('keeps BlurHash placeholders for lazy opaque image formats', () => {
    const safeProps = escapeProps({ ...ImageModule.defaults, src: '/hero.jpg' }, ImageModule.schema)
    const html = ImageModule.render(
      {
        ...safeProps,
        _resolvedMediaByKey: {
          src: {
            publicPath: '/hero.jpg',
            mimeType: 'image/jpeg',
            width: 1200,
            height: 800,
            altText: 'Hero',
            blurHash: 'L6PZfSi_.AyE_3t7t7R**0o#DgR4',
            variants: [],
            posterPath: null,
          },
        },
      },
      [],
    ).html

    expect(html).toContain('background-image')
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => ImageModule.render(ImageModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.video — module-specific tests
// ---------------------------------------------------------------------------

describe('base.video — render() specifics', () => {
  it('exposes the v4 schema (single videoUrl, playback, poster, perf hints)', () => {
    expect(Object.keys(VideoModule.schema).sort()).toEqual([
      'autoplay',
      'controls',
      'loop',
      'muted',
      'playsinline',
      'poster',
      'preload',
      'videoUrl',
    ])
  })

  it('exposes videoUrl as a media-kind:video control with no condition gate', () => {
    expect(VideoModule.schema.videoUrl).toMatchObject({
      type: 'media',
      mediaKind: 'video',
    })
    // The old `source`/`youtubeId` props are gone — the URL alone decides.
    expect(VideoModule.schema).not.toHaveProperty('source')
    expect(VideoModule.schema).not.toHaveProperty('youtubeId')
    expect(VideoModule.defaults).not.toHaveProperty('source')
    expect(VideoModule.defaults).not.toHaveProperty('youtubeId')
  })

  it('is NOT a container (canHaveChildren: false)', () => {
    expect(VideoModule.canHaveChildren).toBe(false)
  })

  it('renders a YouTube iframe when videoUrl is a watch URL', () => {
    const { html } = renderModule(VideoModule, {
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ')
    expect(html).toMatch(/<iframe/)
    expect(html).toContain('loading="lazy"')
  })

  it('renders a YouTube iframe when videoUrl is a youtu.be short link', () => {
    const { html } = renderModule(VideoModule, {
      videoUrl: 'https://youtu.be/dQw4w9WgXcQ',
    })
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ')
    expect(html).toMatch(/<iframe/)
  })

  it('renders a YouTube iframe when videoUrl is a shorts URL', () => {
    const { html } = renderModule(VideoModule, {
      videoUrl: 'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    })
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ')
    expect(html).toMatch(/<iframe/)
  })

  it('wraps the YouTube iframe in a poster facade when a poster is set', () => {
    const { html, css } = renderModule(VideoModule, {
      videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      poster: '/uploads/hero.webp',
    })
    expect(html).toContain('class="bv-yt"')
    expect(html).toMatch(/<img class="bv-yt-poster"/)
    expect(html).toContain('src="/uploads/hero.webp"')
    expect(html).toContain('loading="eager"')
    expect(html).toContain('fetchpriority="high"')
    expect(html).toContain('class="bv-yt-frame"')
    expect(html).toContain('loading="lazy"')
    expect(css).toContain('.bv-yt')
  })

  it('renders a <video> element when videoUrl is a library path', () => {
    const { html } = renderModule(VideoModule, { videoUrl: '/uploads/intro.mp4' })
    expect(html).toMatch(/<video/)
    expect(html).toContain('/uploads/intro.mp4')
  })

  it('XSS: strips javascript: in videoUrl (url-validated by publisher)', () => {
    const { html } = renderModule(VideoModule, { videoUrl: 'javascript:alert(1)' })
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('javascript:')
  })

  it('XSS: strips data: URL in videoUrl (data: schemes blocked by safeUrl)', () => {
    // data:text/html URLs open a new browsing context with arbitrary HTML/JS,
    // bypassing the published page's CSP (isSafeUrl blocks all data: schemes).
    const { html } = renderModule(VideoModule, {
      videoUrl: 'data:text/html,<script>alert(1)</script>',
    })
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('javascript:')
  })

  it('XSS: strips vbscript: in videoUrl', () => {
    const { html } = renderModule(VideoModule, { videoUrl: 'vbscript:MsgBox(1)' })
    expect(html).not.toContain('vbscript:')
  })

  it('XSS: strips tab-normalised javascript: bypass in videoUrl', () => {
    // WHATWG URL parser strips \t before scheme detection — isSafeUrl mirrors this
    const { html } = renderModule(VideoModule, { videoUrl: 'java\tscript:alert(1)' })
    expect(html).not.toContain('alert(1)')
  })

  it('css field is props-independent — no prop interpolation (Constraint #310)', () => {
    const out1 = VideoModule.render(VideoModule.defaults, [])
    const out2 = VideoModule.render({ ...VideoModule.defaults, borderRadius: 99 }, [])
    // css field must be the same regardless of props
    expect(out1.css).toBe(out2.css)
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => VideoModule.render(VideoModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.list — module-specific tests
// ---------------------------------------------------------------------------

describe('base.list — render() specifics', () => {
  it('has only content and semantic module settings', () => {
    expect(Object.keys(ListModule.schema).sort()).toEqual(['items', 'listType'])
  })

  it('renders <ul> element for listType="unordered"', () => {
    const { html } = renderModule(ListModule, { listType: 'unordered' })
    expect(html).toContain('<ul')
    expect(html).toContain('</ul>')
    expect(html).not.toContain('<ol')
  })

  it('renders <ol> element for listType="ordered"', () => {
    const { html } = renderModule(ListModule, { listType: 'ordered' })
    expect(html).toContain('<ol')
    expect(html).toContain('</ol>')
    expect(html).not.toContain('<ul')
  })

  it('renders each newline-separated item as a <li> element', () => {
    const { html } = renderModule(ListModule, { items: 'Alpha\nBeta\nGamma' })
    expect(html).toContain('<li')
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    expect(html).toContain('Gamma')
    const liCount = (html.match(/<li/g) ?? []).length
    expect(liCount).toBe(3)
  })

  it('skips blank lines — blank entries do not produce empty <li>', () => {
    const { html } = renderModule(ListModule, { items: 'Item A\n\n\nItem B' })
    const liCount = (html.match(/<li/g) ?? []).length
    expect(liCount).toBe(2)
  })

  it('renders empty output (no <li>) when items is empty string', () => {
    const { html } = renderModule(ListModule, { items: '' })
    expect(html).not.toContain('<li')
  })

  it('XSS: HTML-escapes items via publisher pipeline (Constraint #211)', () => {
    // Publisher's escapeProps() is the sole escaping layer (Option A fix).
    // Items are pre-escaped before render() is called.
    const safeProps = escapeProps({ ...ListModule.defaults, items: '<script>alert(1)</script>\nSafe item' }, ListModule.schema)
    const { html } = ListModule.render(safeProps, [])
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('XSS: escapes & in item text without double-escaping', () => {
    const safeProps = escapeProps({ ...ListModule.defaults, items: 'Cats & Dogs\nBread & Butter' }, ListModule.schema)
    const { html } = ListModule.render(safeProps, [])
    expect(html).toContain('&amp;')
    expect(html).not.toContain('&amp;amp;')
  })

  it('defaults.items is empty string — shows placeholder on canvas (Guideline #226)', () => {
    // New list modules should start with the placeholder ("List item 1" in grey)
    // rather than pre-filled sample content. Empty string triggers the placeholder
    // branch in ListEditor. This matches the in-editor placeholder UX pattern.
    expect(ListModule.defaults.items).toBe('')
  })

  it('is NOT a container module (canHaveChildren: false)', () => {
    expect(ListModule.canHaveChildren).toBe(false)
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => ListModule.render(ListModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.link — module-specific tests
// ---------------------------------------------------------------------------

describe('base.link — render() specifics', () => {
  it('has URL, text, and target module settings', () => {
    expect(Object.keys(LinkModule.schema).sort()).toEqual(['href', 'htmlAttributes', 'target', 'text'])
  })

  it('renders target and rel for new-tab links', () => {
    const { html } = renderModule(LinkModule, {
      href: 'https://example.com',
      text: 'Example',
      target: '_blank',
    })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('renders an authored HTML id', () => {
    const { html } = renderModule(LinkModule, {
      href: '/pricing',
      text: 'Pricing',
      htmlAttributes: { id: 'pricing-link' },
    })
    expect(html).toContain('<a id="pricing-link"')
  })

  it('renders authored HTML attributes', () => {
    const { html } = renderModule(LinkModule, {
      href: '/about',
      text: 'About',
      htmlAttributes: { 'aria-current': 'page', 'data-track': 'nav-about' },
    })
    expect(html).toContain(' aria-current="page"')
    expect(html).toContain(' data-track="nav-about"')
  })

  it('can contain child modules for composed link content', () => {
    expect(LinkModule.canHaveChildren).toBe(true)
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => LinkModule.render(LinkModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Inline text edit declarations (docs/superpowers/specs/
// 2026-06-10-inline-text-editing-design.md) — the canvas resolves these
// generically; the declaration IS the feature's per-module surface.
// ---------------------------------------------------------------------------

describe('inline text edit declarations', () => {
  it('base.text edits the multiline `text` prop', () => {
    expect(TextModule.inlineTextEdit).toEqual({ prop: 'text', multiline: true })
  })

  it('base.button edits the single-line `label` prop', () => {
    expect(ButtonModule.inlineTextEdit).toEqual({ prop: 'label' })
  })

  it('base.link edits the single-line `text` prop (childless render path)', () => {
    expect(LinkModule.inlineTextEdit).toEqual({ prop: 'text' })
  })

  it('every declared prop exists in the module schema with a string default', () => {
    expect(Object.keys(TextModule.schema)).toContain('text')
    expect(typeof TextModule.defaults.text).toBe('string')
    expect(Object.keys(ButtonModule.schema)).toContain('label')
    expect(typeof ButtonModule.defaults.label).toBe('string')
    expect(Object.keys(LinkModule.schema)).toContain('text')
    expect(typeof LinkModule.defaults.text).toBe('string')
  })
})
