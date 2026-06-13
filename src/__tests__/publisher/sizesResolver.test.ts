/**
 * Publisher — automatic `sizes` resolver tests.
 *
 * The resolver walks the image's ancestor chain root→image and models each
 * node's width as `min(…)` of linear functions of the viewport
 * (`a·vw + b px`). Pixel caps, percentage widths, vw widths, px paddings,
 * and grid column tracks (px / % / fr, with gaps) all stay linear, so the
 * emitted `sizes` value is exact CSS math (`min(33.33vw - 16px, 410.67px)`)
 * rather than a loose ancestor-cap estimate. Per-breakpoint overrides emit
 * one candidate per viewport tier, first-match ordered.
 *
 *   - Nothing constrains anywhere → `null` (caller falls back to 100vw).
 *   - Pixel caps emit `min(100vw, <cap>px)` — the element is genuinely the
 *     smaller of the two below/above the cap.
 *   - Fractions (`width: 50%`, vw widths) multiply through.
 *   - Grid columns: the child's track share of the container, minus gaps.
 *   - Flex rows bail to the container width (content-driven; conservative
 *     over-estimate is the safe direction — never blurry, only heavier).
 *   - Per-viewport overrides emit `sizes` candidates using the configured
 *     media queries; tiers equal to the base value collapse away.
 */
import { describe, it, expect } from 'bun:test'
import { resolveAutoSizes } from '@core/publisher'
import { makePage, makeSite } from './helpers'
import { classKindSelector, type StyleRule } from '@core/page-tree'

function makeClass(id: string, partial: Partial<StyleRule> = {}): StyleRule {
  return {
    id,
    name: id,
    kind: 'class',
    selector: classKindSelector(id),
    order: 0,
    styles: {},
    contextStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

const DESKTOP = [{ id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' }]

describe('resolveAutoSizes — no constraint', () => {
  it('returns null when the image has no constraining ancestor', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite()
    expect(resolveAutoSizes('img', page, site)).toBeNull()
  })

  it('returns null when ancestors only declare full-width values', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['fluid'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      styleRules: {
        fluid: makeClass('fluid', { styles: { width: '100%', maxWidth: 'none' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBeNull()
  })
})

describe('resolveAutoSizes — pixel caps', () => {
  it('emits min(100vw, cap) for a single max-width container', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['narrow'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        narrow: makeClass('narrow', { styles: { maxWidth: '1200px' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 1200px)')
  })

  it('a fixed pixel width is exact — no viewport term survives', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['fixed'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        fixed: makeClass('fixed', { styles: { width: '400px' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('400px')
  })

  it('the tighter of two nested caps wins via min-pruning', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['outer'] },
      outer: { moduleId: 'base.container', classIds: ['wide'], children: ['inner'] },
      inner: { moduleId: 'base.container', classIds: ['narrow'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        wide: makeClass('wide', { styles: { maxWidth: '1600px' } }),
        narrow: makeClass('narrow', { styles: { maxWidth: '600px' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 600px)')
  })

  it('uses the image\'s OWN class when one is set directly on the <img>', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['img'] },
      img: { moduleId: 'base.image', classIds: ['pinned'] },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        pinned: makeClass('pinned', { styles: { maxWidth: '600px' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 600px)')
  })

  it('accepts bare numbers as px and prefers maxWidth over width', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['c'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        c: makeClass('c', { styles: { width: '900px', maxWidth: 800 } }),
      },
    })
    // width:900px is exact, maxWidth:800px caps it → 800px.
    expect(resolveAutoSizes('img', page, site)).toBe('800px')
  })
})

describe('resolveAutoSizes — fractions', () => {
  it('multiplies a percentage width through a pixel cap', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['half'] },
      half: { moduleId: 'base.container', classIds: ['half'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1200px' } }),
        half: makeClass('half', { styles: { width: '50%' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(50vw, 600px)')
  })

  it('resolves a vw width directly', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['vwHalf'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        vwHalf: makeClass('vwHalf', { styles: { width: '50vw' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('50vw')
  })

  it('subtracts pixel padding from the content box', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['padded'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        padded: makeClass('padded', {
          styles: { maxWidth: '1200px', paddingLeft: '40px', paddingRight: '40px' },
        }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw - 80px, 1120px)')
  })
})

describe('resolveAutoSizes — grid columns', () => {
  it('computes the fr-track share of a 3-column grid with gaps', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['grid3'], children: ['img', 'b', 'c'] },
      img: { moduleId: 'base.image' },
      b: { moduleId: 'base.image' },
      c: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1280px' } }),
        grid3: makeClass('grid3', {
          styles: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' },
        }),
      },
    })
    // Container = min(100vw, 1280px); columns = (W - 2·24)/3 = W/3 - 16.
    expect(resolveAutoSizes('img', page, site)).toBe('min(33.33vw - 16px, 410.67px)')
  })

  it('resolves a px + fr track list for the child in the fr column', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['sidebar'], children: ['aside', 'img'] },
      aside: { moduleId: 'base.container' },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1000px' } }),
        sidebar: makeClass('sidebar', {
          styles: { display: 'grid', gridTemplateColumns: '300px 1fr', columnGap: '20px' },
        }),
      },
    })
    // img is child #2 → the 1fr column: W - 20 (gap) - 300 (px track).
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw - 320px, 680px)')
  })

  it('resolves a fixed px track for the child in that column', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['sidebar'], children: ['img', 'main'] },
      img: { moduleId: 'base.image' },
      main: { moduleId: 'base.container' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        sidebar: makeClass('sidebar', {
          styles: { display: 'grid', gridTemplateColumns: '300px 1fr' },
        }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('300px')
  })

  it('wraps auto-placed children onto rows (index modulo column count)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['two'], children: ['a', 'b', 'img'] },
      a: { moduleId: 'base.container' },
      b: { moduleId: 'base.container' },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        two: makeClass('two', {
          styles: { display: 'grid', gridTemplateColumns: '200px 1fr' },
        }),
      },
    })
    // img is child #3 → wraps to row 2, column 1 → the 200px track.
    expect(resolveAutoSizes('img', page, site)).toBe('200px')
  })

  it('bails to the container width for unparsable track lists', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['autofit'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '900px' } }),
        autofit: makeClass('autofit', {
          styles: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' },
        }),
      },
    })
    // auto-fill is viewport-dependent in a way we can't model linearly —
    // conservative fall-back to the container width.
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 900px)')
  })
})

