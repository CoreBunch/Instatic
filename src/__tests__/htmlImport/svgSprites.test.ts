/**
 * Sprite inlining limits and correctness (`@core/htmlImport` → svgSprites.ts).
 * `importHtml` runs on every paste and agent insert, so its cost must stay
 * bounded whatever markup arrives, and a copy must not break the page's ids.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { importHtml } from '@core/htmlImport'

function svgMarkup(source: string, loadSvgSprite?: (path: string) => string | null): string[] {
  const result = importHtml(source, { loadSvgSprite })
  return Object.values(result.nodes)
    .filter((n) => n.moduleId === 'base.svg')
    .map((n) => String(n.props.svg))
}

const repeat = (count: number, text: string) => Array.from({ length: count }, () => text).join('')

describe('sprite inlining cost', () => {
  it('refuses a symbol larger than the budget without copying it', () => {
    const big = `<svg hidden><symbol id="big">${repeat(25000, '<rect width="1" height="1"/>')}</symbol></svg>`
    const result = importHtml(`${big}<svg class="x"><use href="#big"/></svg>`)
    expect(result.unresolvedSvgRefs).toEqual(['#big'])
    const icon = Object.values(result.nodes).find((n) => n.classIds?.includes('x'))!
    expect(String(icon.props.svg)).not.toContain('<rect')
  })

  it('reports the symbol when its remaining instances exceed the budget', () => {
    const symbol = `<svg hidden><symbol id="s">${repeat(2000, '<rect width="1" height="1"/>')}</symbol></svg>`
    const result = importHtml(`${symbol}<svg>${repeat(3000, '<use href="#s"/>')}</svg>`)
    expect(result.unresolvedSvgRefs).toEqual(['#s'])
  })

  it('reports a missing symbol only once across repeated instances', () => {
    const ids = repeat(1, Array.from({ length: 5000 }, (_v, i) => `<i id="n${i}"></i>`).join(''))
    const result = importHtml(`<div>${ids}</div><svg>${repeat(3000, '<use href="#nope"/>')}</svg>`)
    expect(result.unresolvedSvgRefs).toEqual(['#nope'])
  })
})

describe('sprite copies and the page around them', () => {
  it('never reuses an id the page already has, and differs between imports', () => {
    const page = '<div id="g-1"></div><div id="g-2"></div>'
      + '<svg hidden><symbol id="i"><linearGradient id="g"/><rect fill="url(#g)"/></symbol></svg>'
      + '<svg class="x"><use href="#i"/></svg>'
    const copyId = (markup: string) => markup.match(/<linearGradient id="([^"]+)"/)?.[1]
    const first = copyId(svgMarkup(page).find((m) => m.includes('linearGradient') && !m.includes('symbol'))!)
    const second = copyId(svgMarkup(page).find((m) => m.includes('linearGradient') && !m.includes('symbol'))!)
    expect(first).toBeDefined()
    expect(['g', 'g-1', 'g-2']).not.toContain(first)
    expect(first).not.toBe(second)
  })

  it('preserves root paint and ID selectors for each instance of an external symbol', () => {
    const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="paint"/></defs>'
      + '<symbol id="icon" fill="url(#paint)"><style>#dot { opacity: .5 }</style><circle id="dot"/></symbol></svg>'
    const result = importHtml('<svg><use href="icons.svg#icon"/><use href="icons.svg#icon"/></svg>', { loadSvgSprite: () => sprite })
    const svg = String(Object.values(result.nodes).find((node) => node.moduleId === 'base.svg')!.props.svg)
    const gradients = [...svg.matchAll(/<linearGradient id="([^"]+)"/g)]
    const circles = [...svg.matchAll(/<circle id="([^"]+)"/g)]
    expect(gradients).toHaveLength(2)
    expect(circles).toHaveLength(2)
    for (const [, id] of gradients) expect(svg).toContain(`fill="url(#${id})"`)
    for (const [, id] of circles) expect(result.styleCss).toContain(`#${id} { opacity: .5 }`)
  })

  it('rewrites SMIL timing references to the renamed ids', () => {
    const page = '<svg hidden><symbol id="i"><circle r="1">'
      + '<animate id="a1" attributeName="r" dur="1s"/><animate attributeName="r" begin="a1.end; a1.begin+1s" dur="1s"/>'
      + '</circle></symbol></svg><svg class="x"><use href="#i"/></svg>'
    const copy = svgMarkup(page).find((m) => !m.includes('symbol'))!
    const id = copy.match(/<animate id="([^"]+)"/)?.[1]
    expect(id).not.toBe('a1')
    expect(copy).toContain(`begin="${id}.end; ${id}.begin+1s"`)
  })

  it('leaves an anchor inside a symbol alone instead of copying page markup into defs', () => {
    const page = '<section id="pricing"><p>Plans</p></section>'
      + '<svg hidden><symbol id="i"><a href="#pricing"><rect/></a></symbol></svg><svg class="x"><use href="#i"/></svg>'
    const copy = importHtml(page)
    const markup = Object.values(copy.nodes).map((n) => String(n.props.svg ?? '')).find((m) => m.startsWith('<svg class') || m.startsWith('<svg>') && !m.includes('symbol'))!
    expect(markup).not.toContain('<defs>')
    expect(markup).toContain('href="#pricing"')
  })

  it('resolves a nested sprite file relative to the sprite that names it', () => {
    const requested: string[] = []
    const files: Record<string, string> = {
      'icons/set.svg': '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a"><use href="more.svg#b"/></symbol></svg>',
      'icons/more.svg': '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="b"><rect width="2"/></symbol></svg>',
    }
    const result = importHtml('<svg><use href="icons/set.svg#a"/></svg>', {
      loadSvgSprite: (path) => {
        requested.push(path)
        return files[path] ?? null
      },
    })
    expect(requested).toEqual(['icons/set.svg', 'icons/more.svg'])
    expect(result.unresolvedSvgRefs).toEqual([])
  })

  it('inlines the shape itself for a <use> inside <clipPath>', () => {
    const page = '<svg><defs><rect id="r" width="4" height="4"/>'
      + '<clipPath id="c"><use href="#r" x="1"/></clipPath></defs><circle clip-path="url(#c)"/></svg>'
    const markup = svgMarkup(page)[0]!
    expect(markup).toMatch(/<clipPath id="c"><rect [^>]*transform="translate\(1 0\)"[^>]*><\/rect><\/clipPath>/)
  })

  it('carries a symbol\'s <style> into the page once, however many copies', () => {
    const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i"><style>.dot { fill: red }</style><circle class="dot"/></symbol></svg>'
    const result = importHtml(`<svg>${repeat(3, '<use href="s.svg#i"/>')}</svg>`, { loadSvgSprite: () => sprite })
    expect(result.styleCss.match(/\.dot/g)).toHaveLength(1)
  })
})

describe('sprite inlining round three', () => {
  it('copies a page element as parsed, not as an earlier expansion grew it', () => {
    // <g id="a"> holds a rendered use that expands in place; copies of #a must
    // come from the page as parsed, so they stay small and the output bounded.
    // The first use of #a sees it small; then its own <use> expands in place.
    const page = `<svg hidden><symbol id="s">${repeat(20, '<rect/>')}</symbol></svg>`
      + '<svg><use href="#a"/></svg><svg><g id="a"><use href="#s"/></g></svg>'
      + `<svg>${repeat(1990, '<use href="#a"/>')}</svg>`
    const result = importHtml(page)
    const rects = Object.values(result.nodes).reduce((sum, n) => sum + (String(n.props.svg ?? '').match(/<rect/g)?.length ?? 0), 0)
    expect(rects).toBeLessThanOrEqual(20000)
  })

  it('copies a long chain of gradient templates in linear time', () => {
    const gradients = Array.from({ length: 4900 }, (_v, i) =>
      i === 0 ? '<linearGradient id="g0"/>' : `<linearGradient id="g${i}" href="#g${i - 1}"/>`).join('')
    const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${gradients}</defs>`
      + '<symbol id="i"><style>.x { fill: url(#g4899) }</style><rect class="x" fill="url(#g4899)"/></symbol></svg>'
    const result = importHtml('<svg><use href="s.svg#i"/></svg>', { loadSvgSprite: () => sprite })
    expect(result.unresolvedSvgRefs).toEqual([])
  })

  it('parses a sprite once however its path is spelled', () => {
    let loads = 0
    const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i"><rect/></symbol></svg>'
    const uses = Array.from({ length: 30 }, (_v, i) => `<use href="${i % 2 ? `./s.svg?v=${i}` : `s.svg?${i}`}#i"/>`).join('')
    const requested = new Set<string>()
    importHtml(`<svg>${uses}</svg>`, {
      loadSvgSprite: (path) => {
        loads += 1
        requested.add(path)
        return sprite
      },
    })
    expect(loads).toBe(1)
    expect([...requested]).toEqual(['s.svg'])
  })

  it('copies a symbol used inside <mask> as a <g>, like anywhere a group may stand', () => {
    const markup = svgMarkup('<svg hidden><symbol id="s"><rect/></symbol></svg>'
      + '<svg class="x"><mask id="m"><use href="#s"/></mask></svg>').find((m) => m.includes('<mask'))!
    expect(markup).toContain('<mask id="m"><svg>')
  })

  it('leaves a clock value alone when a copy has an id that looks like a number', () => {
    const copy = svgMarkup('<svg hidden><symbol id="i"><circle><animate id="0" dur="1s"/>'
      + '<animate begin="0.5s; 0.end" dur="1s"/></circle></symbol></svg><svg class="x"><use href="#i"/></svg>')
      .find((m) => !m.includes('symbol'))!
    const id = copy.match(/<animate id="([^"]+)"/)?.[1]
    expect(copy).toContain(`begin="0.5s; ${id}.end"`)
  })

  it('resolves a sprite named inside a root-relative sprite against that sprite', () => {
    const requested: string[] = []
    importHtml('<svg><use href="/icons/set.svg#a"/></svg>', {
      loadSvgSprite: (path) => {
        requested.push(path)
        return path === '/icons/set.svg'
          ? '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="a"><use href="more.svg#b"/></symbol></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="b"><rect/></symbol></svg>'
      },
    })
    expect(requested).toEqual(['/icons/set.svg', '/icons/more.svg'])
  })

  it('renames ARIA id lists and the ids and url() refs in a kept <style>, and copies defs a <style> names', () => {
    const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs>'
      + '<symbol id="i"><style>#t { fill: url(#g) }</style><title id="t">Logo</title>'
      + '<g aria-labelledby="t"><rect/></g></symbol></svg>'
    const result = importHtml('<svg><use href="s.svg#i"/></svg>', { loadSvgSprite: () => sprite })
    const copy = String(Object.values(result.nodes).find((n) => n.moduleId === 'base.svg')!.props.svg)
    const titleId = copy.match(/<title id="([^"]+)"/)?.[1]
    const gradientId = copy.match(/<linearGradient id="([^"]+)"/)?.[1]
    expect(titleId).not.toBe('t')
    expect(copy).toContain(`aria-labelledby="${titleId}"`)
    // The kept <style> leaves the markup as page CSS (`styleCss`), renamed.
    expect(result.styleCss).toContain(`#${titleId} { fill: url(#${gradientId}) }`)
  })

  it('copies the targets of <mpath>, <feImage>, animations and a <textPath> on a basic shape', () => {
    const sprite = '<svg xmlns="http://www.w3.org/2000/svg"><defs>'
      + '<path id="track" d="M0 0h9"/><circle id="ring" r="4"/><rect id="blob"/><g id="spin"><rect/></g>'
      + '</defs><symbol id="i"><circle r="1"><animateMotion dur="1s"><mpath href="#track"/></animateMotion></circle>'
      + '<filter id="f"><feImage href="#blob"/></filter><animateTransform href="#spin" attributeName="transform" type="rotate"/>'
      + '<text><textPath href="#ring">Hi</textPath></text></symbol></svg>'
    const copy = svgMarkup('<svg><use href="s.svg#i"/></svg>', () => sprite)[0]!
    for (const tag of ['<path id="track-', '<circle id="ring-', '<rect id="blob-', '<g id="spin-']) expect(copy).toContain(tag)
  })
})

describe('every reviewer probe stays bounded', () => {
  const chain = () => {
    const uses = (id: string) => repeat(12, `<use href="#${id}"/>`)
    const symbols = ['<symbol id="s0"><rect/></symbol>']
    for (let level = 1; level <= 5; level += 1) symbols.push(`<symbol id="s${level}">${uses(`s${level - 1}`)}</symbol>`)
    return `<svg hidden>${symbols.join('')}</svg><svg>${uses('s5')}</svg>`
  }
  const gradientSprite = `<svg xmlns="http://www.w3.org/2000/svg"><defs>${
    Array.from({ length: 4900 }, (_v, i) => (i ? `<linearGradient id="g${i}" href="#g${i - 1}"/>` : '<linearGradient id="g0"/>')).join('')
  }</defs><symbol id="i"><style>.x { fill: url(#g4899) }</style><rect class="x" fill="url(#g4899)"/></symbol></svg>`
  const bigSprite = `<svg xmlns="http://www.w3.org/2000/svg"><symbol id="i"><rect/></symbol>${repeat(20000, '<rect/>')}</svg>`

  const probes: Array<[string, string, ((path: string) => string | null)?]> = [
    ['chained symbols, 12 uses five deep', chain()],
    ['6 000-element symbol, 3 000 uses',
      `<svg hidden><symbol id="s">${repeat(6000, '<rect/>')}</symbol></svg><svg>${repeat(3000, '<use href="#s"/>')}</svg>`],
    ['2 000-element symbol, 5 000 uses',
      `<svg hidden><symbol id="s">${repeat(2000, '<rect/>')}</symbol></svg><svg>${repeat(5000, '<use href="#s"/>')}</svg>`],
    ['20 000 ids, 5 000 unresolved uses',
      `<div>${Array.from({ length: 20000 }, (_v, i) => `<i id="n${i}"></i>`).join('')}</div><svg>${repeat(5000, '<use href="#nope"/>')}</svg>`],
    ['growing page group, 1 990 uses',
      `<svg hidden><symbol id="s">${repeat(500, '<rect/>')}</symbol></svg><svg><use href="#a"/></svg>`
      + `<svg><g id="a">${repeat(5, '<use href="#s"/>')}</g></svg><svg>${repeat(1990, '<use href="#a"/>')}</svg>`],
    ['4 900 chained gradients via fill and <style>', `<svg>${repeat(50, '<use href="s.svg#i"/>')}</svg>`, () => gradientSprite],
    ['300 spellings of a 20 000-element sprite',
      `<svg>${Array.from({ length: 300 }, (_v, i) => `<use href="${i % 2 ? './' : ''}s.svg?${i}#i"/>`).join('')}</svg>`,
      () => bigSprite],
  ]

  const elementCount = (markup: string) => markup.match(/<[a-zA-Z]/g)?.length ?? 0

  for (const [name, source, loadSvgSprite] of probes) {
    it(`${name}: at most 20 000 elements added`, () => {
      const result = importHtml(source, { loadSvgSprite })
      const output = Object.values(result.nodes).reduce((sum, n) => sum + elementCount(String(n.props.svg ?? '')), 0)
      expect(output - elementCount(source)).toBeLessThanOrEqual(20000)
    })
  }
})
