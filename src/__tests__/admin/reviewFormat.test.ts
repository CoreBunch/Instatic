/**
 * Timestamp phrasing on the merge review page.
 *
 * `relativeIso` is the bare stamp a column renders on its own; `relativeIsoAgo`
 * is the past-tense phrase a sentence embeds. They differ only under a minute,
 * where the bare form is "now" and appending the word would read "now ago".
 */
import { describe, expect, it } from 'bun:test'
import { relativeIso, relativeIsoAgo } from '@admin/pages/branches/reviewFormat'

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

describe('relativeIso', () => {
  it('reads "now" under a minute', () => {
    expect(relativeIso(isoAgo(5_000))).toBe('now')
  })

  it('counts minutes, hours and days', () => {
    expect(relativeIso(isoAgo(3 * 60_000))).toBe('3m')
    expect(relativeIso(isoAgo(2 * 3_600_000))).toBe('2h')
    expect(relativeIso(isoAgo(4 * 86_400_000))).toBe('4d')
  })

  it('is empty for an unparsable stamp', () => {
    expect(relativeIso('not a date')).toBe('')
  })
})

describe('relativeIsoAgo', () => {
  it('says "just now" instead of "now ago"', () => {
    expect(relativeIsoAgo(isoAgo(5_000))).toBe('just now')
  })

  it('appends "ago" to every older stamp', () => {
    expect(relativeIsoAgo(isoAgo(3 * 60_000))).toBe('3m ago')
    expect(relativeIsoAgo(isoAgo(2 * 3_600_000))).toBe('2h ago')
    expect(relativeIsoAgo(isoAgo(4 * 86_400_000))).toBe('4d ago')
  })

  it('stays empty for an unparsable stamp rather than reading " ago"', () => {
    expect(relativeIsoAgo('not a date')).toBe('')
  })
})
