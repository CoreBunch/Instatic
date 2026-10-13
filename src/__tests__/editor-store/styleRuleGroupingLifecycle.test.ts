import { describe, expect, it } from 'bun:test'
import parse from 'postcss/lib/parse'
import { useEditorStore } from '@site/store/store'
import { cssToStyleRules } from '@core/siteImport'
import { generateClassCSS } from '@core/publisher'
import { isUserVisibleClass } from '@core/page-tree'
import '@modules/base'

function importRules(css: string) {
  useEditorStore.setState({
    site: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    activeClassId: null,
    selectedSelectorClassId: null,
    selectedSelectorClassIds: [],
  })
  useEditorStore.getState().createSite('Test')
  const parsed = cssToStyleRules(css, { breakpoints: [], mediaTolerance: 0 })
  useEditorStore.getState().applyCssRules(parsed.rules, parsed.conditions, 'merge')
  const site = useEditorStore.getState().site!
  return { site, classRule: Object.values(site.styleRules).find((rule) => rule.kind === 'class')! }
}

function emittedCss() {
  const site = useEditorStore.getState().site!
  return generateClassCSS(site.styleRules, site.breakpoints, site.conditions)
}

describe('native stylesheet registry lifecycle', () => {
  it('duplicates every subject fragment inside the original anonymous layer occurrence', () => {
    const { site, classRule } = importRules(
      '@layer { .card {color:red} .card {padding:4px} @supports (display:grid) { .card {display:grid} } } .card {color:blue} @layer { .other {color:green} }',
    )
    const before = structuredClone(site.styleRules[classRule.id])
    const copy = useEditorStore.getState().duplicateClass(classRule.id)!
    expect(copy.name).toBe('card-copy')
    expect(copy.grouping).toEqual(before.grouping)
    expect(copy.grouping).not.toBe(site.styleRules[classRule.id].grouping)
    expect(copy.grouping![0]).not.toBe(site.styleRules[classRule.id].grouping![0])
    const root = parse(emittedCss())
    const layers = root.nodes.filter((node) => node.type === 'atrule' && node.name === 'layer')
    expect(layers).toHaveLength(2)
    const selectors: string[] = []
    root.walkRules((rule) => {
      selectors.push(rule.selector)
    })
    expect(selectors).toEqual([
      '.card',
      '.card-copy',
      '.card',
      '.card-copy',
      '.card',
      '.card-copy',
      '.card',
      '.card-copy',
      '.other',
    ])
    expect(useEditorStore.getState().site!.styleRules[classRule.id]).toEqual(before)
    const copies = Object.values(useEditorStore.getState().site!.styleRules).filter(
      (rule) => rule.selector === '.card-copy',
    )
    expect(copies).toHaveLength(4)
    expect(copies.filter((rule) => rule.kind === 'class')).toHaveLength(1)
    expect(copies.every((rule) => !rule.origin)).toBe(true)
    useEditorStore.getState().undo()
    expect(
      Object.values(useEditorStore.getState().site!.styleRules).some(
        (rule) => rule.selector === '.card-copy',
      ),
    ).toBe(false)
    useEditorStore.getState().redo()
    expect(
      parse(emittedCss()).nodes.filter((node) => node.type === 'atrule' && node.name === 'layer'),
    ).toHaveLength(2)
  })

  it('keeps complex selector patterns and renames dependencies across all native fragments', () => {
    const { classRule } = importRules(
      '.group:hover .group-hover\\:block {display:block} @layer variants { .group:hover .group-hover\\:block {color:red} } .group-hover\\:block .child {color:blue} [data-name=".group-hover:block"] {color:green}',
    )
    const copy = useEditorStore.getState().duplicateClass(classRule.id)!
    expect(copy.selector).toBe('.group:hover .group-hover\\:block-copy')
    useEditorStore.getState().renameClass(classRule.id, 'expanded')
    const css = emittedCss()
    expect(css).toContain('.group:hover .expanded')
    expect(css).toContain('.expanded .child')
    expect(css).toContain('[data-name=".group-hover:block"]')
    expect(css).toContain('.group:hover .group-hover\\:block-copy')
    expect(css).not.toContain('.group:hover .group-hover\\:block {')
  })

  it('removes an outer condition without lifting nested declarations, properties or animations', () => {
    const { site, classRule } = importRules(
      '@media (min-width:1px) { @layer card { @supports (display:grid) { .card {color:red!important} } @property --size {syntax:"<length>"; inherits:false; initial-value:12px} @keyframes spin {to {opacity:0}} } } .other {color:blue}',
    )
    const condition = site.conditions!.find((entry) => entry.condition.kind === 'media')!
    useEditorStore.setState({ activeClassId: classRule.id })
    useEditorStore.getState().removeCondition(condition.id)
    const current = useEditorStore.getState().site!
    expect(current.conditions!.some((entry) => entry.id === condition.id)).toBe(false)
    expect(current.styleRules[classRule.id]).toMatchObject({ styles: {}, contextStyles: {} })
    expect(current.styleRules[classRule.id].grouping).toBeUndefined()
    expect(useEditorStore.getState().activeClassId).toBe(classRule.id)
    expect(emittedCss()).toContain('.other')
    expect(emittedCss()).not.toMatch(/card|@media|@property|@keyframes|red/)
    expect(
      Object.values(current.styleRules).some((rule) =>
        (rule.grouping ?? []).some(
          (group) => group.kind === 'context' && group.contextId === condition.id,
        ),
      ),
    ).toBe(false)
    useEditorStore.getState().undo()
    expect(emittedCss()).toContain('@media (min-width:1px)')
    expect(emittedCss()).toContain('@property --size')
  })

  it('removes one grouped ambient fragment and its editor selection without deleting shared conditions', () => {
    const { site } = importRules(
      '.card {color:black} @media (min-width:1px) { @supports (display:grid) { .card {color:red} } }',
    )
    const fragment = Object.values(site.styleRules).find(
      (rule) => rule.kind === 'ambient' && rule.selector === '.card',
    )!
    const media = site.conditions!.find((entry) => entry.condition.kind === 'media')!
    useEditorStore.setState({
      activeClassId: fragment.id,
      selectedSelectorClassId: fragment.id,
      selectedSelectorClassIds: [fragment.id],
    })
    useEditorStore.getState().removeClassContext(fragment.id, media.id)
    expect(useEditorStore.getState().site!.styleRules[fragment.id]).toBeUndefined()
    expect(useEditorStore.getState().site!.conditions).toHaveLength(2)
    expect(useEditorStore.getState().activeClassId).toBeNull()
    expect(useEditorStore.getState().selectedSelectorClassId).toBeNull()
    expect(useEditorStore.getState().selectedSelectorClassIds).toEqual([])
    expect(emittedCss()).toContain('color: black')
    expect(emittedCss()).not.toContain('red')
  })

  it('keeps structural at-rules out of class controls while retaining native emission', () => {
    const { site } = importRules(
      '@layer foundation; @property --size {syntax:"<length>"; inherits:false; initial-value:12px}',
    )
    const marker = Object.values(site.styleRules).find((rule) => rule.atRule)!
    expect(isUserVisibleClass(marker)).toBe(false)
    expect(useEditorStore.getState().duplicateClass(marker.id)).toBeNull()
    useEditorStore.getState().renameClass(marker.id, '.corrupted')
    expect(useEditorStore.getState().site!.styleRules[marker.id]).toEqual(marker)
    expect(emittedCss()).toContain('@layer foundation;')
    expect(emittedCss()).toContain('@property --size')
  })
})
