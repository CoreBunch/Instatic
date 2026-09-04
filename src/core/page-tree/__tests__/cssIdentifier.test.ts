import { describe, expect, it } from 'bun:test'
import { escapeCssIdentifier } from '../cssIdentifier'

const ch = (code: number) => String.fromCharCode(code)
const NULL = ch(0x0000)
const REPLACEMENT = ch(0xfffd)

// Vendored implementation of the CSS.escape algorithm
// (https://drafts.csswg.org/cssom/#serialize-an-identifier). These assertions
// match what the browser's native CSS.escape returns for the same inputs.
describe('escapeCssIdentifier', () => {
  it('replaces NULL (U+0000) with the replacement character U+FFFD', () => {
    expect(escapeCssIdentifier(NULL)).toBe(REPLACEMENT)
    expect(escapeCssIdentifier('a' + NULL + 'b')).toBe('a' + REPLACEMENT + 'b')
  })

  it('escapes control characters and DEL as a hex code point', () => {
    expect(escapeCssIdentifier(ch(0x0001))).toBe('\\1 ')
    expect(escapeCssIdentifier(ch(0x001f))).toBe('\\1f ')
    expect(escapeCssIdentifier(ch(0x007f))).toBe('\\7f ')
  })

  it('escapes a leading digit, and a digit after a leading dash, as a hex code point', () => {
    expect(escapeCssIdentifier('9lives')).toBe('\\39 lives')
    expect(escapeCssIdentifier('-9')).toBe('-\\39 ')
  })

  it('escapes a lone leading dash', () => {
    expect(escapeCssIdentifier('-')).toBe('\\-')
  })

  it('backslash-escapes other non-identifier characters', () => {
    expect(escapeCssIdentifier('a b')).toBe('a\\ b')
    expect(escapeCssIdentifier('a.b')).toBe('a\\.b')
  })

  it('passes identifier-safe characters (incl. non-ASCII) through unchanged', () => {
    expect(escapeCssIdentifier('ok-name_1')).toBe('ok-name_1')
    expect(escapeCssIdentifier('café')).toBe('café')
  })
})
