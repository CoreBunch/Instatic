/**
 * base.image responsive attributes — `sizes` resolution.
 *
 * `sizes='auto'` (the prop default) must emit the standards-based
 * `auto, <fallback>` form on LAZY images: browsers that implement
 * `sizes=auto` (Chrome 121+) pick by the image's actual rendered width,
 * everyone else parses past the unknown keyword and uses the fallback.
 * The spec only allows `auto` on `loading="lazy"` images, so eager images
 * emit the fallback alone. Author-supplied `sizes` values are verbatim.
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
  it("lazy + sizes 'auto' with a publisher-resolved cap emits `auto, <cap>`", () => {
    const html = renderImage({ loading: 'lazy', sizes: 'auto', _resolvedAutoSizes: '1280px' })
    expect(sizesAttr(html)).toBe('auto, 1280px')
  })

  it("lazy + sizes 'auto' without a resolved cap emits `auto, 100vw`", () => {
    const html = renderImage({ loading: 'lazy', sizes: 'auto' })
    expect(sizesAttr(html)).toBe('auto, 100vw')
  })

  it("eager + sizes 'auto' emits the fallback alone (`auto` keyword is lazy-only)", () => {
    const html = renderImage({ loading: 'eager', sizes: 'auto', _resolvedAutoSizes: '1280px' })
    expect(sizesAttr(html)).toBe('1280px')
  })

  it('an author-supplied sizes value is emitted verbatim', () => {
    const html = renderImage({ loading: 'lazy', sizes: '(min-width: 1024px) 50vw, 100vw' })
    expect(sizesAttr(html)).toBe('(min-width: 1024px) 50vw, 100vw')
  })

  it('srcset never contains the original file', () => {
    const html = renderImage({ loading: 'lazy', sizes: 'auto' })
    const m = html.match(/srcset="([^"]*)"/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toContain('.png')
  })
})
