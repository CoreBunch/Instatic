/**
 * Script load order across imported pages (#403).
 *
 * Every imported script gets ONE `priority` in `site.runtime.scripts`, and the
 * renderer sorts a page's scripts by it. A page's own document order therefore
 * has to be expressible by that single number — which a per-file counter that
 * numbers a script only on first sight cannot do once two pages share a file.
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import { buildImportPlan } from '@core/siteImport'
import type { FileMap, ImportPlan } from '@core/siteImport'
import { makeEmptySiteDocument } from './mockSite'

const enc = new TextEncoder()

function html(body: string): FileMap['files'][string] {
  return {
    bytes: enc.encode(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`),
    mimeType: 'text/html',
  }
}

function js(source: string): FileMap['files'][string] {
  return { bytes: enc.encode(source), mimeType: 'text/javascript' }
}

function plan(files: FileMap['files']): ImportPlan {
  return buildImportPlan({ fileMap: { files }, currentSite: makeEmptySiteDocument() })
}

function priorityOf(p: ImportPlan, path: string): number {
  const script = p.scripts.find((s) => s.path === path)
  if (!script) throw new Error(`script ${path} missing from plan`)
  return script.priority
}

describe('buildImportPlan — script order across pages', () => {
  it('a script shared by two pages loads after the dependency another page links before it', () => {
    // `about.html` sorts first and links only app.js; `index.html` says
    // vendor.js has to come first. The plan must honour index.html's order.
    const p = plan({
      'about.html': html('<script src="js/app.js"></script>'),
      'index.html': html('<script src="js/vendor.js"></script><script src="js/app.js"></script>'),
      'js/app.js': js('window.App = window.Vendor.create()'),
      'js/vendor.js': js('window.Vendor = { create() { return {} } }'),
    })

    expect(priorityOf(p, 'js/vendor.js')).toBeLessThan(priorityOf(p, 'js/app.js'))
    expect(p.warnings.filter((w) => w.kind === 'script-order-conflict')).toEqual([])
  })

  it('an inline config script on a later page still precedes the shared script that reads it', () => {
    // A WordPress theme inlines its `wp_localize_script` blob on every page
    // before theme.js. Both blobs are new on their own page, so a first-seen
    // counter numbers the second one after theme.js.
    const p = plan({
      'about.html': html('<script>var themeConfig = { page: "about" }</script><script src="js/theme.js"></script>'),
      'index.html': html('<script>var themeConfig = { page: "index" }</script><script src="js/theme.js"></script>'),
      'js/theme.js': js('init(themeConfig)'),
    })

    const theme = priorityOf(p, 'js/theme.js')
    expect(priorityOf(p, 'about.html-inline-script-1.js')).toBeLessThan(theme)
    expect(priorityOf(p, 'index.html-inline-script-1.js')).toBeLessThan(theme)
  })

  it('pages that genuinely disagree keep the first page\'s order and say so', () => {
    const p = plan({
      'about.html': html('<script src="js/a.js"></script><script src="js/b.js"></script>'),
      'index.html': html('<script src="js/b.js"></script><script src="js/a.js"></script>'),
      'js/a.js': js('// a'),
      'js/b.js': js('// b'),
    })

    expect(priorityOf(p, 'js/a.js')).toBeLessThan(priorityOf(p, 'js/b.js'))
    const conflicts = p.warnings.filter((w) => w.kind === 'script-order-conflict')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.message).toContain('js/a.js')
    expect(conflicts[0]!.message).toContain('js/b.js')
  })

  it('assigns unique ascending priorities that respect every page\'s document order', () => {
    const p = plan({
      'a.html': html('<script src="js/one.js"></script><script src="js/three.js"></script>'),
      'b.html': html('<script src="js/two.js"></script><script src="js/three.js"></script>'),
      'c.html': html('<script src="js/three.js"></script><script src="js/four.js"></script>'),
      'js/one.js': js('// 1'),
      'js/two.js': js('// 2'),
      'js/three.js': js('// 3'),
      'js/four.js': js('// 4'),
    })

    const priorities = p.scripts.map((s) => s.priority)
    expect(new Set(priorities).size).toBe(priorities.length)
    expect(priorityOf(p, 'js/one.js')).toBeLessThan(priorityOf(p, 'js/three.js'))
    expect(priorityOf(p, 'js/two.js')).toBeLessThan(priorityOf(p, 'js/three.js'))
    expect(priorityOf(p, 'js/three.js')).toBeLessThan(priorityOf(p, 'js/four.js'))
  })
})
