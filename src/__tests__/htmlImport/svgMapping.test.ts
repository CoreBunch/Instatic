/**
 * svgMapping.test.ts — inline-SVG import + anchor recursion.
 *
 * Covers the SVG-support feature: inline `<svg>` maps to base.svg with its
 * markup preserved, and an anchor wrapping an icon recurses so the icon
 * survives (text-only anchors stay leaves).
 */

import { describe, it, expect } from 'bun:test'
import '@modules/base'
import type { PageNode } from '@core/page-tree'
import { importHtml } from '@core/htmlImport'

function single(html: string): PageNode {
  const result = importHtml(html)
  expect(result.rootIds).toHaveLength(1)
  return result.nodes[result.rootIds[0]!]!
}

describe('inline <svg> → base.svg', () => {
  it('maps a standalone <svg> to base.svg', () => {
    const node = single('<svg viewBox="0 0 24 24"><path d="M1 1h22"/></svg>')
    expect(node.moduleId).toBe('base.svg')
  })

  it('captures the full SVG markup verbatim in the `svg` prop', () => {
    const node = single('<svg viewBox="0 0 24 24"><path d="M1 1h22"/></svg>')
    expect(String(node.props.svg)).toContain('<svg')
    expect(String(node.props.svg)).toContain('viewBox="0 0 24 24"')
    expect(String(node.props.svg)).toContain('<path')
    expect(String(node.props.svg)).toContain('d="M1 1h22"')
  })

  it('preserves the class on the node for styling', () => {
    const node = single('<svg class="brand-mark" viewBox="0 0 24 24"><circle r="5"/></svg>')
    expect(node.classIds).toContain('brand-mark')
  })

  it('does NOT recurse into <path>/<circle> as separate nodes', () => {
    const result = importHtml('<svg viewBox="0 0 24 24"><path d="M1 1"/></svg>')
    // Exactly one node (the svg) — children live in the markup string.
    expect(Object.keys(result.nodes)).toHaveLength(1)
  })

  it('reads aria-label into the `title` prop', () => {
    const node = single('<svg aria-label="Company logo" viewBox="0 0 24 24"><path d="M1 1"/></svg>')
    expect(node.props.title).toBe('Company logo')
  })
})

describe('anchor recursion preserves nested icons', () => {
  it('an <a> wrapping an <svg> + text recurses (base.link with children)', () => {
    const node = single('<a class="brand" href="/"><svg viewBox="0 0 24 24"><path d="M1 1"/></svg> instatic</a>')
    expect(node.moduleId).toBe('base.link')
    expect(node.children.length).toBeGreaterThan(0)
  })

  it('the nested <svg> becomes a base.svg child node', () => {
    const result = importHtml('<a href="/"><svg viewBox="0 0 24 24"><path d="M1 1"/></svg> brand</a>')
    const link = result.nodes[result.rootIds[0]!]!
    const childModules = link.children.map((id) => result.nodes[id]!.moduleId)
    expect(childModules).toContain('base.svg')
  })

  it('a text-only <a> stays a LEAF using its text prop (no children)', () => {
    const node = single('<a href="https://example.com">Visit us</a>')
    expect(node.moduleId).toBe('base.link')
    expect(node.children).toHaveLength(0)
    expect(node.props.text).toBe('Visit us')
  })

  it('a <a> wrapping element children recurses and drops the flattened text prop (no double-represent)', () => {
    // The loop-link case: an anchor wrapping inline spans/tokens must carry its
    // content as child nodes only — never ALSO a flattened `text` prop.
    const result = importHtml('<a href="/p"><span>PAGE</span> <span>title</span></a>')
    const link = result.nodes[result.rootIds[0]!]!
    expect(link.moduleId).toBe('base.link')
    expect(link.children.length).toBeGreaterThan(0)
    expect('text' in link.props).toBe(false)
  })

  it('a btn-classed anchor stays base.button (icon not preserved — buttons are leaves)', () => {
    const node = single('<a class="btn" href="/x"><svg viewBox="0 0 24 24"></svg> Go</a>')
    expect(node.moduleId).toBe('base.button')
    expect(node.children).toHaveLength(0)
  })
})
