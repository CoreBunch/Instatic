/**
 * Exact-text replacement engine shared by the code-asset and plugin-file
 * patch tools. The one property that matters most: replacement text is
 * inserted VERBATIM — `$$`, `$&` and friends are never interpreted the way
 * `String.prototype.replace` would.
 */
import { describe, expect, test } from 'bun:test'
import { applyExactReplacements, countOccurrences } from '@core/ai'

describe('applyExactReplacements', () => {
  test('inserts replacement text verbatim, including dollar patterns', () => {
    const source = 'const price = html`<p>${props.price}</p>`'
    const result = applyExactReplacements(source, [
      { oldText: '${props.price}', newText: '$${props.price}' },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toBe('const price = html`<p>$${props.price}</p>`')
    expect(result.replaced).toBe(1)

    const special = applyExactReplacements('a-b', [{ oldText: '-', newText: "$& $' $` $$ $1" }])
    expect(special.ok).toBe(true)
    if (special.ok) expect(special.content).toBe("a$& $' $` $$ $1b")
  })

  test('replaceAll substitutes every occurrence and counts them', () => {
    const result = applyExactReplacements('x.x.x', [{ oldText: 'x', newText: '$y', replaceAll: true }])
    expect(result).toEqual({ ok: true, content: '$y.$y.$y', replaced: 3 })
  })

  test('a missing or ambiguous match aborts and names the replacement', () => {
    const missing = applyExactReplacements('abc', [{ oldText: 'zzz', newText: '' }])
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('not-found')

    const ambiguous = applyExactReplacements('aXa', [{ oldText: 'a', newText: 'b' }])
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) {
      expect(ambiguous.reason).toBe('ambiguous')
      expect(ambiguous.matches).toBe(2)
      expect(ambiguous.replacement.oldText).toBe('a')
    }
  })

  test('replacements apply in order, each against the previous result', () => {
    const result = applyExactReplacements('one two', [
      { oldText: 'one', newText: 'two' },
      { oldText: 'two', newText: 'three', replaceAll: true },
    ])
    expect(result).toEqual({ ok: true, content: 'three three', replaced: 3 })
  })

  test('countOccurrences counts non-overlapping matches and treats an empty search as none', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('abc', '')).toBe(0)
  })
})
