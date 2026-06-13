/**
 * base.image responsive attributes — `sizes` resolution.
 *
 * `sizes` has no user knob: the publisher's layout resolver attaches
 * `_resolvedAutoSizes` and the module emits it. LAZY images prefix the
 * standards-based `auto` keyword: browsers that implement `sizes=auto`
 * (Chrome 121+) pick by the image's actual rendered width, everyone else
 * parses past the unknown keyword and uses the resolved fallback. The spec
 * only allows `auto` on `loading="lazy"` images, so eager images emit the
 * fallback alone.
 */
import { describe, expect, it } from 'bun:test'
import type { RenderResolvedMedia } from '@core/publisher'
import { registry } from '@core/module-engine'

import '@modules/base'

function media(): RenderResolvedMedia {
  return {
    publicPath: '/uploads/hero.png',
    mimeType: 'image/png',
    width: 2688,
    height: 1520,
    altText: '',
    blurHash: null,
    posterPath: null,
    variants: [
      { width: 640, height: 362, format: 'webp', path: '/uploads/hero-w640.webp', sizeBytes: 100 },
      { width: 1024, height: 579, format: 'webp', path: '/uploads/hero-w1024.webp', sizeBytes: 200 },
    ],
  }
}

function renderImage(props: Record<string, unknown>): string {
  const img = registry.getOrThrow('base.image')
  return img.render(
    {
      src: '/uploads/hero.png',
      fetchPriority: 'auto',
      decoding: 'async',
      _resolvedMediaByKey: { src: media() },
      ...props,
    },
    [],
  ).html
}

function sizesAttr(html: string): string | null {
  const m = html.match(/sizes="([^"]*)"/)
  return m ? m[1] : null
}

describe('base.image sizes resolution', () => {
  it('lazy with a publisher-resolved value emits `auto, <resolved>`', () => {
    const html = renderImage({ loading: 'lazy', _resolvedAutoSizes: 'min(33.33vw - 16px, 410.67px)' })
    expect(sizesAttr(html)).toBe('auto, min(33.33vw - 16px, 410.67px)')
  })

  it('lazy without a resolved value emits `auto, 100vw`', () => {
    const html = renderImage({ loading: 'lazy' })
    expect(sizesAttr(html)).toBe('auto, 100vw')
  })

  it('eager emits the resolved value alone (`auto` keyword is lazy-only)', () => {
    const html = renderImage({ loading: 'eager', _resolvedAutoSizes: 'min(100vw, 1280px)' })
    expect(sizesAttr(html)).toBe('min(100vw, 1280px)')
  })

  it('srcset never contains the original file', () => {
    const html = renderImage({ loading: 'lazy' })
    const m = html.match(/srcset="([^"]*)"/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toContain('.png')
  })
})
