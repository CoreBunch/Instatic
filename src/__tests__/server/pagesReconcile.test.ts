import { describe, test, expect } from 'bun:test'
import { rowsToReap } from '../../../server/repositories/data'

/**
 * ISS-041: the roster PUT reconcile soft-deleted every existing row not in
 * the incoming set. With no concurrency token that silently reaped a page a
 * *different* admin had just created (the saving client never knew it existed).
 *
 * With a baseline (the row ids the saving client loaded), a row is reaped only
 * if it was in that baseline AND is absent from the incoming set — so a
 * sibling's newly-created page survives. With no baseline (e.g. a full import
 * replace) the authoritative full-reconcile behaviour is preserved.
 */
describe('rowsToReap', () => {
  test('without a baseline, reaps every existing row missing from incoming (full replace)', () => {
    const existing = ['p1', 'p2', 'p3']
    const incoming = new Set(['p1'])
    expect(rowsToReap(existing, incoming).sort()).toEqual(['p2', 'p3'])
  })

  test('with a baseline, never reaps a row the client never knew about (sibling create)', () => {
    // Client loaded {p1}; another admin created {x}. Storage now {p1, x}.
    // Client saves incoming {p1}. x must NOT be reaped.
    const existing = ['p1', 'x']
    const incoming = new Set(['p1'])
    const baseline = new Set(['p1'])
    expect(rowsToReap(existing, incoming, baseline)).toEqual([])
  })

  test('with a baseline, still reaps a page the client intentionally removed', () => {
    // Client loaded {p1, p2}, deleted p2, saves incoming {p1}.
    const existing = ['p1', 'p2', 'x']
    const incoming = new Set(['p1'])
    const baseline = new Set(['p1', 'p2'])
    // p2 reaped (in baseline, removed); x preserved (sibling create).
    expect(rowsToReap(existing, incoming, baseline)).toEqual(['p2'])
  })
})
