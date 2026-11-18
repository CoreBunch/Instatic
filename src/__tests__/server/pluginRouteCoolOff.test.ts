/**
 * Route cool-off: a route whose handler keeps overrunning its call budget is
 * held back for a short, growing while and resumes by itself. An overrun
 * never parks the plugin (a visitor who can reach a public route must not be
 * able to switch a plugin off).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearRouteCoolOffs,
  recordRouteOverrun,
  routeCoolOffRemainingMs,
} from '../../../server/plugins/host/routeCoolOff'
import { clearPluginCrashCounter, recordCrashAndDecide } from '../../../server/plugins/host/crashRecovery'

const PLUGIN = 'acme.cooloff'
const T0 = 1_000_000_000_000

afterEach(() => {
  clearRouteCoolOffs(PLUGIN)
  clearPluginCrashCounter(PLUGIN)
})

describe('route cool-off', () => {
  it('lets the first overrun pass, then grows 15 s, 30 s, 60 s, 2 min, capped at 5 min', () => {
    const steps = [0, 1, 2, 3, 4, 5, 6].map((n) => recordRouteOverrun(PLUGIN, 'GET:/slow', T0 + n * 1000))
    expect(steps).toEqual([0, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000])
  })

  it('holds the route back until the cool-off ends, then lets it through again', () => {
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0)
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/slow', T0 + 1)).toBe(0)
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0 + 1000)
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/slow', T0 + 1000)).toBe(15_000)
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/slow', T0 + 11_000)).toBe(5_000)
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/slow', T0 + 16_000)).toBe(0)
  })

  it('cools off only the route that overran', () => {
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0)
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0 + 1)
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/other', T0 + 2)).toBe(0)
    expect(routeCoolOffRemainingMs('acme.elsewhere', 'GET:/slow', T0 + 2)).toBe(0)
  })

  it('starts over after ten quiet minutes', () => {
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0)
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0 + 1)
    const later = T0 + 10 * 60_000 + 2
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/slow', later)).toBe(0)
    expect(recordRouteOverrun(PLUGIN, 'GET:/slow', later)).toBe(0)
  })

  it('is forgotten on a manual restart', () => {
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0)
    recordRouteOverrun(PLUGIN, 'GET:/slow', T0 + 1)
    clearPluginCrashCounter(PLUGIN)
    expect(routeCoolOffRemainingMs(PLUGIN, 'GET:/slow', T0 + 2)).toBe(0)
  })
})

describe('overrun accounting', () => {
  it('never parks the plugin, however many overruns', () => {
    const decisions = Array.from({ length: 50 }, (_, n) => recordCrashAndDecide(PLUGIN, T0 + n * 100, 'overrun'))
    expect(decisions.every((decision) => decision.kind === 'respawn')).toBe(true)
    expect(decisions[49].recentCrashCount).toBe(50)
  })

  it('does not bring a crash any closer to parking', () => {
    for (let n = 0; n < 10; n += 1) recordCrashAndDecide(PLUGIN, T0 + n, 'overrun')
    expect(recordCrashAndDecide(PLUGIN, T0 + 100, 'crash')).toEqual({ kind: 'respawn', recentCrashCount: 1 })
    expect(recordCrashAndDecide(PLUGIN, T0 + 101, 'crash')).toEqual({ kind: 'respawn', recentCrashCount: 2 })
    expect(recordCrashAndDecide(PLUGIN, T0 + 102, 'crash')).toEqual({ kind: 'give-up', recentCrashCount: 3 })
  })
})
