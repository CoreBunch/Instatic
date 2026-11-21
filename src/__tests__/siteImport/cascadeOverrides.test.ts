/**
 * A shared kit stylesheet plus a page's own overrides.
 *
 * The instatic.com import linked `shared/kit.css` on every page and restyled
 * some kit classes in `bake/style.css` (home) and `account/account.css`
 * (account). Every resolution of the resulting conflicts lost something: skip
 * and overwrite dropped fragments, and rename split the class off the kit's
 * own selectors (`.btn .icon`). The bar: after import, every page renders as
 * its source did; no silent drops, no silent site-wide leaks.
 *
 * `effective()` stands in for the browser: it merges, in final plan order,
 * every bare `.x` rule matching an element's classes, exactly what one global
 * stylesheet does to that element.
 */
import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { applyConflictResolutions, buildImportPlan } from '@core/siteImport'
import type { CrossSheetClassConflict, FileMap, ImportPlan } from '@core/siteImport'
import { makeSite } from '../fixtures'

const enc = new TextEncoder()
const file = (text: string) => ({ bytes: enc.encode(text), mimeType: '' })
const page = (sheets: string[], body = '<a class="btn">Go</a>', head = '') =>
  `<!doctype html><html><head>${sheets.map((s) => `<link rel="stylesheet" href="${s}">`).join('')}${head}</head>`
  + `<body>${body}</body></html>`

const KIT = '.btn { color: black; font-weight: 700 }\n.btn .icon { width: 1em }\n.card { opacity: 0.5 }\n'

function plan(files: Record<string, string>, currentSite = makeSite()): ImportPlan {
  const fileMap: FileMap = { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, file(v)])) }
  return buildImportPlan({ fileMap, currentSite })
}

function resolve(p: ImportPlan, action?: 'skip' | 'overwrite'): ImportPlan {
  const cross: CrossSheetClassConflict[] = p.conflicts.crossSheetClasses.map((c) =>
    action ? { ...c, defaultResolution: { action } } : c,
  )
  return applyConflictResolutions(p, p.conflicts.pages, p.conflicts.rules, p.conflicts.tokens, cross)
}

/** Classes on the first element of `source` carrying `name` (or a rename of it) after resolution. */
function classesOf(p: ImportPlan, source: string, name: string): string[] {
  const pagePlan = p.pages.find((pg) => pg.source === source)!
  const node = Object.values(pagePlan.nodeFragment.nodes).find((n) =>
    n.classIds?.some((c) => c === name || /^-\d+$/.test(c.slice(name.length)) && c.startsWith(name)),
  )
  return node?.classIds ?? []
}

function effective(p: ImportPlan, source: string, name: string): Record<string, unknown> {
  const classes = classesOf(p, source, name)
  const out: Record<string, unknown> = {}
  for (const rule of p.styleRules) {
    const bare = /^\.([\w-]+)$/.exec(rule.selector)
    if (bare && classes.includes(bare[1])) Object.assign(out, rule.styles)
  }
  return out
}

