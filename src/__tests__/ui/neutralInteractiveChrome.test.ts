import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'

const SEGMENTED_CONTROL_CSS = 'src/ui/components/SegmentedControl/SegmentedControl.module.css'
const RANGE_TABS_CSS = 'src/ui/components/RangeTabs/RangeTabs.module.css'
const BUTTON_CSS = 'src/ui/components/Button/Button.module.css'
const CANVAS_MODE_TOGGLE_CSS =
  'src/admin/pages/site/canvas/CanvasModeToggle.module.css'
const SECTION_CSS = 'src/ui/components/Section/Section.module.css'

function cssRule(css: string, selector: string): string {
  const blocks = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) ?? []
  const rule = blocks.find((block) => {
    const selectors = block
      .slice(0, block.indexOf('{'))
      .split(',')
      .map((item) => item.trim())
    return selectors.includes(selector)
  })
  if (!rule) throw new Error(`Missing CSS rule for selector: ${selector}`)
  return rule
}

function expectBackgroundToken(rule: string, token: string): void {
  expect(rule).toMatch(new RegExp(`background:\\s*var\\(${token}\\);`))
}

function expectNoSurfaceBackground(rule: string): void {
  expect(rule).not.toMatch(/background:\s*var\(--bg-surface(?:-[2-5])?\);/)
}

describe('neutral interactive chrome', () => {
  it('uses overlay states for shared segmented controls', () => {
    const segmentedCss = readFileSync(SEGMENTED_CONTROL_CSS, 'utf8')
    const rangeTabsCss = readFileSync(RANGE_TABS_CSS, 'utf8')

    const segmentedTrack = cssRule(segmentedCss, '.group')
    const segmentedHover = cssRule(segmentedCss, '.group .segment.segment:hover')
    const segmentedActive = cssRule(
      segmentedCss,
      '.group .segment.segment[aria-pressed="true"]',
    )
    const clearOverlay = cssRule(segmentedCss, '.group .segment .clearOverlay')
    const rangeTrack = cssRule(rangeTabsCss, '.seg')
    const rangeActive = cssRule(rangeTabsCss, '.tab[data-active="true"]')

    expectBackgroundToken(segmentedTrack, '--overlay-5')
    expectBackgroundToken(segmentedHover, '--overlay-10')
    expectBackgroundToken(segmentedActive, '--overlay-20')
    expectBackgroundToken(clearOverlay, '--overlay-20')
    expectBackgroundToken(rangeTrack, '--overlay-5')
    expectBackgroundToken(rangeActive, '--overlay-20')

    for (const rule of [
      segmentedTrack,
      segmentedHover,
      segmentedActive,
      clearOverlay,
      rangeTrack,
      rangeActive,
    ]) {
      expectNoSurfaceBackground(rule)
    }
  })

  it('uses overlay states for shared neutral button variants', () => {
    const css = readFileSync(BUTTON_CSS, 'utf8')

    const ghostHover = cssRule(css, '.variant-ghost:hover')
    const ghostActive = cssRule(css, '.variant-ghost:active')
    const primary = cssRule(css, '.variant-primary')
    const primaryHover = cssRule(css, '.variant-primary:hover')
    const primaryActive = cssRule(css, '.variant-primary:active')
    const secondary = cssRule(css, '.variant-secondary')
    const secondaryHover = cssRule(css, '.variant-secondary:hover')
    const secondaryActive = cssRule(css, '.variant-secondary:active')
    const secondaryPressed = cssRule(css, '.variant-secondary[aria-pressed="true"]')

    expectBackgroundToken(ghostHover, '--overlay-10')
    expectBackgroundToken(ghostActive, '--overlay-20')
    expectBackgroundToken(primary, '--overlay-20')
    expectBackgroundToken(primaryHover, '--overlay-30')
    expectBackgroundToken(primaryActive, '--overlay-20')
    expectBackgroundToken(secondary, '--overlay-10')
    expectBackgroundToken(secondaryHover, '--overlay-20')
    expectBackgroundToken(secondaryActive, '--overlay-30')
    expectBackgroundToken(secondaryPressed, '--overlay-20')

    for (const rule of [
      ghostHover,
      ghostActive,
      primary,
      primaryHover,
      primaryActive,
      secondary,
      secondaryHover,
      secondaryActive,
      secondaryPressed,
    ]) {
      expectNoSurfaceBackground(rule)
    }
  })

  it('uses overlay states for the canvas mode pill', () => {
    const css = readFileSync(CANVAS_MODE_TOGGLE_CSS, 'utf8')

    const tabHover = cssRule(css, '.tab:hover:not(.tabActive)')
    const tabActive = cssRule(css, '.tabActive')

    expectBackgroundToken(tabHover, '--overlay-10')
    expectBackgroundToken(tabActive, '--overlay-20')
    expectNoSurfaceBackground(tabHover)
    expectNoSurfaceBackground(tabActive)
  })

  it('keeps flush inspector sections from painting an open group background', () => {
    const css = readFileSync(SECTION_CSS, 'utf8')

    const flushOpen = cssRule(css, '.sectionFlush.sectionOpen')

    expect(flushOpen).toMatch(/background:\s*transparent;/)
  })
})