describe('resolveAutoSizes — flex rows bail conservatively', () => {
  it('uses the container width for a flex-row child with no own width', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['row'] },
      row: { moduleId: 'base.container', classIds: ['row'], children: ['img', 'b'] },
      img: { moduleId: 'base.image' },
      b: { moduleId: 'base.container' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1000px' } }),
        row: makeClass('row', { styles: { display: 'flex', flexDirection: 'row' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 1000px)')
  })

  it('still honors the child\'s own percentage width inside a flex row', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['row'] },
      row: { moduleId: 'base.container', classIds: ['row'], children: ['img', 'b'] },
      img: { moduleId: 'base.image', classIds: ['third'] },
      b: { moduleId: 'base.container' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1200px' } }),
        row: makeClass('row', { styles: { display: 'flex' } }),
        third: makeClass('third', { styles: { width: '25%' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(25vw, 300px)')
  })
})

describe('resolveAutoSizes — per-breakpoint overrides', () => {
  it('shrinks the cap at the narrower breakpoint', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['shrinks'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: [
        { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
        { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
      ],
      styleRules: {
        shrinks: makeClass('shrinks', {
          styles: { maxWidth: '1200px' },
          contextStyles: { mobile: { maxWidth: '320px' } },
        }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe(
      '(max-width: 375px) min(100vw, 320px), min(100vw, 1200px)',
    )
  })

  it('collapses a grid to one column on mobile', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['responsiveGrid'], children: ['img', 'b', 'c'] },
      img: { moduleId: 'base.image' },
      b: { moduleId: 'base.container' },
      c: { moduleId: 'base.container' },
    })
    const site = makeSite({
      breakpoints: [
        { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
        { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
      ],
      styleRules: {
        responsiveGrid: makeClass('responsiveGrid', {
          styles: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '30px' },
          contextStyles: { mobile: { gridTemplateColumns: '1fr' } },
        }),
      },
    })
    // Desktop: (100vw - 60px)/3 = 33.33vw - 20px. Mobile: single column, the
    // gap no longer applies between columns → full width → collapses to the
    // 100vw fallback? No: one column of a gapped grid is still 100vw (no
    // column gaps with one track), which equals the unconstrained base — but
    // the BASE here is the 3-column math, so the mobile tier emits 100vw.
    expect(resolveAutoSizes('img', page, site)).toBe(
      '(max-width: 375px) 100vw, calc(33.33vw - 20px)',
    )
  })

  it('uses configured min-width media queries for mobile-first viewport contexts', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['responsive'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: [
        { id: 'mobile', label: 'Mobile', width: 375, mediaQuery: '(min-width: 375px)', icon: 'smartphone' },
        { id: 'tablet', label: 'Tablet', width: 768, mediaQuery: '(min-width: 768px)', icon: 'tablet' },
        { id: 'desktop', label: 'Desktop', width: 1440, mediaQuery: '(min-width: 1440px)', icon: 'monitor' },
      ],
      styleRules: {
        responsive: makeClass('responsive', {
          styles: { maxWidth: '320px' },
          contextStyles: {
            tablet: { maxWidth: '700px' },
            desktop: { maxWidth: '1200px' },
          },
        }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe(
      '(min-width: 1440px) min(100vw, 1200px), (min-width: 768px) min(100vw, 700px), min(100vw, 320px)',
    )
  })
})

describe('resolveAutoSizes — cascade fidelity', () => {
  it('class conflicts resolve by styleRule.order, matching the published stylesheet', () => {
    // generateClassCSS emits rules sorted by cls.order; with equal
    // specificity the LATER stylesheet rule wins regardless of the order
    // the author applied classes to the node.
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['wide', 'narrow'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        narrow: makeClass('narrow', { order: 0, styles: { maxWidth: '200px' } }),
        wide: makeClass('wide', { order: 1, styles: { maxWidth: '600px' } }),
      },
    })
    // .wide is emitted later in the stylesheet → it wins, NOT 'narrow'
    // (which is later in classIds).
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 600px)')
  })

  it('node inlineStyles outrank class rules', () => {
    // The publisher injects node.inlineStyles as a literal style="…"
    // attribute, which beats every class — the resolver must agree or it
    // under-estimates when the inline value is wider.
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['img'] },
      img: { moduleId: 'base.image', classIds: ['thumb'], inlineStyles: { width: '100%' } },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1200px' } }),
        thumb: makeClass('thumb', { styles: { width: '240px' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 1200px)')
  })
})

describe('resolveAutoSizes — grid placement fidelity', () => {
  it('percentage tracks resolve against the FULL content box, not the gap-reduced one', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['halves'], children: ['img', 'b'] },
      img: { moduleId: 'base.image' },
      b: { moduleId: 'base.container' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        halves: makeClass('halves', {
          styles: { display: 'grid', gridTemplateColumns: '50% 50%', columnGap: '24px' },
        }),
      },
    })
    // CSS resolves % tracks against the container's content box — gaps
    // overflow, they don't shrink the track. calc(50vw - 12px) would
    // under-estimate (blurry direction).
    expect(resolveAutoSizes('img', page, site)).toBe('50vw')
  })

  it('bails to the container width when percentage tracks overflow (sum > 100%)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['overflowing'], children: ['a', 'b', 'img'] },
      a: { moduleId: 'base.container' },
      b: { moduleId: 'base.container' },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '800px' } }),
        overflowing: makeClass('overflowing', {
          styles: { display: 'grid', gridTemplateColumns: '60% 60% 1fr' },
        }),
      },
    })
    // 1 - pctSum is negative — a negative-width term must never be emitted.
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 800px)')
  })

  it('hidden siblings do not occupy grid tracks — placement counts rendered items', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['sidebar'], children: ['aside', 'img'] },
      aside: { moduleId: 'base.container', hidden: true },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        sidebar: makeClass('sidebar', {
          styles: { display: 'grid', gridTemplateColumns: '300px 1fr' },
        }),
      },
    })
    // The hidden aside renders nothing, so the image is the FIRST grid item
    // and lands in the 300px track.
    expect(resolveAutoSizes('img', page, site)).toBe('300px')
  })

  it('bails when a sibling declares explicit gridColumn placement (spans shift rows)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['grid'] },
      grid: { moduleId: 'base.container', classIds: ['featured'], children: ['header', 'img'] },
      header: { moduleId: 'base.container', classIds: ['span'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '900px' } }),
        featured: makeClass('featured', {
          styles: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr' },
        }),
        span: makeClass('span', { styles: { gridColumn: '1 / -1' } }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 900px)')
  })

  it('bails for unequal tracks when the grid is a loop (copies round-robin the tracks)', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['loop'] },
      loop: { moduleId: 'base.loop', classIds: ['sidebar'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '900px' } }),
        sidebar: makeClass('sidebar', {
          styles: { display: 'grid', gridTemplateColumns: '240px 1fr' },
        }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 900px)')
  })

  it('equal tracks stay exact inside a loop — every copy gets the same column width', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['loop'] },
      loop: { moduleId: 'base.loop', classIds: ['cards'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1280px' } }),
        cards: makeClass('cards', {
          styles: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '24px' },
        }),
      },
    })
    expect(resolveAutoSizes('img', page, site)).toBe('min(33.33vw - 16px, 410.67px)')
  })
})

