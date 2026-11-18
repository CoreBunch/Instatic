/**
 * The runtime version guard.
 *
 * Nothing in Bun enforces `engines.bun`, so the server and the dev launchers
 * check `Bun.version` themselves. The server only warns (a direct install must
 * keep serving across a version skew); `bun run dev` refuses, because on a Bun
 * older than the Vite proxy needs the editor's socket hangs with no error.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'
import {
  DEV_STACK_MIN_BUN,
  SUPPORTED_BUN_RANGE,
  devStackBunError,
  unsupportedBunWarning,
} from '../../../server/bunVersion'

describe('Bun version guard', () => {
  it('the server constant mirrors engines.bun in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { engines: { bun: string } }
    expect(SUPPORTED_BUN_RANGE).toBe(pkg.engines.bun)
  })

  it('the dev-stack minimum sits inside the supported range', () => {
    expect(satisfies(DEV_STACK_MIN_BUN, SUPPORTED_BUN_RANGE)).toBe(true)
  })

  it('the server stays quiet on a supported Bun and warns outside the range', () => {
    expect(unsupportedBunWarning('1.4.2')).toBeNull()
    expect(unsupportedBunWarning('1.4.9-canary.3')).toBeNull()
    const old = unsupportedBunWarning('1.3.11')
    expect(old).toContain('Bun 1.3.11')
    expect(old).toContain(SUPPORTED_BUN_RANGE)
    expect(old).toContain('bun upgrade')
    expect(unsupportedBunWarning('1.5.0')).not.toBeNull()
  })

  it('the dev launchers refuse anything older than the Vite proxy fix', () => {
    expect(devStackBunError('1.4.1')).toBeNull()
    expect(devStackBunError('1.4.2')).toBeNull()
    // Inside engines.bun, but before the node:http upgrade fix: still refused.
    expect(devStackBunError('1.4.0')).toContain('1.4.1')
    const old = devStackBunError('1.3.11')
    expect(old).toContain('Bun 1.3.11')
    expect(old).toContain('bun upgrade')
  })
})
