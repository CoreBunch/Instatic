export const CONTEXT_METER_SEGMENT_COUNT = 5

export type ContextMeterTone = 'empty' | 'healthy' | 'warning' | 'danger'

export interface ContextMeterMetrics {
  measured: boolean
  usedTokens: number
  remainingTokens: number
  usedPercentage: number | null
  remainingPercentage: number | null
  progressValue: number
  filledSegments: number
  tone: ContextMeterTone
}

/** Turn a current-context snapshot into the compact five-segment UI state. */
export function getContextMeterMetrics(
  usedTokens: number | null,
  windowTokens: number,
): ContextMeterMetrics {
  const measured = usedTokens !== null
  const safeUsed = measured ? Math.max(0, usedTokens) : 0
  const usedRatio = safeUsed / windowTokens
  const remainingTokens = Math.max(0, windowTokens - safeUsed)
  const remainingRatio = remainingTokens / windowTokens
  const filledSegments = measured
    ? Math.ceil(remainingRatio * CONTEXT_METER_SEGMENT_COUNT)
    : CONTEXT_METER_SEGMENT_COUNT
  const tone: ContextMeterTone = !measured
    ? 'empty'
    : usedRatio > 0.8
      ? 'danger'
      : usedRatio > 0.6
        ? 'warning'
        : 'healthy'

  return {
    measured,
    usedTokens: safeUsed,
    remainingTokens,
    usedPercentage: measured ? Math.round(usedRatio * 100) : null,
    remainingPercentage: measured ? Math.round(remainingRatio * 100) : null,
    progressValue: remainingTokens,
    filledSegments,
    tone,
  }
}
