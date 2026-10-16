import { describe, expect, it } from 'bun:test'
import { resolveViewportUnits } from '@core/utils/viewportUnits'
import { CANVAS_VIEWPORT_HEIGHT } from '@site/canvas/canvasViewport'

const viewport = { width: 1000, height: 800 }

describe('resolveViewportUnits', () => {
  it('resolves vh against the viewport height', () => {
    expect(resolveViewportUnits('.hero{min-height:88vh}', viewport)).toBe(
      '.hero{min-height:704px}',
    )
  })

  it('resolves vw against the viewport width', () => {
    expect(resolveViewportUnits('.x{width:50vw}', viewport)).toBe('.x{width:500px}')
  })

  it('resolves vmin/vmax against min/max of the axes', () => {
    expect(resolveViewportUnits('.a{width:10vmin;height:10vmax}', viewport)).toBe(
      '.a{width:80px;height:100px}',
    )
  })

  it('resolves small/large/dynamic viewport variants', () => {
    expect(
      resolveViewportUnits('.a{height:100svh;min-height:100lvh;max-height:100dvh}', viewport),
    ).toBe('.a{height:800px;min-height:800px;max-height:800px}')
  })

  it('resolves vi (inline → width) and vb (block → height)', () => {
    expect(resolveViewportUnits('.a{inline-size:10vi;block-size:10vb}', viewport)).toBe(
      '.a{inline-size:100px;block-size:80px}',
    )
  })

  it('handles decimals and zero', () => {
    expect(resolveViewportUnits('.a{top:33.5vh;left:0vw}', viewport)).toBe(
      '.a{top:268px;left:0px}',
    )
  })

  it('rewrites units inside calc()', () => {
    expect(resolveViewportUnits('.a{height:calc(100vh - 56px)}', viewport)).toBe(
      '.a{height:calc(800px - 56px)}',
    )
  })

  it('does not touch viewport-unit-like tokens inside identifiers', () => {
    // A class selector that merely contains the letters "vh" must not change.
    expect(resolveViewportUnits('.h100vh-utility{color:red}', viewport)).toBe(
      '.h100vh-utility{color:red}',
    )
  })

  it('leaves comments untouched', () => {
    expect(resolveViewportUnits('/* 100vh hero */\n.a{color:red}', viewport)).toBe(
      '/* 100vh hero */\n.a{color:red}',
    )
  })

  it('leaves strings untouched', () => {
    expect(resolveViewportUnits('.a::before{content:"100vh"}', viewport)).toBe(
      '.a::before{content:"100vh"}',
    )
  })

  it('leaves url() tokens untouched', () => {
    expect(resolveViewportUnits('.a{background:url(50vh.png)}', viewport)).toBe(
      '.a{background:url(50vh.png)}',
    )
  })

  it('does not match percentages or other units', () => {
    expect(resolveViewportUnits('.a{width:50%;height:10rem}', viewport)).toBe(
      '.a{width:50%;height:10rem}',
    )
  })

  it('is a no-op on empty input', () => {
    expect(resolveViewportUnits('', viewport)).toBe('')
  })

  it('exposes a sane default canvas viewport height', () => {
    expect(CANVAS_VIEWPORT_HEIGHT).toBeGreaterThan(0)
  })
})
