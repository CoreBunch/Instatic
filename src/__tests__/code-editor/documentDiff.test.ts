/**
 * documentChanges — minimal in-place edits between two documents, so a
 * mounted buffer can follow a projection without losing its caret.
 */
import { describe, expect, it } from 'bun:test'
import { applyDocumentChanges, documentChanges } from '@site/code-editor/documentDiff'

function roundTrip(oldText: string, newText: string): ReturnType<typeof documentChanges> {
  const changes = documentChanges(oldText, newText)
  expect(applyDocumentChanges(oldText, changes)).toBe(newText)
  for (let i = 1; i < changes.length; i++) expect(changes[i].from).toBeGreaterThanOrEqual(changes[i - 1].to)
  return changes
}

describe('documentChanges', () => {
  it('returns nothing for identical documents', () => {
    expect(documentChanges('a\nb', 'a\nb')).toEqual([])
  })

  it('touches only the changed lines, leaving a caret elsewhere unmapped', () => {
    const changes = roundTrip('<div>\n  <p>Hi</p>\n  <span>x</span>\n</div>', '<div>\n  <p uid="a">Hi</p>\n  <span>x</span>\n</div>')
    expect(changes).toEqual([{ from: 6, to: 18, insert: '  <p uid="a">Hi</p>\n' }])
  })

  it('handles insertions, removals and edits in several regions', () => {
    roundTrip('a\nb\nc\nd\ne', 'a\nX\nc\ne\nf')
    roundTrip('a\nb\nc\nd', 'a\nd')
    roundTrip('a\nb', 'b')
    roundTrip('b', 'a\nb')
    roundTrip('a\nb\nc', 'a\nb\nc\nd\ne')
    roundTrip('one\ntwo\nthree', 'zero\none\nthree\nfour')
    roundTrip('a\nb\nc', 'a\nc')
    roundTrip('a\nc', 'a\nb\nc')
    roundTrip('a', 'a\nb')
    roundTrip('a\nb', 'a')
    roundTrip('', 'x\ny')
    roundTrip('x\ny', '')
  })

  it('falls back to one replacement for very large differing middles', () => {
    const oldText = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const newText = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join('\n')
    const changes = roundTrip(oldText, newText)
    expect(changes).toHaveLength(1)
  })
})