describe('cross-sheet cascade: shared kit + page overrides', () => {
  it('confines each page override by default, keeping the kit class and every rule', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], '<a class="btn">Go</a><div class="card">C</div>'),
      'account.html': page(['kit.css', 'account.css'], '<a class="btn">Go</a><div class="card">C</div>'),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
      'account.css': '.card { opacity: 1 }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.kind, c.desiredName, c.sources])).toEqual([
      ['leak', 'btn', ['home.css']],
      ['leak', 'card', ['account.css']],
    ])
    const r = resolve(p)
    expect(r.styleRules).toHaveLength(p.styleRules.length)
    expect(r.styleRules.map((rule) => rule.selector)).toContain('.btn .icon')
    expect(classesOf(r, 'home.html', 'btn')).toEqual(['btn', 'btn-2'])
    expect(effective(r, 'home.html', 'btn')).toEqual({ color: 'red', fontWeight: '700' })
    expect(effective(r, 'account.html', 'btn')).toEqual({ color: 'black', fontWeight: '700' })
    expect(effective(r, 'account.html', 'card')).toEqual({ opacity: '1' })
    expect(effective(r, 'home.html', 'card')).toEqual({ opacity: '0.5' })
  })

  it('preserves authored order for overlapping conditional declarations', () => {
    const p = resolve(plan({
      'home.html': page(['home.css'], '<div class="stage"></div>'),
      'home.css': [
        '.stage { display: block }',
        '@media (max-width: 1279px) { .stage { aspect-ratio: 5 / 2 } }',
        '@media (max-width: 699px) { .stage { aspect-ratio: 5 / 4 } }',
        '@media (max-width: 479px) { .stage { aspect-ratio: 4 / 5 } }',
      ].join('\n'),
    }))
    expect(p.styleRules.filter((rule) => rule.selector === '.stage')
      .flatMap((rule) => Object.values(rule.contextStyles).map((bag) => bag.aspectRatio)))
      .toEqual(['5 / 2', '5 / 4', '4 / 5'])
  })

  it('reserves HTML-only class names when allocating suffixes', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css']),
      'account.html': page(['kit.css'], '<span class="btn btn-2">Account</span>'),
      'kit.css': KIT,
      'home.css': '.btn { color: red }',
    })
    expect(p.conflicts.crossSheetClasses[0].defaultResolution.resolvedName).toBe('btn-3')
    expect(effective(resolve(p), 'account.html', 'btn').color).toBe('black')
  })

  it('keeps two pages that override the same class each on their own value', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css']),
      'account.html': page(['kit.css', 'account.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
      'account.css': '.btn { color: blue }\n',
    })
    expect(p.conflicts.crossSheetClasses).toHaveLength(2)
    const r = resolve(p)
    expect(effective(r, 'home.html', 'btn').color).toBe('red')
    expect(effective(r, 'account.html', 'btn').color).toBe('blue')
  })

  it('raises a row when a kit-only page uses the class, and keeps that page on the kit', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css']),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => c.kind)).toEqual(['leak'])
    const r = resolve(p)
    expect(effective(r, 'about.html', 'btn').color).toBe('black')
    expect(effective(r, 'home.html', 'btn').color).toBe('red')
  })

  it('confines an inline <style> override the same way', () => {
    const p = plan({
      'home.html': page(['kit.css'], '<a class="btn">Go</a>', '<style>.btn { color: red }</style>'),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.kind, c.sources])).toEqual([
      ['leak', ['home.html::inline']],
    ])
    const r = resolve(p)
    expect(effective(r, 'about.html', 'btn').color).toBe('black')
    expect(effective(r, 'home.html', 'btn').color).toBe('red')
  })

  it('shows no row when no page that skips the override uses the class', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css']),
      'about.html': page(['kit.css'], '<p>No buttons here</p>'),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    })
    expect(p.conflicts.crossSheetClasses).toEqual([])
    const r = resolve(p)
    expect(r.styleRules).toHaveLength(p.styleRules.length)
    expect(effective(r, 'home.html', 'btn').color).toBe('red')
  })

  it('counts a class a page script adds as used on that page', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css']),
      'about.html': page(['kit.css'], '<p>None</p><script>document.body.classList.add("btn")</script>'),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => c.kind)).toEqual(['leak'])
  })

  it('does not count a selector string in a script as using the class', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css']),
      'about.html': page(['kit.css'], '<p>None</p><script>document.querySelector(".btn")</script>'),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    })
    expect(p.conflicts.crossSheetClasses).toEqual([])
  })

  it('keeps the rules global by default when the sheet page script writes the class into HTML', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], '<a class="btn">Go</a><script>list.innerHTML = `<a class="btn">${x}</a>`</script>'),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.kind, c.defaultResolution.action])).toEqual([
      ['leak', 'overwrite'],
    ])
  })

  it('skip drops only the override, overwrite applies it everywhere, both on request', () => {
    const files = {
      'home.html': page(['kit.css', 'home.css']),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    }
    const skipped = resolve(plan(files), 'skip')
    expect(effective(skipped, 'home.html', 'btn').color).toBe('black')
    const overwritten = resolve(plan(files), 'overwrite')
    expect(effective(overwritten, 'about.html', 'btn').color).toBe('red')
  })

  it('keeps a sheet loaded before the kit underneath the kit on its page', () => {
    const p = plan({
      'home.html': page(['home.css', 'kit.css']),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red; opacity: 0.5 }\n',
    })
    expect(p.conflicts.crossSheetClasses.length).toBeGreaterThan(0)
    const r = resolve(p)
    expect(effective(r, 'home.html', 'btn').color).toBe('black')
    expect(effective(r, 'home.html', 'btn').opacity).toBe('0.5')
    expect(effective(r, 'about.html', 'btn')).toEqual({ color: 'black', fontWeight: '700' })
  })

  it('confines a class only one page sheet styles from a page that uses it unstyled', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], '<div class="seats">S</div>'),
      'account.html': page(['kit.css'], '<div class="seats">S</div>'),
      'kit.css': KIT,
      'home.css': '.seats { opacity: 0.5 }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.kind, c.desiredName, c.sources])).toEqual([
      ['leak', 'seats', ['home.css']],
    ])
    const r = resolve(p)
    expect(effective(r, 'account.html', 'seats')).toEqual({})
    expect(effective(r, 'home.html', 'seats')).toEqual({ opacity: '0.5' })
  })

  it('falls back to divergent rows when pages load the sheets in conflicting orders', () => {
    const p = plan({
      'a.html': page(['kit.css', 'x.css', 'y.css']),
      'b.html': page(['kit.css', 'y.css', 'x.css']),
      'kit.css': KIT,
      'x.css': '.btn { color: red }\n',
      'y.css': '.btn { color: blue }\n',
    })
    expect(p.conflicts.crossSheetClasses.length).toBeGreaterThan(0)
    expect(p.conflicts.crossSheetClasses.every((c) => c.kind === 'divergent')).toBe(true)
  })

  it('keeps unrelated per-page definitions each on their own page', () => {
    const p = plan({
      'home.html': page(['home.css']),
      'account.html': page(['account.css']),
      'home.css': '.btn { color: red }\n',
      'account.css': '.btn { color: blue }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.kind, c.desiredName])).toEqual([
      ['leak', 'btn'],
      ['leak', 'btn'],
    ])
    const r = resolve(p)
    expect(effective(r, 'home.html', 'btn').color).toBe('red')
    expect(effective(r, 'account.html', 'btn').color).toBe('blue')
  })

  it('rewrites the class in every selector of the confined sheet and keeps its contexts', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], '<div class="card"><a class="btn x">Go</a></div>'),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n.btn:hover { color: maroon }\n.card .btn { opacity: 0.9 }\n'
        + '.x:not(.btn) { margin-top: 1px }\n@media (max-width: 600px) { .btn { color: pink } }\n',
    })
    const r = resolve(p)
    const fromHome = r.styleRules.filter((_, i) => r.styleRuleSources[i] === 'home.css')
    const selectors = fromHome.map((rule) => rule.selector)
    expect(selectors.some((sel) => /\.btn(?![-\w])/.test(sel))).toBe(false)
    expect(selectors).toEqual(expect.arrayContaining(['.btn-2', '.card .btn-2', '.x:not(.btn-2)']))
    expect(JSON.stringify(fromHome)).toContain('pink')
    // The kit's bare class keeps its own rules for about.html.
    expect(effective(r, 'about.html', 'btn')).toEqual({ color: 'black', fontWeight: '700' })
  })

  it('skip drops every rule of the sheet that names the class, not just its class rules', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], '<div class="card"><a class="btn">Go</a></div>'),
      'about.html': page(['kit.css']),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n.btn:hover { color: maroon }\n.card .btn { opacity: 0.9 }\n.card { margin-top: 2px }\n',
    })
    const btnRow = p.conflicts.crossSheetClasses.find((c) => c.desiredName === 'btn')!
    const r = applyConflictResolutions(p, [], [], [], [{ ...btnRow, defaultResolution: { action: 'skip' } }])
    const fromHome = r.styleRules.filter((_, i) => r.styleRuleSources[i] === 'home.css').map((rule) => rule.selector)
    expect(fromHome).toEqual(['.card'])
  })

  it('carries the new name into inline SVG markup on the sheet pages', () => {
    const svg = '<svg class="icon"><g class="icon"><path d="M0 0h1v1z"/></g></svg>'
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], svg),
      'about.html': page(['kit.css'], svg),
      'kit.css': '.icon { width: 1em }\n',
      'home.css': '.icon { width: 2em }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.desiredName, c.defaultResolution.action])).toEqual([
      ['icon', 'auto-rename'],
    ])
    const r = resolve(p)
    const svgNode = (source: string) => Object.values(r.pages.find((pg) => pg.source === source)!.nodeFragment.nodes)
      .find((n) => n.moduleId === 'base.svg')!
    expect(svgNode('home.html').classIds).toEqual(['icon', 'icon-2'])
    expect(svgNode('about.html').classIds).toEqual(['icon'])
    expect(svgNode('home.html').props.svg).toContain('<g class="icon icon-2">')
    expect(svgNode('about.html').props.svg).toContain('<g class="icon">')
  })

  it('reads any bare class token in a script string as a use, and keeps those rules global', () => {
    const p = plan({
      'home.html': page(['kit.css', 'home.css'], '<a class="btn">Go</a><script>$(el).toggleClass("btn")</script>'),
      'about.html': page(['kit.css'], '<p>None</p><script>$(el).addClass(open ? "btn" : "")</script>'),
      'kit.css': KIT,
      'home.css': '.btn { color: red }\n',
    })
    expect(p.conflicts.crossSheetClasses.map((c) => [c.kind, c.defaultResolution.action])).toEqual([
      ['leak', 'overwrite'],
    ])
  })

  it('never gives a cross-sheet row and a site class row the same new name', () => {
    const site = makeSite({
      styleRules: {
        existing: {
          id: 'existing', name: 'btn', kind: 'class', selector: '.btn', order: 0,
          styles: { color: 'green' }, contextStyles: {}, createdAt: 0, updatedAt: 0,
        },
      },
    })
    const p = plan({
      'a.html': page(['kit.css', 'a.css']),
      'b.html': page(['kit.css']),
      'kit.css': KIT,
      'a.css': '.btn { color: red }\n',
    }, site)
    const cross = p.conflicts.crossSheetClasses.map((c) => c.defaultResolution.resolvedName)
    const rules = p.conflicts.rules.map((c) => c.defaultResolution.resolvedName)
    expect(cross).toEqual(['btn-2'])
    expect(rules).toEqual(['btn-3'])
    const r = resolve(p)
    expect(classesOf(r, 'b.html', 'btn')).toEqual(['btn-3'])
    expect(effective(r, 'b.html', 'btn')).toEqual({ color: 'black', fontWeight: '700' })
    expect(effective(r, 'a.html', 'btn')).toEqual({ color: 'red', fontWeight: '700' })
  })
})
