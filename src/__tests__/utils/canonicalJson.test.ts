import { describe, expect, it } from 'bun:test'
import { canonicalJson } from '@core/utils/canonicalJson'

describe('canonicalJson', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalJson({ b: { d: 1, c: [2, { f: 3, e: 4 }] }, a: 'x' })).toBe('{"a":"x","b":{"c":[2,{"e":4,"f":3}],"d":1}}')
  })

  it('serialises an in-memory value the same as its JSON round-trip', () => {
    const value = { a: undefined, b: [undefined, 1], c: { d: undefined } }
    expect(canonicalJson(value)).toBe(canonicalJson(JSON.parse(JSON.stringify(value))))
    expect(canonicalJson(value)).toBe('{"b":[null,1],"c":{}}')
  })
})
