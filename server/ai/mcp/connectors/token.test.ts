import { describe, expect, it } from 'bun:test'
import { generateConnectorToken, hashConnectorToken } from './token'

describe('connector token', () => {
  it('generates a prefixed, url-safe token', () => {
    const t = generateConnectorToken()
    expect(t).toMatch(/^imcp_[A-Za-z0-9_-]{43}$/)
  })

  it('generates distinct tokens', () => {
    expect(generateConnectorToken()).not.toBe(generateConnectorToken())
  })

  it('hashes deterministically and differs per token', async () => {
    const a = generateConnectorToken()
    expect(await hashConnectorToken(a)).toBe(await hashConnectorToken(a))
    expect(await hashConnectorToken(a)).not.toBe(await hashConnectorToken(generateConnectorToken()))
  })

  it('produces a url-safe hash with no padding', async () => {
    const h = await hashConnectorToken('imcp_example')
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
