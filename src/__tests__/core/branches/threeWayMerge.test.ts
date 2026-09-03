import { describe, expect, it } from 'bun:test'
import { mergeJson } from '@core/branches'

describe('mergeJson', () => {
  it('keeps ours when theirs did not move', () => {
    const base = { title: 'Home', body: 'a' }
    expect(mergeJson(base, { title: 'Home!', body: 'a' }, base)).toEqual({
      value: { title: 'Home!', body: 'a' },
      conflicts: [],
    })
  })

  it('takes theirs when ours did not move', () => {
    const base = { title: 'Home', body: 'a' }
    expect(mergeJson(base, base, { title: 'Home', body: 'b' })).toEqual({
      value: { title: 'Home', body: 'b' },
      conflicts: [],
    })
  })

  it('merges disjoint object changes and reports nothing', () => {
    const base = { seo: { title: 'x', description: 'd' }, slug: 'home' }
    const ours = { seo: { title: 'x', description: 'ours' }, slug: 'home' }
    const theirs = { seo: { title: 'theirs', description: 'd' }, slug: 'home' }
    expect(mergeJson(base, ours, theirs)).toEqual({
      value: { seo: { title: 'theirs', description: 'ours' }, slug: 'home' },
      conflicts: [],
    })
  })

  it('reports a conflict by path and keeps ours there', () => {
    const base = { seo: { title: 'x' }, body: [1] }
    const ours = { seo: { title: 'ours' }, body: [1, 2] }
    const theirs = { seo: { title: 'theirs' }, body: [1, 3] }
    expect(mergeJson(base, ours, theirs)).toEqual({
      value: { seo: { title: 'ours' }, body: [1, 2] },
      conflicts: ['seo.title', 'body'],
    })
  })

  it('treats identical changes on both sides as agreement', () => {
    const base = { title: 'a' }
    expect(mergeJson(base, { title: 'b' }, { title: 'b' })).toEqual({ value: { title: 'b' }, conflicts: [] })
  })

  it('carries a deletion made on one side when the other side left the key alone', () => {
    const base = { a: 1, b: 2 }
    expect(mergeJson(base, { a: 1, b: 2 }, { a: 1 })).toEqual({ value: { a: 1 }, conflicts: [] })
    expect(mergeJson(base, { a: 1 }, { a: 1, b: 2 })).toEqual({ value: { a: 1 }, conflicts: [] })
  })

  it('flags delete-versus-edit as a conflict and keeps ours', () => {
    const base = { a: 1, b: 2 }
    expect(mergeJson(base, { a: 1, b: 3 }, { a: 1 })).toEqual({ value: { a: 1, b: 3 }, conflicts: ['b'] })
  })

  it('adds keys new on either side', () => {
    const base = { a: 1 }
    expect(mergeJson(base, { a: 1, ours: true }, { a: 1, theirs: true })).toEqual({
      value: { a: 1, ours: true, theirs: true },
      conflicts: [],
    })
  })

  it('merges without a base when both sides are new but agree partially', () => {
    expect(mergeJson(undefined, { a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({
      value: { a: 1, b: 2 },
      conflicts: ['b'],
    })
  })
})
