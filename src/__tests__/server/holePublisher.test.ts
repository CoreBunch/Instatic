/**
 * Publisher tests for Layer C hole emission.
 *
 * Verifies that `publishPage` emits `<instatic-hole>` placeholders for dynamic
 * nodes instead of recursing into their subtrees, and that the
 * `/_instatic/hole-runtime.js` script tag is injected into the page `<head>` when
 * at least one hole exists.
 */

import { describe, it, expect } from 'bun:test'
import { publishPage } from '../../core/publisher/render'
import { makePage, makeSite, makeRegistry, makeModule } from '../publisher/helpers'

// ---------------------------------------------------------------------------
// Basic hole emission
// ---------------------------------------------------------------------------

describe('publishPage — Layer C hole placeholders', () => {
  it('emits <instatic-hole> for a node whose module has dynamic: true', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '42' })

    // The placeholder must be present
    expect(html).toContain('<instatic-hole')
    expect(html).toContain('data-instatic-hole="widget"')
    expect(html).toContain('data-instatic-version="42"')
    expect(html).toContain('id="hole-widget"')
  })

  it('injects /_instatic/hole-runtime.js into <head> when the page has at least one hole', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // The runtime script must be in <head>
    const headSection = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    expect(headSection).toContain('/_instatic/hole-runtime.js')
    expect(headSection).toContain('type="module"')
    expect(headSection).toContain('defer')
  })

  it('does NOT inject the hole runtime script for a fully static page', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['text'] },
      text: { moduleId: 'base.text', props: { text: 'Hello' } },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'base.text': makeModule('base.text'),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    expect(html).not.toContain('hole-runtime.js')
    expect(html).not.toContain('<instatic-hole')
  })

  it('does NOT recurse into the dynamic node subtree (children absent from output)', () => {
    // The dynamic node has a child — that child should NOT appear in the output
    // because we stop recursing when we emit the placeholder.
    const page = makePage({
      root: { moduleId: 'base.body', children: ['widget'] },
      widget: {
        moduleId: 'plugin.live-widget',
        children: ['secret-child'],
      },
      'secret-child': {
        moduleId: 'base.text',
        props: { text: 'SHOULD_NOT_APPEAR' },
      },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
      'base.text': makeModule('base.text'),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // The placeholder is emitted
    expect(html).toContain('<instatic-hole')
    // The secret child's content is NOT in the output
    expect(html).not.toContain('SHOULD_NOT_APPEAR')
  })

  it('stamps the snapshotHash onto the data-instatic-version attribute', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['w'] },
      w: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<body>${children.join('')}</body>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const { html: html7 } = publishPage(page, site, reg, { snapshotHash: '7' })
    expect(html7).toContain('data-instatic-version="7"')

    const { html: html99 } = publishPage(page, site, reg, { snapshotHash: '99' })
    expect(html99).toContain('data-instatic-version="99"')

    const { html: escaped } = publishPage(page, site, reg, { snapshotHash: '" onload="bad' })
    expect(escaped).toContain('data-instatic-version="&quot; onload=&quot;bad"')
    expect(escaped).toContain('/_instatic/hole-runtime.js?v=%22%20onload%3D%22bad')
  })

  it('defaults snapshotHash to an empty string when not provided', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['w'] },
      w: { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<body>${children.join('')}</body>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const { html } = publishPage(page, site, reg)
    expect(html).toContain('data-instatic-version=""')
  })

  it('renders static siblings of a dynamic node normally', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['static-node', 'dynamic-node'] },
      'static-node': {
        moduleId: 'base.text',
        props: { text: 'STATIC_TEXT' },
      },
      'dynamic-node': { moduleId: 'plugin.live-widget' },
    })
    const site = makeSite()
    const reg = makeRegistry({
      'base.body': makeModule('base.body', {
        render: (_p, children) => ({ html: `<div>${children.join('')}</div>` }),
      }),
      'base.text': makeModule('base.text', {
        render: (p) => ({ html: `<p>${p['text']}</p>` }),
      }),
      'plugin.live-widget': makeModule('plugin.live-widget', { dynamic: true }),
    })

    const { html } = publishPage(page, site, reg, { snapshotHash: '1' })

    // Static sibling IS in the output
    expect(html).toContain('STATIC_TEXT')
    // Dynamic node is a placeholder
    expect(html).toContain('<instatic-hole')
    expect(html).toContain('data-instatic-hole="dynamic-node"')
  })
})
