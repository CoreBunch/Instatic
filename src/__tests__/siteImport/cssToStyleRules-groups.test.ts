import { describe, expect, it } from 'bun:test'
import parse from 'postcss/lib/parse'
import { cssToStyleRules } from '@core/siteImport'
import { extractRootColorTokens, buildImportPlan, applyAssetRewrites } from '@core/siteImport'
import '@modules/base'
import { makeSinglePageFileMap, MINIMAL_PNG } from './fixtures'
import { makeEmptySiteDocument } from './mockSite'
import { generateClassCSS, treeShakeStyleRules } from '@core/publisher'
import { parseStyleRule, type StyleRule } from '@core/page-tree'

function importCss(source: string) {
  const parsed = cssToStyleRules(source, { breakpoints: [], mediaTolerance: 0 })
  const registry: Record<string, StyleRule> = Object.fromEntries(
    parsed.rules.map((rule, index) => [
      String(index),
      { ...rule, id: String(index), createdAt: 0, updatedAt: 0 },
    ]),
  )
  return { parsed, registry, css: generateClassCSS(registry, [], parsed.conditions) }
}

describe('native imported CSS grouping', () => {
  it('gives independent stylesheet parses distinct occurrence identities', () => {
    const first = importCss('@layer { .a {color:red} }')
    const second = importCss('@layer { .a {color:blue} }')
    const firstIds = new Set(
      Object.values(first.registry).flatMap(
        (rule) => rule.grouping?.map((group) => group.id) ?? [],
      ),
    )
    const secondIds = Object.values(second.registry).flatMap(
      (rule) => rule.grouping?.map((group) => group.id) ?? [],
    )
    expect(secondIds.every((id) => !firstIds.has(id))).toBe(true)
  })

  it('accepts escaped and Unicode layer paths and reports invalid names explicitly', () => {
    const source = String.raw`@layer café.foo\ bar, \39 layer; @layer café.foo\ bar { .a {color:red} } @layer \39 layer { .a {color:blue} }`
    const { css, parsed } = importCss(source)
    expect(parsed.warnings.filter((warning) => warning.kind !== 'duplicate-class')).toEqual([])
    expect(css).toContain(String.raw`@layer café.foo\ bar, \39 layer;`)
    expect(css).toContain(String.raw`@layer café.foo\ bar {`)
    expect(css).toContain(String.raw`@layer \39 layer {`)
    for (const name of ['--', '--1', '--123', '-x']) {
      const valid = importCss(`@layer ${name}; @layer ${name} { .a {color:red} }`)
      expect(valid.parsed.warnings).toEqual([])
      expect(valid.css).toContain(`@layer ${name};`)
      expect(valid.css).toContain(`@layer ${name} {`)
    }
    const invalid = importCss('@layer foo, bar { .a {color:red} }')
    expect(invalid.parsed.warnings).toEqual([expect.objectContaining({ kind: 'dropped-at-rule' })])
    expect(invalid.parsed.rules).toEqual([])
  })

  it('keeps layer declaration order, nested layers, and source fragments after persistence', () => {
    const source =
      '@layer overrides, base; @layer base { .a { color:red } @layer detail { .b { color: blue !important } } .a {color:green} } .a {color:black}'
    const { parsed, registry, css } = importCss(source)
    expect(parsed.warnings.filter((warning) => warning.kind !== 'duplicate-class')).toEqual([])
    const restored: Record<string, StyleRule> = {}
    for (const [id, value] of Object.entries(JSON.parse(JSON.stringify(registry)))) {
      const rule = parseStyleRule(value)
      if (!rule) throw new Error('Persisted rule could not be parsed')
      restored[id] = rule
    }
    expect(generateClassCSS(restored, [], parsed.conditions)).toBe(css)
    const root = parse(css)
    expect(
      root.nodes.map((node) =>
        node.type === 'atrule'
          ? '@' + node.name + ' ' + node.params
          : node.type === 'rule'
            ? node.selector
            : node.type,
      ),
    ).toEqual(['@layer overrides, base', '@layer base', '.a'])
    const base = root.nodes[1]
    expect(base.type === 'atrule' && base.nodes?.map((node) => node.type)).toEqual([
      'rule',
      'atrule',
      'rule',
    ])
    expect(css).toContain('color: blue !important')
  })

  it('does not split one anonymous layer into several independent layers', () => {
    const { css } = importCss(
      '@layer { .a { color:red !important } .b {color:blue!important} } @layer { .a {color:green!important} }',
    )
    const layers = parse(css).nodes.filter((node) => node.type === 'atrule')
    expect(layers).toHaveLength(2)
    expect(layers[0].type === 'atrule' && layers[0].nodes).toHaveLength(2)
    expect(layers[1].type === 'atrule' && layers[1].nodes).toHaveLength(1)
  })

  it('retains empty layer anchors and property registrations when class rules are pruned', () => {
    const { registry, parsed } = importCss(
      '@layer first { .unused {color:red} } @layer second; @property --size { syntax:"<length>"; inherits:false; initial-value:12px }',
    )
    const css = generateClassCSS(treeShakeStyleRules(registry, new Set()), [], parsed.conditions)
    const root = parse(css)
    expect(root.nodes.map((node) => (node.type === 'atrule' ? node.name : node.type))).toEqual([
      'layer',
      'layer',
      'property',
    ])
    expect(css).not.toContain('.unused')
    expect(css).toContain('initial-value: 12px')
    const property = Object.values(registry).find((rule) => rule.atRule?.kind === 'property')
    expect(property?.atRule).toEqual({
      kind: 'property',
      name: '--size',
      syntax: '<length>',
      inherits: false,
      initialValue: '12px',
    })
  })

  it('keeps nesting order across media, layer, supports, and container blocks', () => {
    const { css, parsed } = importCss(
      '@media (min-width:1px) { @layer card { @supports (display:grid) { @container sidebar (width > 10px) { .a { color:red } } } } }',
    )
    expect(parsed.warnings).toEqual([])
    let nodes = parse(css).nodes
    const names = []
    while (nodes[0]?.type === 'atrule') {
      names.push(nodes[0].name)
      nodes = nodes[0].nodes ?? []
    }
    expect(names).toEqual(['media', 'layer', 'supports', 'container'])
    expect(css).toContain('.a')
  })

  it('preserves registered wildcard syntax with no initial value and explicit inheritance', () => {
    const { registry, css, parsed } = importCss(
      '@property --opaque { syntax:"*"; inherits:false } @property --inherited { syntax:"<color>"; inherits:true; initial-value:red }',
    )
    expect(parsed.warnings).toEqual([])
    expect(Object.values(registry).map((rule) => rule.atRule)).toEqual([
      { kind: 'property', name: '--opaque', syntax: '*', inherits: false },
      {
        kind: 'property',
        name: '--inherited',
        syntax: '<color>',
        inherits: true,
        initialValue: 'red',
      },
    ])
    expect(parse(css).nodes).toHaveLength(2)
  })

  it('normalizes and uploads assets referenced by a property registration without mutating the plan', () => {
    const files = makeSinglePageFileMap(
      '<html><head><link rel="stylesheet" href="styles/main.css"></head><body></body></html>',
    )
    files.files['styles/main.css'] = {
      bytes: new TextEncoder().encode(
        '@property --icon { syntax:"<image>"; inherits:false; initial-value:url(../images/icon.png) }',
      ),
      mimeType: 'text/css',
    }
    files.files['images/icon.png'] = { bytes: MINIMAL_PNG, mimeType: 'image/png' }
    const plan = buildImportPlan({ fileMap: files, currentSite: makeEmptySiteDocument() })
    expect(plan.assets.some((asset) => asset.sourcePath === 'images/icon.png')).toBe(true)
    const original = plan.styleRules.find((rule) => rule.atRule?.kind === 'property')?.atRule
    expect(original?.kind === 'property' && original.initialValue).toContain('images/icon.png')
    const rewritten = applyAssetRewrites(plan, { 'images/icon.png': '/uploads/icon.png' })
    const registration = rewritten.styleRules.find(
      (rule) => rule.atRule?.kind === 'property',
    )?.atRule
    expect(registration?.kind === 'property' && registration.initialValue).toContain(
      '/uploads/icon.png',
    )
    expect(original?.kind === 'property' && original.initialValue).not.toContain('/uploads/')
    expect(applyAssetRewrites(rewritten, { 'images/icon.png': '/uploads/icon.png' })).toEqual(
      rewritten,
    )
  })

  it('reports a genuinely unsupported at-rule instead of silently discarding its subtree', () => {
    const { parsed } = importCss('@page { size: A4 }')
    expect(parsed.rules).toEqual([])
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ kind: 'dropped-at-rule', source: '@page { size: A4 }' }),
    ])
  })

  it('keeps layered token declarations in their original cascade position', () => {
    const { parsed } = importCss(
      '@layer theme { :root { --brand:red; --font-body:Poppins,sans-serif } }',
    )
    expect(extractRootColorTokens(parsed.rules).colorTokens).toEqual([])
    expect(extractRootColorTokens(parsed.rules).rules).toEqual(parsed.rules)
    const plan = buildImportPlan({
      fileMap: makeSinglePageFileMap(
        '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>',
        '@layer theme { :root { --brand:red; --font-body:Poppins,sans-serif } }',
      ),
      currentSite: makeEmptySiteDocument(),
    })
    expect(plan.fontTokens).toEqual([])
    expect(plan.colors).toEqual([])
    expect(
      plan.styleRules.some((rule) => rule.styles['--font-body'] === 'Poppins,sans-serif'),
    ).toBe(true)
  })

  it('keeps a headless-unsupported multilayer background and source fallbacks', () => {
    const background =
      'linear-gradient(#2269be0b 1px,#0000 1px) 0 0/24px 24px,linear-gradient(90deg,#2269be0b 1px,#0000 1px) 0 0/24px 24px,linear-gradient(145deg,#f7fbff,#edf5ff)'
    const { css } = importCss(
      `.a {background:red; background:${background}; color:red!important; color:invalid-value; color:blue}`,
    )
    expect(css).toContain(`background: ${background}`)
    expect(css.indexOf('background-color: red')).toBeLessThan(
      css.indexOf(`background: ${background}`),
    )
    expect(css.indexOf('color: red !important')).toBeLessThan(css.indexOf('color: invalid-value'))
    expect(css.indexOf('color: invalid-value')).toBeLessThan(css.indexOf('color: blue'))
  })
})
