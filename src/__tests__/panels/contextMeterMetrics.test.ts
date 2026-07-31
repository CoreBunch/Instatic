import { describe, expect, it } from 'bun:test'
import { getContextMeterMetrics } from '@site/panels/AgentPanel'

describe('context meter metrics', () => {
  it.each([
    [null, 5, 'empty'],
    [0, 5, 'healthy'],
    [1, 5, 'healthy'],
    [200, 4, 'healthy'],
    [400, 3, 'healthy'],
    [600, 2, 'healthy'],
    [601, 2, 'warning'],
    [800, 1, 'warning'],
    [801, 1, 'danger'],
    [1000, 0, 'danger'],
    [1200, 0, 'danger'],
  ] as const)(
    'maps %s used tokens to %s filled segments and %s tone',
    (usedTokens, filledSegments, tone) => {
      const metrics = getContextMeterMetrics(usedTokens, 1000)
      expect(metrics.filledSegments).toBe(filledSegments)
      expect(metrics.tone).toBe(tone)
    },
  )

  it('keeps unknown context indeterminate and clamps invalid progress values', () => {
    expect(getContextMeterMetrics(null, 1000)).toMatchObject({
      measured: false,
      usedPercentage: null,
      remainingPercentage: null,
      progressValue: 1000,
      remainingTokens: 1000,
    })
    expect(getContextMeterMetrics(-50, 1000)).toMatchObject({
      measured: true,
      usedTokens: 0,
      progressValue: 1000,
      usedPercentage: 0,
      remainingPercentage: 100,
    })
    expect(getContextMeterMetrics(1200, 1000)).toMatchObject({
      measured: true,
      progressValue: 0,
      remainingTokens: 0,
      usedPercentage: 120,
      remainingPercentage: 0,
    })
  })
})
