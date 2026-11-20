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
    const big = `<svg hidden><symbol id="big">${repeat(6000, '<rect width="1" height="1"/>')}</symbol></svg>`
    const result = importHtml(`${big}<svg>${repeat(3000, '<use href="#big"/>')}</svg>`)
    expect(result.unresolvedSvgRefs).toEqual(['#big'])
  })

  it('stays fast when the budget runs out with many uses left', () => {
    const symbol = `<svg hidden><symbol id="s">${repeat(2000, '<rect width="1" height="1"/>')}</symbol></svg>`
    const started = performance.now()
    importHtml(`${symbol}<svg>${repeat(3000, '<use href="#s"/>')}</svg>`)
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('stays fast for many unresolved uses on a page with many ids', () => {
    const ids = repeat(1, Array.from({ length: 5000 }, (_v, i) => `<i id="n${i}"></i>`).join(''))
    const started = performance.now()
    const result = importHtml(`<div>${ids}</div><svg>${repeat(3000, '<use href="#nope"/>')}</svg>`)
    expect(performance.now() - started).toBeLessThan(1500)
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
