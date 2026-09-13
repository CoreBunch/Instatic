import { describe, expect, it } from 'bun:test'
import {
  BRANCH_ID_PATTERN,
  MAIN_BRANCH_ID,
  isValidBranchId,
  logicalIdOf,
  physicalId,
  slugifyBranchName,
} from '@core/branches'

describe('branch ids', () => {
  it('keeps main rows on their logical id and prefixes every other branch', () => {
    expect(physicalId(MAIN_BRANCH_ID, 'abc')).toBe('abc')
    expect(physicalId('spring-redesign', 'abc')).toBe('spring-redesign:abc')
    expect(physicalId('spring-redesign', 'pages')).toBe('spring-redesign:pages')
  })

  it('inverts the physical id for the branch that minted it', () => {
    expect(logicalIdOf('spring-redesign', 'spring-redesign:abc')).toBe('abc')
    expect(logicalIdOf(MAIN_BRANCH_ID, 'abc')).toBe('abc')
    // A logical id may itself contain a colon — only the branch prefix is stripped.
    expect(logicalIdOf('b1', 'b1:with:colon')).toBe('with:colon')
  })

  it('round-trips ids that contain the separator', () => {
    const logical = 'weird:id'
    expect(logicalIdOf('b1', physicalId('b1', logical))).toBe(logical)
  })

  it('refuses branch ids that would break the physical id scheme', () => {
    expect(isValidBranchId('main')).toBe(true)
    expect(isValidBranchId('spring-redesign')).toBe(true)
    expect(isValidBranchId('v2.1')).toBe(true)
    expect(isValidBranchId('with:colon')).toBe(false)
    expect(isValidBranchId('Upper')).toBe(false)
    expect(isValidBranchId('')).toBe(false)
    expect(isValidBranchId('-leading')).toBe(false)
    expect(isValidBranchId('a'.repeat(65))).toBe(false)
    expect(BRANCH_ID_PATTERN.test('a'.repeat(64))).toBe(true)
  })

  it('derives ids from human names', () => {
    expect(slugifyBranchName('Spring Redesign')).toBe('spring-redesign')
    expect(slugifyBranchName('  Pricing: Experiment #2 ')).toBe('pricing-experiment-2')
    expect(slugifyBranchName('v2.1 launch')).toBe('v2.1-launch')
    expect(slugifyBranchName('---')).toBe('')
    expect(isValidBranchId(slugifyBranchName('A'.repeat(100)))).toBe(true)
  })
})
