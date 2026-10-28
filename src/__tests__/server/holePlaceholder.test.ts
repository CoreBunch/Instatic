/**
 * Tests for module `staticPlaceholder` injection into `<instatic-hole>` elements.
 *
 * A dynamic module may provide a `staticPlaceholder(props): string` function.
 * At publish time, its output is sanitised and baked into the `<instatic-hole>`
 * element so non-JS visitors (or users before the runtime fires) see a
 * meaningful fallback (skeleton bars, "Loading…" text, blur images, etc.).
 *
 * Sanitisation: `sanitizeRichtext` is called on the placeholder string. In
 * the test environment (happy-dom is loaded by the global setup), DOMPurify
 * is available and strips `<script>` / event handlers. This test verifies
 * both the injection and the sanitisation boundary.
 */

import { describe, it, expect } from 'bun:test'
import { publishPage } from '../../core/publisher/render'
import { makePage, makeSite, makeRegistry, makeModule } from '../publisher/helpers'

describe('publishPage — staticPlaceholder injection and sanitisation', () => {
  it('injects the staticPlaceholder output into <instatic-hole>', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.live-widget', props: { label: 'Items' } },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', {
        dynamic: true,
        staticPlaceholder: (props) =>
          `<p class="skeleton">Loading ${String(props['label'] ?? '')}…</p>`,
      }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // The placeholder content must appear inside the instatic-hole element
    expect(html).toContain('<instatic-hole')
    expect(html).toContain('Loading Items')
    // The outer instatic-hole wrapper must still be present
    expect(html).toContain('</instatic-hole>')
  })

  it('omits placeholder content when staticPlaceholder is not provided', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.no-placeholder' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.no-placeholder': makeModule('plugin.no-placeholder', {
        dynamic: true,
        // No staticPlaceholder
      }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // The instatic-hole must be an empty element (nothing between the tags)
    expect(html).toContain('<instatic-hole')
    const holeStart = html.indexOf('<instatic-hole')
    const holeEnd = html.indexOf('</instatic-hole>', holeStart)
    const holeContent = html.slice(html.indexOf('>', holeStart) + 1, holeEnd)
    expect(holeContent.trim()).toBe('')
  })

  it('sanitises <script> tags injected via staticPlaceholder', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.evil-placeholder' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.evil-placeholder': makeModule('plugin.evil-placeholder', {
        dynamic: true,
        // Malicious placeholder attempting to inject a script
        staticPlaceholder: () => '<script>alert("xss")</script>Loading…',
      }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // The script tag must be stripped
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert("xss")')
    // The text content is preserved (DOMPurify or stripHtmlFallback keeps it)
    // "Loading…" text is retained
    expect(html).toContain('Loading')
  })

  it('sanitises onerror attributes injected via staticPlaceholder', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.attr-evil' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.attr-evil': makeModule('plugin.attr-evil', {
        dynamic: true,
        staticPlaceholder: () => '<img src="x" onerror="alert(1)">',
      }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // Event handler attribute must be stripped
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })

  it('preserves safe HTML in staticPlaceholder (e.g. <p> skeleton)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.skeleton' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.skeleton': makeModule('plugin.skeleton', {
        dynamic: true,
        staticPlaceholder: () =>
          '<div class="skeleton-bar"></div><p class="skeleton-text">Loading…</p>',
      }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // DOMPurify allows <div> and <p> tags with class attributes
    expect(html).toContain('skeleton-bar')
    expect(html).toContain('skeleton-text')
  })
})
