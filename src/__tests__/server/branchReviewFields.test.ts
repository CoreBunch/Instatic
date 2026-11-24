import { describe, expect, it } from 'bun:test'
import { siteAdapter } from '../../../server/branches/entities/site'
import { rowAdapter } from '../../../server/branches/entities/row'

describe('branch review field descriptions', () => {
  it('identifies changed declarations in a large registry, scopes conflicts and names added and removed rules', () => {
    const rule = { id: 'rule', selector: '.keys__ask', styles: { backgroundColor: 'red' }, contextStyles: { small: { paddingTop: '2px' } } }
    const unchanged = { id: 'a', selector: '.unchanged', description: 'Unchanged'.repeat(100) }
    const shell = { breakpoints: [{ id: 'small', label: 'Mobile' }] }
    const before = { name: 'Site', shell: { ...shell, styleRules: { a: unchanged, rule, old: { id: 'old', selector: '.old' } } } }
    const after = { name: 'Site', shell: { ...shell, styleRules: {
      a: unchanged, new: { id: 'new', selector: '.new' },
      rule: { ...rule, styles: { backgroundColor: 'blue' }, contextStyles: { small: { paddingTop: '4px' } } },
    } } }
    const detail = siteAdapter.describe(before, after, ['shell.styleRules.rule.contextStyles.small.paddingTop'], null)
    if (detail.kind !== 'site') throw new Error('Expected a site settings table')
    expect(detail.fields.map(({ label, before, after, conflict }) => [label, before, after, conflict])).toEqual([
      ['Style rules › .new', null, '.new', false],
      ['Style rules › .old', '.old', null, false],
      ['Style rules › .keys__ask › Mobile › padding-top', '2px', '4px', true],
      ['Style rules › .keys__ask › background-color', 'red', 'blue', false],
    ])
  })

  it('matches breakpoints by id when one is inserted, and reports a reorder explicitly', () => {
    const mobile = { id: 'bp1', label: 'Mobile', width: 375 }
    const desktop = { id: 'bp2', label: 'Desktop', width: 1440 }
    const tablet = { id: 'bp3', label: 'Tablet', width: 768 }
    const before = { name: 'Site', shell: { breakpoints: [mobile, desktop] } }
    const describeBreakpoints = (breakpoints: typeof mobile[]) => {
      const detail = siteAdapter.describe(before, { ...before, shell: { breakpoints } }, [], null)
      if (detail.kind !== 'site') throw new Error('Expected a site settings table')
      return detail.fields.map(({ label, before, after }) => [label, before, after])
    }
    expect(describeBreakpoints([mobile, tablet, desktop])).toEqual([['Breakpoints › Tablet', null, 'Tablet']])
    expect(describeBreakpoints([desktop, mobile])).toEqual([
      ['Breakpoints › Desktop › Position', '2', '1'],
      ['Breakpoints › Mobile › Position', '1', '2'],
    ])
  })

  it('describes nested entry fields, array edits and empty collections without losing literal text', () => {
    const before = { tableId: 'articles', slug: 'post', cells: { settings: { showTitle: true }, tags: ['news'], notes: { sections: [] } } }
    const after = { ...before, cells: { settings: { showTitle: false }, tags: ['news', 'press'], code: '{"example":true}' } }
    const detail = rowAdapter.describe(before, after, ['cells.tags'], 'articles')
    if (detail.kind !== 'row') throw new Error('Expected an entry field table')
    expect(detail.fields.map(({ label, before, after, conflict }) => [label, before, after, conflict])).toEqual([
      ['Code', null, '{"example":true}', false],
      ['Notes › Sections', '0 items', null, false],
      ['Settings › Show title', 'Yes', 'No', false],
      ['Tags › Item 2', null, 'press', true],
    ])
  })
})
