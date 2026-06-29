import { describe, expect, it } from 'bun:test'
import { sanitizeSvgBytes } from '../svgSanitize'

const enc = new TextEncoder()
const dec = new TextDecoder()

function clean(svg: string): string {
  return dec.decode(sanitizeSvgBytes(enc.encode(svg)))
}

describe('sanitizeSvgBytes', () => {
  it('keeps benign SVG geometry intact', () => {
    const out = clean('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>')
    expect(out).toContain('<rect')
    expect(out).toContain('viewBox')
  })

  it('strips a plain <script> block', () => {
    const out = clean('<svg><script>alert(1)</script><rect/></svg>')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).toContain('<rect')
  })

  // Regression for CodeQL js/bad-tag-filter (#34): the HTML parser ends a tag
  // at the first `>`, so these close-tag variants must all be recognised.
  it.each([
    '<svg><script>alert(1)</script >x</svg>',
    '<svg><script>alert(1)</script\t\nbar>x</svg>',
    '<svg><script>alert(1)</script/>x</svg>',
  ])('strips scripts with awkward close tags: %s', (input) => {
    const out = clean(input).toLowerCase()
    expect(out).not.toContain('alert(1)')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('</script')
  })

  // Regression for CodeQL js/incomplete-multi-character-sanitization (#33): a
  // single strip pass leaves a nested payload behind; the fixpoint loop must
  // collapse it fully.
  it('collapses split-tag obfuscation to a fixpoint', () => {
    const out = clean('<svg><scr<script>ipt>alert(1)</scr</script>ipt><rect/></svg>').toLowerCase()
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<rect')
  })

  it('strips <foreignObject> and <style> wrappers', () => {
    const out = clean(
      '<svg><foreignObject><div>x</div></foreignObject><style>@import url(javascript:alert(1))</style><rect/></svg>',
    ).toLowerCase()
    expect(out).not.toContain('<foreignobject')
    expect(out).not.toContain('<style')
    expect(out).toContain('<rect')
  })

  it('strips on* event handlers and javascript: URLs', () => {
    const out = clean('<svg onload="alert(1)"><a href="javascript:alert(1)"><rect/></a></svg>').toLowerCase()
    expect(out).not.toContain('onload')
    expect(out).not.toContain('javascript:')
  })

  it('returns empty bytes for empty / whitespace input', () => {
    expect(sanitizeSvgBytes(enc.encode('   ')).length).toBe(0)
    expect(sanitizeSvgBytes(new Uint8Array(0)).length).toBe(0)
  })
})
