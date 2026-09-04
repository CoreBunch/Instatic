/**
 * prettyPrintProjection — the one-line projection reflowed for reading,
 * without introducing whitespace where the page would show it.
 */
import { describe, expect, it } from 'bun:test'
import { prettyPrintProjection } from '@site/code-dock/html/prettyProjection'

describe('prettyPrintProjection', () => {
  it('puts element-only children on indented lines and keeps text content inline', () => {
    const html = '<div uid="a" class="card"><h1 uid="b">Hello <b>there</b></h1><p uid="c">Body</p></div>'
    expect(prettyPrintProjection(html)).toBe(
      [
        '<div uid="a" class="card">',
        '  <h1 uid="b">Hello <b>there</b></h1>',
        '  <p uid="c">Body</p>',
        '</div>',
      ].join('\n'),
    )
  })

  it('nests, handles void and self-closing tags, and keeps attribute text with > verbatim', () => {
    const html = '<section uid="s"><div uid="d"><img uid="i" src="x.png" alt="a > b"><instatic-outlet uid="o"></instatic-outlet></div><br></section>'
    expect(prettyPrintProjection(html)).toBe(
      [
        '<section uid="s">',
        '  <div uid="d">',
        '    <img uid="i" src="x.png" alt="a > b">',
        '    <instatic-outlet uid="o"></instatic-outlet>',
        '  </div>',
        '  <br>',
        '</section>',
      ].join('\n'),
    )
  })

  it('leaves pre, textarea, script and style content untouched', () => {
    const html = '<div uid="a"><pre uid="p"><code>x</code><code>y</code></pre><style>.a{b:c}</style></div>'
    expect(prettyPrintProjection(html)).toBe(
      ['<div uid="a">', '  <pre uid="p"><code>x</code><code>y</code></pre>', '  <style>.a{b:c}</style>', '</div>'].join('\n'),
    )
  })

  it('is idempotent and loses no markup on malformed input', () => {
    const once = prettyPrintProjection('<div><p>a</p><p>b</p></div>')
    expect(prettyPrintProjection(once)).toBe(once)
    const malformed = '<div><p>a</div></span>'
    expect(prettyPrintProjection(malformed).replace(/\s+/g, '')).toBe(malformed)
    expect(prettyPrintProjection('plain text')).toBe('plain text')
  })
})
