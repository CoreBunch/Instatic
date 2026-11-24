import { describe, expect, it } from 'bun:test'
import { publishPage } from '@core/publisher'
import type { PublishedPageRuntimeAssets } from '@core/site-runtime'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'

const registry = makeRegistry({
  'base.body': makeModule('base.body', {
    canHaveChildren: true,
    render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
  }),
})

const page = makePage({
  root: { moduleId: 'base.body', props: {}, children: [] },
})

const site = makeSite({ pages: [page] })

describe('publishPage runtime assets', () => {
  it('keeps script execution disabled when no runtime assets are present', () => {
    const { html } = publishPage(page, site, registry)

    expect(html).toContain("script-src 'none'")
    expect(html).toContain("worker-src 'none'")
    expect(html).not.toContain('data-instatic-runtime-script')
  })

  it('allows self-hosted scripts and injects head and body-end runtime assets', () => {
    const runtimeAssets: PublishedPageRuntimeAssets = {
      scripts: [
        {
          fileId: 'body-script',
          src: '/_instatic/assets/runtime/body.123.js',
          placement: 'body-end',
          timing: 'dom-ready',
          priority: 100,
        },
        {
          fileId: 'head-script',
          src: '/_instatic/assets/runtime/head.123.js',
          placement: 'head',
          timing: 'immediate',
          priority: 10,
        },
      ],
    }

    const { html } = publishPage(page, site, registry, { runtimeAssets })

    expect(html).toContain("script-src 'self'")
    expect(html).toContain("worker-src 'self' blob:")
    expect(html).not.toContain("script-src 'none'")
    expect(html).toContain(
      '<script type="module" src="/_instatic/assets/runtime/head.123.js" data-instatic-runtime-script="head-script"></script>',
    )
    expect(html).toContain(
      '<script type="module" src="/_instatic/assets/runtime/body.123.js" data-instatic-runtime-script="body-script"></script>',
    )
    expect(html.indexOf('/_instatic/assets/runtime/head.123.js')).toBeLessThan(html.indexOf('</head>'))
    expect(html.indexOf('/_instatic/assets/runtime/body.123.js')).toBeLessThan(html.indexOf('</body>'))
    expect(html.indexOf('/_instatic/assets/runtime/body.123.js')).toBeGreaterThan(html.indexOf('<body>'))
  })

  it('orders runtime scripts by priority within each placement', () => {
    const runtimeAssets: PublishedPageRuntimeAssets = {
      scripts: [
        { fileId: 'b', src: '/_instatic/assets/runtime/b.js', placement: 'body-end', timing: 'dom-ready', priority: 20 },
        { fileId: 'a', src: '/_instatic/assets/runtime/a.js', placement: 'body-end', timing: 'dom-ready', priority: 10 },
      ],
    }

    const { html } = publishPage(page, site, registry, { runtimeAssets })

    expect(html.indexOf('/_instatic/assets/runtime/a.js')).toBeLessThan(html.indexOf('/_instatic/assets/runtime/b.js'))
  })

  it('emits classic runtime scripts without type=module', () => {
    const runtimeAssets: PublishedPageRuntimeAssets = {
      scripts: [
        {
          fileId: 'classic',
          src: '/_instatic/assets/runtime/jquery.js',
          format: 'classic',
          placement: 'body-end',
          timing: 'dom-ready',
          priority: 10,
        },
      ],
    }

    const { html } = publishPage(page, site, registry, { runtimeAssets })

    expect(html).toContain(
      '<script src="/_instatic/assets/runtime/jquery.js" data-instatic-runtime-script="classic"></script>',
    )
    runtimeAssets.scripts[0]!.defer = true
    expect(publishPage(page, site, registry, { runtimeAssets }).html).toContain(
      '<script defer src="/_instatic/assets/runtime/jquery.js" data-instatic-runtime-script="classic"></script>',
    )
  })

  it('does not inject external or unsafe runtime asset URLs', () => {
    const runtimeAssets: PublishedPageRuntimeAssets = {
      scripts: [
        { fileId: 'cdn', src: 'https://cdn.example.com/pkg.js', placement: 'body-end', timing: 'dom-ready', priority: 10 },
        { fileId: 'unsafe', src: 'javascript:alert(1)', placement: 'body-end', timing: 'dom-ready', priority: 20 },
        { fileId: 'escape', src: '../escape.js', placement: 'body-end', timing: 'dom-ready', priority: 30 },
      ],
    }

    const { html } = publishPage(page, site, registry, { runtimeAssets })

    expect(html).toContain("script-src 'none'")
    expect(html).not.toContain('cdn.example.com')
    expect(html).not.toContain('javascript:alert')
    expect(html).not.toContain('../escape.js')
  })
})
