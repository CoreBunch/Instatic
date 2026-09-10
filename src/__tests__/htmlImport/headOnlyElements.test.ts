/**
 * #490 — a payload the parser places entirely in `<head>` (a bare
 * `<link rel="icon">` is the reported case) produced an empty fragment and
 * nothing that said why. `importHtml` now reports those tags as `headOnly`
 * so callers can name them.
 */
import { describe, expect, it } from 'bun:test'
import '@modules/base'
import { importHtml } from '@core/htmlImport'

describe('importHtml head-only elements', () => {
  it('reports head elements by tag, deduplicated, in document order', () => {
    const result = importHtml(
      '<!doctype html><html><head><title>T</title><link rel="icon" href="/favicon.svg">'
      + '<meta charset="utf-8"><link rel="stylesheet" href="x.css"><base href="/"></head><body></body></html>',
    )
    expect(result.rootIds).toEqual([])
    expect(result.headOnly).toEqual(['title', 'link', 'meta', 'base'])
  })

  it('does not list scripts and styles twice: they have their own report', () => {
    const result = importHtml(
      '<html><head><script>1</script><style>.a{color:red}</style><meta name="x" content="y"></head><body><p>hi</p></body></html>',
    )
    expect(result.stripped.scripts).toBe(1)
    expect(result.styleCss).toContain('.a')
    expect(result.headOnly).toEqual(['meta'])
    expect(result.rootIds).toHaveLength(1)
  })

  it('is empty for ordinary body markup', () => {
    expect(importHtml('<section><h1>Hi</h1></section>').headOnly).toEqual([])
  })
})
