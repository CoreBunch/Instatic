import { describe, expect, it } from 'bun:test'
import { collectUsedFrameworkClassIds } from '@core/framework'
import type { SiteDocument } from '@core/page-tree'

describe('collectUsedFrameworkClassIds', () => {
  it('returns only assigned framework-prefixed ids across pages + VCs', () => {
    const site = {
      pages: [
        {
          id: 'p',
          nodes: { a: { id: 'a', classIds: ['framework:color:primary:text', 'custom'] } },
        },
      ],
      visualComponents: [
        {
          id: 'vc',
          classIds: ['framework:color:dark:bg'],
          tree: { nodes: { b: { id: 'b', classIds: ['framework:typography:g:l'] } } },
        },
      ],
    } as unknown as SiteDocument
    const used = collectUsedFrameworkClassIds(site)
    expect(used.has('framework:color:primary:text')).toBe(true)
    expect(used.has('framework:color:dark:bg')).toBe(true)
    expect(used.has('framework:typography:g:l')).toBe(true)
    expect(used.has('custom')).toBe(false)
  })

  it('tolerates nodes without classIds', () => {
    const site = {
      pages: [{ id: 'p', nodes: { a: { id: 'a' } } }],
      visualComponents: [],
    } as unknown as SiteDocument
    expect(collectUsedFrameworkClassIds(site).size).toBe(0)
  })
})
