/**
 * The merge review's frames resolve viewport units against a fixed desktop
 * viewport, so a `vh`-sized hero is as tall as on a screen rather than as
 * tall as the whole document. The scanner itself is covered by
 * `canvas/resolveViewportUnits.test.ts`; this checks the HTML walk.
 */
import { describe, expect, it } from 'bun:test'
import { resolveViewportUnitsInHtml } from '@core/utils/viewportUnits'

const viewport = { width: 1280, height: 800 }

describe('resolveViewportUnitsInHtml', () => {
  it('turns every viewport unit in a style block into pixels of the review viewport', () => {
    const html = '<style>.hero{height:62vh;min-height:calc(100dvh - 80px);width:5.8vw;padding:10vmin 10vmax;margin:-0.14vw}</style>'
    expect(resolveViewportUnitsInHtml(html, viewport)).toBe(
      '<style>.hero{height:496px;min-height:calc(800px - 80px);width:74.24px;padding:80px 128px;margin:-1.792px}</style>',
    )
  })

  it('resolves style attributes too, and leaves text and names alone', () => {
    const html = '<p style="height: 50vh">Set it to 100vh, or use --gap-1vh and a1vh.</p><style>:root{--gap-1vh:2px;--x:1vh}</style>'
    expect(resolveViewportUnitsInHtml(html, viewport)).toBe(
      '<p style="height: 400px">Set it to 100vh, or use --gap-1vh and a1vh.</p><style>:root{--gap-1vh:2px;--x:8px}</style>',
    )
  })

  it('leaves url() and quoted strings inside a style block alone', () => {
    const html = '<style>.a{background:url(/uploads/2vw.png);height:50vh}.b::after{content:"100vh"}</style>'
    expect(resolveViewportUnitsInHtml(html, viewport)).toBe(
      '<style>.a{background:url(/uploads/2vw.png);height:400px}.b::after{content:"100vh"}</style>',
    )
  })

  it('is a no-op for a page without viewport units', () => {
    const html = '<style>.a{height:100%;width:12px}</style><div style="color:red">x</div>'
    expect(resolveViewportUnitsInHtml(html, viewport)).toBe(html)
  })
})
