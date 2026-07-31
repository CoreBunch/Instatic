/**
 * An unresolvable loop reference is reported at import time.
 *
 * `<instatic-loop data-source-id="posts">` — a table slug where a source id
 * belongs — used to import cleanly. The id was copied verbatim into props, the
 * document persisted intact, and at publish `loopPrefetch` turned the
 * unregistered source into a well-formed empty page, indistinguishable from
 * "this table has no rows". The section rendered as nothing and every gate
 * passed, because the route still returned 200 with a title and an h1.
 *
 * The registry these are checked against is the same one `site_list_loop_sources`
 * advertises, so the documented shape and the accepted shape finally agree.
 */
import { describe, expect, it } from 'bun:test'
import '@modules/base'
import '@core/loops/sources'
import { importHtml } from '@core/htmlImport'

const VALID = '<instatic-loop data-source-id="data.rows" data-table-id="posts"><p>x</p></instatic-loop>'

describe('loop reference warnings', () => {
  it('warns when the source id is a table slug rather than a source id', () => {
    const result = importHtml('<instatic-loop data-source-id="posts"><p>x</p></instatic-loop>')

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.kind).toBe('unknown-loop-source')
    expect(result.warnings[0]?.message).toContain('"posts"')
    expect(result.warnings[0]?.message).toContain('data.rows')
  })

  it('warns when a loop has no source id at all', () => {
    const result = importHtml('<instatic-loop><p>x</p></instatic-loop>')

    expect(result.warnings[0]?.kind).toBe('unknown-loop-source')
  })

  it('warns when data.rows is missing the table it needs', () => {
    const result = importHtml('<instatic-loop data-source-id="data.rows"><p>x</p></instatic-loop>')

    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.kind).toBe('loop-missing-filter')
    expect(result.warnings[0]?.message).toContain('data-table-id')
  })

  it('stays silent on a well-formed loop', () => {
    expect(importHtml(VALID).warnings).toEqual([])
  })

  it('still imports the loop node — a warning is not a rejection', () => {
    const result = importHtml('<instatic-loop data-source-id="posts"><p>x</p></instatic-loop>')

    expect(result.rootIds).toHaveLength(1)
    expect(Object.values(result.nodes).some((n) => n.moduleId === 'base.loop')).toBe(true)
  })

  it('reports every bad loop in one payload, and nothing for ordinary markup', () => {
    const result = importHtml(`
      <section><h2>Fine</h2><p>Also fine</p></section>
      <instatic-loop data-source-id="nope-one"><p>a</p></instatic-loop>
      <instatic-loop data-source-id="nope-two"><p>b</p></instatic-loop>
    `)

    expect(result.warnings).toHaveLength(2)
  })
})

/**
 * A loop authored inside a table is destroyed by HTML parsing, not by us.
 *
 * `<tbody>` may only contain `<tr>`; a custom element there is foster-parented
 * out to before the `<table>` AND stripped of its children, which stay behind
 * in the tbody. Both halves survive as valid nodes — an empty loop that can
 * never render, and an orphan row whose bindings resolve to blank cells — so
 * `site_insert_html` reported success and the published table carried exactly
 * one empty row. Found building template pack 023, where six data tables
 * published as six blank rows and passed every other gate.
 */
describe('a loop the HTML parser moved out of a table', () => {
  const IN_TBODY = `<table><thead><tr><th>Week</th></tr></thead><tbody>
    <instatic-loop data-source-id="data.rows" data-table-id="waste">
      <tr><td>{currentEntry.week}</td></tr>
    </instatic-loop>
  </tbody></table>`

  it('warns that the loop has no rows to render', () => {
    const result = importHtml(IN_TBODY)

    const empty = result.warnings.filter((w) => w.kind === 'loop-empty')
    expect(empty).toHaveLength(1)
    expect(empty[0]?.message).toContain('<tbody>')
  })

  it('warns even though the source id and table id are both perfectly valid', () => {
    // This is the whole point: every existing check passes on this markup.
    const result = importHtml(IN_TBODY)

    expect(result.warnings.some((w) => w.kind === 'unknown-loop-source')).toBe(false)
    expect(result.warnings.some((w) => w.kind === 'loop-missing-filter')).toBe(false)
    expect(result.warnings.some((w) => w.kind === 'loop-empty')).toBe(true)
  })

  it('warns on any childless loop, whatever emptied it', () => {
    expect(
      importHtml('<instatic-loop data-source-id="data.rows" data-table-id="posts"></instatic-loop>')
        .warnings.some((w) => w.kind === 'loop-empty'),
    ).toBe(true)
  })

  it('stays silent when the loop wraps the whole table instead', () => {
    const result = importHtml(
      '<instatic-loop data-source-id="data.rows" data-table-id="waste">'
      + '<table><tbody><tr><td>{currentEntry.week}</td></tr></tbody></table>'
      + '</instatic-loop>',
    )

    expect(result.warnings).toEqual([])
  })
})
