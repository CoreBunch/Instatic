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

function plan(files: Record<string, string>): ImportPlan {
  const fileMap: FileMap = { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, file(v)])) }
  return buildImportPlan({ fileMap, currentSite: makeSite() })
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
})
