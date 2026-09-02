/**
 * Optional live probe against DEV Directus. GET only. Skips when the
 * reader is unconfigured or offline. When the probe answers, it must be
 * honest: a gateway denial is `reachable: false` with a reason, never
 * `reachable: true`.
 */
import { describe, expect, it } from 'bun:test'
import { readDirectusConfig } from '../config'
import { createDirectusClient } from './client'

const config = readDirectusConfig()

describe('live Directus reader', () => {
  it('skips or reaches a configured instance without writing', async () => {
    if (!config) return
    const client = createDirectusClient({ config })
    let health: Awaited<ReturnType<typeof client.getHealth>>
    try {
      health = await client.getHealth()
    } catch {
      // Offline checkout still passes.
      return
    }
    if (health.reachable) {
      expect(health.status).toBeLessThan(400)
      expect(health.reason).toBeUndefined()
      return
    }
    expect(health.reason).toBeString()
    expect(health.reason?.length).toBeGreaterThan(0)
  })
})
