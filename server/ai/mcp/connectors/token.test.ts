import { describe, expect, it } from 'bun:test'
import { generatePersonalAccessToken, hashMcpSecret } from './token'

describe('connector token', () => {
  it('generates a prefixed, url-safe token', () => {
    const t = generatePersonalAccessToken()
    expect(t).toMatch(/^imcp_pat_[A-Za-z0-9_-]{43}$/)
  })

  it('generates distinct tokens', () => {
    expect(generatePersonalAccessToken()).not.toBe(generatePersonalAccessToken())
  })

  it('hashes deterministically and differs per token', async () => {
    const a = generatePersonalAccessToken()
    expect(await hashMcpSecret(a)).toBe(await hashMcpSecret(a))
    expect(await hashMcpSecret(a)).not.toBe(await hashMcpSecret(generatePersonalAccessToken()))
  })

  it('produces a url-safe hash with no padding', async () => {
    const h = await hashMcpSecret('imcp_example')
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