describe('resolveAutoSizes — min-width floors', () => {
  it('emits a max() floor for a px min-width', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['img'] },
      img: { moduleId: 'base.image', classIds: ['card'] },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        card: makeClass('card', { styles: { width: '30%', minWidth: '280px' } }),
      },
    })
    // Ignoring the floor would under-estimate at narrow viewports (the
    // element never shrinks below 280px).
    expect(resolveAutoSizes('img', page, site)).toBe('max(280px, 30vw)')
  })

  it('a non-px min-width skips the node\'s narrowing instead of under-estimating', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['cap'], children: ['img'] },
      img: { moduleId: 'base.image', classIds: ['weird'] },
    })
    const site = makeSite({
      breakpoints: DESKTOP,
      styleRules: {
        cap: makeClass('cap', { styles: { maxWidth: '1000px' } }),
        weird: makeClass('weird', { styles: { width: '20%', minWidth: '30rem' } }),
      },
    })
    // The rem floor can't be modelled — drop the node's own narrowing and
    // keep the ancestor cap (over-estimate, never blurry).
    expect(resolveAutoSizes('img', page, site)).toBe('min(100vw, 1000px)')
  })
})

describe('resolveAutoSizes — emission safety', () => {
  it('does not collapse tiers when media-query directions are mixed', () => {
    const page = makePage({
      root: { moduleId: 'base.body', children: ['wrap'] },
      wrap: { moduleId: 'base.container', classIds: ['mixed'], children: ['img'] },
      img: { moduleId: 'base.image' },
    })
    const site = makeSite({
      breakpoints: [
        { id: 'small', label: 'Small', width: 600, mediaQuery: '(max-width: 600px)', icon: 'smartphone' },
        { id: 'large', label: 'Large', width: 1000, mediaQuery: '(min-width: 1000px)', icon: 'monitor' },
      ],
      styleRules: {
        mixed: makeClass('mixed', {
          styles: { width: '50%' },
          contextStyles: { small: { width: '80%' }, large: { width: '80%' } },
        }),
      },
    })
    // The two query ranges are disjoint — neither tier may be dropped just
    // because its value equals its neighbour's (a 1200px viewport matches
    // only the min-width tier; collapsing it would fall through to 50vw
    // while CSS renders 80% → blurry).
    expect(resolveAutoSizes('img', page, site)).toBe(
      '(min-width: 1000px) 80vw, (max-width: 600px) 80vw, 50vw',
    )
  })

  it('caps the candidate set so deep %-cap chains cannot bloat the attribute', () => {
    const nodes: Record<string, { moduleId: string; children?: string[]; classIds?: string[] }> = {
      root: { moduleId: 'base.body', children: ['w0'] },
    }
    const styleRules: Record<string, StyleRule> = {}
    for (let i = 0; i < 12; i++) {
      const id = `w${i}`
      nodes[id] = {
        moduleId: 'base.container',
        children: [i === 11 ? 'img' : `w${i + 1}`],
        classIds: [`c${i}`],
      }
      styleRules[`c${i}`] = makeClass(`c${i}`, {
        styles: { maxWidth: `${99 - i}%`, paddingLeft: '20px', paddingRight: '20px' },
      })
    }
    nodes.img = { moduleId: 'base.image' }
    const page = makePage(nodes)
    const site = makeSite({ breakpoints: DESKTOP, styleRules })
    const sizes = resolveAutoSizes('img', page, site)
    expect(sizes).not.toBeNull()
    // Bounded output: at most 4 min() terms — dropping terms only ever
    // over-estimates, which is the safe direction.
    expect((sizes!.match(/,/g) ?? []).length).toBeLessThanOrEqual(4)
    expect(sizes!.length).toBeLessThan(200)
  })
})
