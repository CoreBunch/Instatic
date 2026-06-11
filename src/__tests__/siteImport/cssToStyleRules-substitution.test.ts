/**
 * Substitution-declaration fidelity (`var()` / `env()` values).
 *
 * CSS engines disagree about what their CSSOM exposes for declarations whose
 * value contains a substitution function: Chromium enumerates the shorthand's
 * longhands with EMPTY values (the text survives only in cssText), while
 * happy-dom destroys the declaration entirely (each longhand reports the bare
 * `var(...)` text; `1px solid` is gone from cssText too).
 *
 * `@core/css-substitution` removes the divergence at the source: every
 * substitution declaration is encoded as a marker custom property BEFORE the
 * engine parse (all engines preserve custom properties verbatim) and decoded
 * after. These tests run through the REAL engine (happy-dom here, Chromium in
 * production) and assert byte-faithful output.
 */

import { describe, it, expect } from 'bun:test'
import { cssToStyleRules } from '@core/siteImport'
import {
  encodeSubstitutionDeclarations,
  encodeSubstitutionDeclarationList,
  decodeSubstitutionProperty,
  SUBSTITUTION_PROP_MARKER,
} from '@core/css-substitution'

describe('cssToStyleRules — substitution declarations survive verbatim', () => {
  it('preserves shorthand+var declarations byte-faithfully', () => {
    const { rules, warnings } = cssToStyleRules(`
      .plan { padding: 40px; border-left: 1px solid var(--rule); }
      .plans { border: 1px solid var(--rule); }
      html, body { background: var(--bg); }
      .btn { transition: background 140ms var(--easing); gap: var(--g); }
    `)

    const bySel = Object.fromEntries(rules.map((r) => [r.selector, r.styles]))
    expect(bySel['.plan'].borderLeft).toBe('1px solid var(--rule)')
    // The non-var shorthand still expands through the engine as usual.
    expect(bySel['.plan'].paddingTop).toBe('40px')
    expect(bySel['.plans'].border).toBe('1px solid var(--rule)')
    expect(bySel['html, body'].background).toBe('var(--bg)')
    expect(bySel['.btn'].transition).toBe('background 140ms var(--easing)')
    expect(bySel['.btn'].gap).toBe('var(--g)')
    expect(warnings).toHaveLength(0)

    // No engine-mangled longhand artifacts (`borderLeftWidth: var(--rule)`).
    for (const styles of Object.values(bySel)) {
      for (const [prop, value] of Object.entries(styles)) {
        if (prop.startsWith('border') && prop !== 'border' && prop !== 'borderLeft') {
          expect(String(value)).not.toContain('var(')
        }
      }
    }
  })

  it('preserves longhand var() declarations and authored custom properties', () => {
    const { rules } = cssToStyleRules(`.x { color: var(--ink); --own: 12px; }`)
    expect(rules[0].styles.color).toBe('var(--ink)')
    expect(rules[0].styles['--own']).toBe('12px')
  })

  it('preserves var() declarations inside @media overrides', () => {
    const { rules } = cssToStyleRules(`
      .plan { color: red; }
      @media (max-width: 700px) { .plan { border-top: 1px solid var(--rule) } }
    `)
    const plan = rules.find((r) => r.selector === '.plan')!
    const contexts = Object.values(plan.contextStyles ?? {})
    expect(contexts).toHaveLength(1)
    expect((contexts[0] as Record<string, unknown>).borderTop).toBe('1px solid var(--rule)')
  })

  it('blocks a security-denied property even when its value uses var()', () => {
    const { rules, warnings } = cssToStyleRules(`.x { behavior: var(--evil); }`)
    expect(rules[0]?.styles?.behavior).toBeUndefined()
    expect(warnings.some((w) => w.kind === 'blocked-property' && w.property === 'behavior')).toBe(true)
  })

  it('keeps @keyframes raw CSS free of encode markers', () => {
    const { rules } = cssToStyleRules(`
      @keyframes pulse { from { opacity: var(--lo); } to { opacity: 1; } }
      .x { animation: pulse 1s var(--easing) infinite; }
    `)
    const keyframes = rules.find((r) => typeof r.rawCss === 'string')
    expect(keyframes).toBeDefined()
    expect(keyframes!.rawCss).not.toContain(SUBSTITUTION_PROP_MARKER)
    expect(rules.find((r) => r.selector === '.x')?.styles.animation).toBe('pulse 1s var(--easing) infinite')
  })
})

describe('encodeSubstitutionDeclarations', () => {
  it('rewrites only substitution declarations, byte-preserving everything else', () => {
    const css = `/* c */ .a:hover { color: red; border: 1px solid var(--x); }`
    expect(encodeSubstitutionDeclarations(css)).toBe(
      `/* c */ .a:hover { color: red; ${SUBSTITUTION_PROP_MARKER}border: 1px solid var(--x); }`,
    )
  })

  it('does not re-encode custom properties or split values on nested separators', () => {
    const css = `.a { --token: var(--x); content: "a;b{c}"; background: url("x;y.png") var(--bg); }`
    const encoded = encodeSubstitutionDeclarations(css)
    expect(encoded).toContain(`--token: var(--x)`)
    expect(encoded).toContain(`content: "a;b{c}"`)
    expect(encoded).toContain(`${SUBSTITUTION_PROP_MARKER}background: url("x;y.png") var(--bg)`)
  })

  it('leaves @keyframes and @font-face blocks untouched, including vendor prefixes', () => {
    const css = [
      `@keyframes spin { to { transform: rotate(var(--turn)); } }`,
      `@-webkit-keyframes spin { to { transform: rotate(var(--turn)); } }`,
      `@font-face { font-family: X; src: local(var(--nope)); }`,
      `@media (min-width: 700px) { .x { gap: var(--g); } }`,
    ].join('\n')
    const encoded = encodeSubstitutionDeclarations(css)
    expect(encoded.split(SUBSTITUTION_PROP_MARKER)).toHaveLength(2) // only the @media declaration
    expect(encoded).toContain(`${SUBSTITUTION_PROP_MARKER}gap: var(--g)`)
    expect(encoded).toContain('transform: rotate(var(--turn))')
  })

  it('round-trips through decodeSubstitutionProperty', () => {
    expect(decodeSubstitutionProperty(`${SUBSTITUTION_PROP_MARKER}border-left`)).toBe('border-left')
    expect(decodeSubstitutionProperty('--own-prop')).toBeNull()
    expect(decodeSubstitutionProperty('border-left')).toBeNull()
  })
})

describe('encodeSubstitutionDeclarationList — style attributes', () => {
  it('encodes substitution declarations in a bare declaration list', () => {
    expect(encodeSubstitutionDeclarationList('color: red; border: 1px solid var(--x)')).toBe(
      `color: red; ${SUBSTITUTION_PROP_MARKER}border: 1px solid var(--x)`,
    )
  })
})
