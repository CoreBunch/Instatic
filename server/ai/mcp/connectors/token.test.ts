import { describe, expect, it } from 'bun:test'
import { generatePersonalAccessToken } from './token'

describe('personal access token', () => {
  it('is prefixed and url-safe', () => {
    expect(generatePersonalAccessToken()).toMatch(/^imcp_pat_[A-Za-z0-9_-]{43}$/)
  })

  it('differs every time', () => {
    expect(generatePersonalAccessToken()).not.toBe(generatePersonalAccessToken())
  })
})
