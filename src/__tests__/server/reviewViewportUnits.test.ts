/**
 * The merge review's frames resolve viewport units against a fixed desktop
 * viewport, so a `vh`-sized hero is as tall as on a screen rather than as
 * tall as the whole document.
 */
import { describe, expect, it } from 'bun:test'
import { resolveViewportUnits } from '../../../server/publish/reviewViewportUnits'

const viewport = { width: 1280, height: 800 }

describe('resolveViewportUnits', () => {
  it('turns every viewport unit in a style block into pixels of the review viewport', () => {
    const html = '<style>.hero{height:62vh;min-height:calc(100dvh - 80px);width:5.8vw;padding:10vmin 10vmax;margin:-0.14vw}</style>'
    expect(resolveViewportUnits(html, viewport)).toBe(
      '<style>.hero{height:496px;min-height:calc(800px - 80px);width:74.24px;padding:80px 128px;margin:-1.79px}</style>',
    )
  })

  it('resolves style attributes too, and leaves text and names alone', () => {
    const html = '<p style="height: 50vh">Set it to 100vh, or use --gap-1vh and a1vh.</p><style>:root{--gap-1vh:2px;--x:1vh}</style>'
    expect(resolveViewportUnits(html, viewport)).toBe(
      '<p style="height: 400px">Set it to 100vh, or use --gap-1vh and a1vh.</p><style>:root{--gap-1vh:2px;--x:8px}</style>',
    )
  })

  it('is a no-op for a page without viewport units', () => {
    const html = '<style>.a{height:100%;width:12px}</style><div style="color:red">x</div>'
    expect(resolveViewportUnits(html, viewport)).toBe(html)
  })
})
