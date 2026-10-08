import { describe, expect, it } from 'bun:test'
import { matchesStorageFilterValue } from './storageFilter'

describe('projected storage filter operators', () => {
  it('applies equality, inequality, ranges and membership as conjunctions', () => {
    expect(matchesStorageFilterValue('Alpha', 'Alpha')).toBe(true)
    expect(matchesStorageFilterValue('Alpha', { eq: 'alpha' })).toBe(false)
    expect(matchesStorageFilterValue('Alpha', { ne: 'Beta', in: ['Alpha', 'Gamma'] })).toBe(true)
    expect(matchesStorageFilterValue('Alpha', { ne: 'Alpha' })).toBe(false)
    expect(matchesStorageFilterValue(7, { gt: 5, gte: 7, lt: 9, lte: 7, in: [6, 7] })).toBe(true)
    expect(matchesStorageFilterValue(7, { gt: 7 })).toBe(false)
    expect(matchesStorageFilterValue(7, { lt: 7 })).toBe(false)
    expect(matchesStorageFilterValue(7, { gte: 8 })).toBe(false)
    expect(matchesStorageFilterValue(7, { lte: 6 })).toBe(false)
    expect(matchesStorageFilterValue('Beta', { gt: 'Alpha', lt: 'Gamma' })).toBe(true)
    expect(matchesStorageFilterValue(true, { eq: true })).toBe(true)
    expect(matchesStorageFilterValue(false, { eq: true })).toBe(false)
    expect(matchesStorageFilterValue('Alpha', { in: [] })).toBe(false)
    expect(matchesStorageFilterValue(['one', 'two'], { eq: ['one', 'two'] })).toBe(true)
    expect(matchesStorageFilterValue(['one', 'two'], { eq: ['two', 'one'] })).toBe(false)
  })

  it('retains SQL null semantics for comparisons and membership', () => {
    for (const value of [null, undefined]) {
      expect(matchesStorageFilterValue(value, null)).toBe(false)
      expect(matchesStorageFilterValue(value, { eq: null })).toBe(false)
      expect(matchesStorageFilterValue(value, { ne: 'Alpha' })).toBe(false)
      expect(matchesStorageFilterValue(value, { gt: 1 })).toBe(false)
      expect(matchesStorageFilterValue(value, { in: [null, 'Alpha'] })).toBe(false)
      expect(matchesStorageFilterValue(value, { like: '%' })).toBe(false)
      expect(matchesStorageFilterValue(value, {})).toBe(true)
    }
    expect(matchesStorageFilterValue('Alpha', { ne: null })).toBe(false)
    expect(matchesStorageFilterValue('Alpha', { in: [null, 'Alpha'] })).toBe(true)
  })

  it('uses case-insensitive SQL LIKE wildcards while treating regex syntax literally', () => {
    expect(matchesStorageFilterValue('Sicherheit', { like: '%SICHER%' })).toBe(true)
    expect(matchesStorageFilterValue('Alpha', { like: 'A_ph%' })).toBe(true)
    expect(matchesStorageFilterValue('Alpha', { like: 'A__ha' })).toBe(true)
    expect(matchesStorageFilterValue('Alpha', { like: 'A_ha' })).toBe(false)
    expect(matchesStorageFilterValue('A[1].x', { like: 'A[1].%' })).toBe(true)
    expect(matchesStorageFilterValue('A1-x', { like: 'A[1].%' })).toBe(false)
    expect(matchesStorageFilterValue('first\nsecond', { like: 'first%second' })).toBe(true)
    expect(matchesStorageFilterValue({ key: 'entry.title' }, { like: '%entry.title%' })).toBe(false)
  })
})
