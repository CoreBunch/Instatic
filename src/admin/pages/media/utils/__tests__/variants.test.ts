/**
 * Admin variant helpers — same selection policy as the publisher's
 * `buildMediaSrcset` / `pickMediaVariantUrl` (variants only, never the
 * original): the editor canvas and media viewer must not download a
 * multi-MB original on high-DPI displays any more than a published page.
 */
import { describe, expect, it } from 'bun:test'
import { buildVariantSrcset, pickVariantUrl } from '../variants'

const asset = {
  publicPath: '/uploads/hero.png',
  width: 2688,
  variants: [
    { width: 640, height: 362, format: 'webp', path: '/uploads/hero-w640.webp', sizeBytes: 100 },
    { width: 2688, height: 1520, format: 'webp', path: '/uploads/hero-w2688.webp', sizeBytes: 400 },
  ],
}

describe('buildVariantSrcset', () => {
  it('emits the variants only — never the original', () => {
    expect(buildVariantSrcset(asset)).toBe(
      '/uploads/hero-w640.webp 640w, /uploads/hero-w2688.webp 2688w',
    )
  })

  it('returns undefined with no variants', () => {
    expect(buildVariantSrcset({ ...asset, variants: [] })).toBeUndefined()
  })
})

describe('pickVariantUrl', () => {
  it('picks the smallest variant at or above the target', () => {
    expect(pickVariantUrl(asset, 500)).toBe('/uploads/hero-w640.webp')
  })

  it('falls back to the LARGEST VARIANT, not the original, when nothing is big enough', () => {
    // Legacy assets cap at 2048w; a 4K target must get the largest WebP —
    // marginally lower resolution beats a multi-MB PNG download.
    expect(pickVariantUrl(asset, 9999)).toBe('/uploads/hero-w2688.webp')
  })

  it('returns the original only when the asset has no variants at all', () => {
    expect(pickVariantUrl({ ...asset, variants: [] }, 500)).toBe('/uploads/hero.png')
  })
})
