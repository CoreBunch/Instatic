import { describe, expect, it } from 'bun:test'
// findPageForNodeId is the compose-aware lookup; verify it strips the c0_/t<N>_
// prefix that templateCompose splices onto wrapped-page node ids.
// Static unit test — no DB. Mirrors the architecture-test style.
import { findPageForNodeId, getPublishedNodeIndexForVersion } from '../../../server/publish/publishedSnapshotCache'

// Build a minimal PublishedNodeIndex shape by hand (the type isn't exported,
// but findPageForNodeId accepts it structurally).
function makeIndex(nodeIds: string[]): Parameters<typeof findPageForNodeId>[0] {
  const nodeIndex = new Map<string, unknown>()
  for (const id of nodeIds) nodeIndex.set(id, { id: 'page-x' } as never)
  return { site: {} as never, nodeIndex } as never
}

describe('findPageForNodeId — compose-prefix awareness', () => {
  it('finds a node by its original (non-composed) id', () => {
    const idx = makeIndex(['abc123'])
    expect(findPageForNodeId(idx, 'abc123')?.effectiveNodeId).toBe('abc123')
  })

  it('finds a node by its c0_-prefixed composed id (everywhere template terminal page)', () => {
    const idx = makeIndex(['abc123'])
    const found = findPageForNodeId(idx, 'c0_abc123')
    expect(found).toBeDefined()
    expect(found!.effectiveNodeId).toBe('abc123')
  })

  it('finds a node by its t<N>_ prefixed composed id (outer template wrap)', () => {
    const idx = makeIndex(['abc123'])
    expect(findPageForNodeId(idx, 't0_abc123')?.effectiveNodeId).toBe('abc123')
    expect(findPageForNodeId(idx, 't12_abc123')?.effectiveNodeId).toBe('abc123')
  })

  it('returns undefined for an id with no stripped match', () => {
    const idx = makeIndex(['abc123'])
    expect(findPageForNodeId(idx, 'c0_totally_missing')).toBeUndefined()
    expect(findPageForNodeId(idx, 'no_such_node')).toBeUndefined()
  })

  it('does NOT strip a prefix that is part of the original id', () => {
    // An authored id that genuinely starts with c0_ must still match itself.
    const idx = makeIndex(['c0_realid'])
    expect(findPageForNodeId(idx, 'c0_realid')?.effectiveNodeId).toBe('c0_realid')
  })

  it('getPublishedNodeIndexForVersion remains exported (handler import contract)', () => {
    expect(typeof getPublishedNodeIndexForVersion).toBe('function')
  })
})
