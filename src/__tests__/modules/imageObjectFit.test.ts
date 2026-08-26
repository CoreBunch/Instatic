/**
 * base.image framing — `object-fit` and its interaction with the focal point.
 *
 * These two declarations only mean anything together: `object-position` moves
 * the visible window of an image that something is cropping, and `object-fit:
 * cover` is what crops it. Getting the pair wrong fails silently — the page
 * renders, just framed on the wrong part of the subject.
 */
import { describe, expect, it } from 'bun:test'
import type { RenderResolvedMedia } from '@core/publisher'
import { registry } from '@core/module-engine'

import '@modules/base'

function media(overrides: Partial<RenderResolvedMedia> = {}): RenderResolvedMedia {
  return {
    publicPath: '/uploads/hero.png',
    mimeType: 'image/png',
    width: 2688,
    height: 1520,
    altText: '',
    blurHash: null,
    posterPath: null,
    variants: [],
    focus: null,
    crop: null,
    ...overrides,
  }
}

function renderImage(props: Record<string, unknown>, resolved = media()): string {
  const img = registry.getOrThrow('base.image')
  return img.render(
    {
      src: '/uploads/hero.png',
      loading: 'eager',
      fetchPriority: 'auto',
      decoding: 'async',
      objectFit: 'default',
      _resolvedMediaByKey: { src: resolved },
      ...props,
    },
    [],
  ).html
}

function styleAttr(html: string): string | null {
  const m = html.match(/style="([^"]*)"/)
  return m ? m[1] : null
}

describe('base.image object-fit', () => {
  it('emits nothing at the default, leaving the browser initial value', () => {
    const html = renderImage({ objectFit: 'default' })
    expect(html).not.toContain('object-fit')
  })

  it('emits cover and contain verbatim', () => {
    expect(renderImage({ objectFit: 'cover' })).toContain('object-fit:cover')
    expect(renderImage({ objectFit: 'contain' })).toContain('object-fit:contain')
  })

  it('carries fit and focal point in ONE style attribute', () => {
    // A second `style=` on the same element is dropped by the HTML parser, so
    // a regression here loses whichever declaration lost the race — silently.
    const html = renderImage(
      { objectFit: 'cover' },
      media({ focus: { x: 0.25, y: 0.75, width: 0.3, height: 0.3 } }),
    )
    expect(html.match(/style="/g)?.length).toBe(1)
    const style = styleAttr(html) ?? ''
    expect(style).toContain('object-fit:cover')
    expect(style).toContain('object-position:25% 75%')
  })

  // The focal point stays even at the default fit: the crop can come from a
  // framework class or the site's own stylesheet, and suppressing the position
  // here would quietly break both.
  it('still emits the focal point when the fit is left at default', () => {
    const html = renderImage(
      { objectFit: 'default' },
      media({ focus: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 } }),
    )
    expect(html).toContain('object-position:10% 20%')
    expect(html).not.toContain('object-fit')
  })

  it('emits no style at all for a plain image with neither', () => {
    expect(styleAttr(renderImage({}))).toBeNull()
  })
})
