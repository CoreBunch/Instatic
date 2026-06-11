/**
 * selectActivePage memo contract.
 *
 * Zustand re-runs every subscriber's selector on every store set, and each
 * canvas NodeRenderer mounts several subscriptions that resolve the active
 * page. The selector therefore must (a) scan `site.pages` at most ONCE per
 * (site, activePageId) identity pair, and (b) keep its output referentially
 * stable so per-node selector outputs don't churn.
 */

import { describe, it, expect } from 'bun:test'
import { selectActivePage, type EditorStore } from '@site/store/store'

interface CountingPages {
  pages: unknown[]
  findCalls: () => number
}

function makePages(ids: string[]): CountingPages {
  let findCalls = 0
  const raw = ids.map((id) => ({ id, title: id, slug: id, nodes: {}, rootNodeId: 'root' }))
  const pages = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === 'find') findCalls++
      return Reflect.get(target, prop, receiver)
    },
  })
  return { pages, findCalls: () => findCalls }
}

function makeState(pages: unknown[], activePageId: string | null): EditorStore {
  return { site: { pages }, activePageId } as unknown as EditorStore
}

describe('selectActivePage', () => {
  it('scans site.pages once per (site, activePageId) identity, not once per call', () => {
    const { pages, findCalls } = makePages(['a', 'b', 'c'])
    const state = makeState(pages, 'b')

    const first = selectActivePage(state)
    expect((first as { id: string }).id).toBe('b')
    const callsAfterFirst = findCalls()
    expect(callsAfterFirst).toBe(1)

    // A selector sweep re-runs the selector for every subscriber with the
    // SAME state — all subsequent calls must hit the single-slot cache.
    for (let i = 0; i < 100; i++) {
      expect(selectActivePage(state)).toBe(first)
    }
    expect(findCalls()).toBe(callsAfterFirst)
  })

  it('re-scans when the site identity changes and returns the new page object', () => {
    const a = makePages(['p1', 'p2'])
    const stateA = makeState(a.pages, 'p2')
    const pageA = selectActivePage(stateA)

    const b = makePages(['p1', 'p2'])
    const stateB = makeState(b.pages, 'p2')
    const pageB = selectActivePage(stateB)

    expect(b.findCalls()).toBe(1)
    expect(pageB).not.toBe(pageA)
    expect((pageB as { id: string }).id).toBe('p2')

    // Coming back to a previously-seen-but-evicted site re-scans (single slot).
    selectActivePage(stateA)
    expect(a.findCalls()).toBe(2)
  })

  it('re-scans when activePageId changes on the same site', () => {
    const { pages, findCalls } = makePages(['x', 'y'])
    expect((selectActivePage(makeState(pages, 'x')) as { id: string }).id).toBe('x')
    expect((selectActivePage(makeState(pages, 'y')) as { id: string }).id).toBe('y')
    expect(findCalls()).toBe(2)
  })

  it('returns null without scanning when site or activePageId is missing', () => {
    const { pages, findCalls } = makePages(['a'])
    expect(selectActivePage(makeState(pages, null))).toBeNull()
    expect(findCalls()).toBe(0)
    expect(selectActivePage({ site: null, activePageId: 'a' } as unknown as EditorStore)).toBeNull()
  })

  it('caches a missing-page result (null) without re-scanning', () => {
    const { pages, findCalls } = makePages(['a'])
    const state = makeState(pages, 'nope')
    expect(selectActivePage(state)).toBeNull()
    expect(selectActivePage(state)).toBeNull()
    expect(findCalls()).toBe(1)
  })
})
