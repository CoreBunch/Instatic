/**
 * pageRef.test.ts — internal page-reference helpers.
 */

import { describe, it, expect } from 'bun:test'
import { makePageRef, isPageRef, parsePageRef, resolvePageRef } from '@core/page-tree'

const PAGES = [
  { id: 'home1', slug: 'index' },
  { id: 'club1', slug: 'club' },
]

describe('makePageRef / parsePageRef', () => {
  it('round-trips a plain page id', () => {
    const ref = makePageRef('club1')
    expect(ref).toBe('cms:page:club1')
    expect(parsePageRef(ref)).toEqual({ pageId: 'club1', suffix: '' })
  })

  it('round-trips with a fragment', () => {
    expect(makePageRef('club1', '#join')).toBe('cms:page:club1#join')
    expect(makePageRef('club1', 'join')).toBe('cms:page:club1#join')
    expect(parsePageRef('cms:page:club1#join')).toEqual({ pageId: 'club1', suffix: '#join' })
  })

  it('isPageRef distinguishes refs from URLs', () => {
    expect(isPageRef('cms:page:x')).toBe(true)
    expect(isPageRef('/club')).toBe(false)
    expect(isPageRef('https://x.com')).toBe(false)
    expect(parsePageRef('https://x.com')).toBeNull()
  })
})

describe('resolvePageRef', () => {
  it('resolves a normal page to /slug', () => {
    expect(resolvePageRef('cms:page:club1', PAGES)).toBe('/club')
  })

  it('resolves the home page (slug "index") to "/"', () => {
    expect(resolvePageRef('cms:page:home1', PAGES)).toBe('/')
  })

  it('preserves the fragment', () => {
    expect(resolvePageRef('cms:page:club1#join', PAGES)).toBe('/club#join')
  })

  it('returns "#" for a deleted/missing page (dynamic safety)', () => {
    expect(resolvePageRef('cms:page:gone', PAGES)).toBe('#')
  })

  it('returns null for a non-ref value (caller keeps it)', () => {
    expect(resolvePageRef('https://example.com', PAGES)).toBeNull()
    expect(resolvePageRef('/about', PAGES)).toBeNull()
  })

  it('follows a slug rename (same id, new slug → new path)', () => {
    const renamed = [{ id: 'club1', slug: 'community' }]
    expect(resolvePageRef('cms:page:club1', renamed)).toBe('/community')
  })
})
