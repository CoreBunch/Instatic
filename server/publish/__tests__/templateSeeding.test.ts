import { describe, expect, it } from 'bun:test'
import { buildDefaultTemplateCells } from '../templateSeeding'
import type { DataTable } from '@core/data/schemas'

const table = { slug: 'posts', singularLabel: 'Post' } as DataTable

interface SeedNode {
  moduleId: string
  dynamicBindings?: { html?: unknown }
}

describe('buildDefaultTemplateCells', () => {
  it('targets the post type and uses base.outlet for the body', () => {
    const cells = buildDefaultTemplateCells(table, 'posts-template') as Record<string, unknown>
    expect(cells.templateTarget).toEqual({ kind: 'postTypes', tableSlugs: ['posts'] })
    expect(cells.templateContext).toBeUndefined()
    const nodes = (cells.body as { nodes: Record<string, SeedNode> }).nodes
    const all = Object.values(nodes)
    const outlet = all.find((n) => n.moduleId === 'base.outlet')
    expect(outlet).toBeTruthy()
    // The outlet carries NO persisted binding — the publisher fills every
    // outlet's body implicitly (see `effectiveNodeBindings`), so a seeded
    // outlet is identical to one a user drags in by hand.
    expect(outlet?.dynamicBindings).toBeUndefined()
    expect(all.some((n) => n.moduleId === 'base.content')).toBe(false)
  })
})
