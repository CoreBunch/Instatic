import { useAgentStore } from '@admin/ai/useAgentStore'
import { formatCost, formatNumber } from '@admin/ai/usageFormat'
import { Button } from '@ui/components/Button'
import { Tooltip } from '@ui/components/Tooltip'
import {
  CONTEXT_METER_SEGMENT_COUNT,
  getContextMeterMetrics,
  type ContextMeterTone,
} from './contextMeterMetrics'
import styles from './ContextMeter.module.css'

interface ContextMeterProps {
  /** Active selection, used to reject a snapshot measured by another provider/model. */
  credentialId: string | null
  modelId: string | null
  /** Active model's max context window, or null when unknown (hides the meter). */
  windowTokens: number | null
  pricing: {
    inputPerMTok: number
    outputPerMTok: number
  } | null
}

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Math.round((tokens / 1_000_000) * 10) / 10}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

function formatRate(value: number): string {
  if (value === 0) return '$0'
  const amount = value < 1 ? value.toFixed(2) : String(Math.round(value * 100) / 100)
  return `$${amount}`
}

function toneLabel(tone: ContextMeterTone): string {
  if (tone === 'healthy') return 'Comfortable'
  if (tone === 'warning') return 'Getting full'
  if (tone === 'danger') return 'Nearly full'
  return 'Not measured'
}

function Segments({ filled }: { filled: number }) {
  return Array.from({ length: CONTEXT_METER_SEGMENT_COUNT }, (_, index) => (
    <span
      key={index}
      data-context-segment=""
      data-filled={index < filled ? 'true' : 'false'}
    />
  ))
}

export function ContextMeter({ credentialId, modelId, windowTokens, pricing }: ContextMeterProps) {
  const usage = useAgentStore((state) => state.agentUsage)

  if (windowTokens === null || windowTokens <= 0) return null

  const selectionOwnsContext = usage.contextCredentialId === credentialId
    && usage.contextModelId === modelId
  const conversationIsEmpty = usage.promptTokens === 0
    && usage.completionTokens === 0
    && usage.cacheReadTokens === 0
    && usage.cacheCreationTokens === 0
    && usage.costUsd === 0
  const currentContext = selectionOwnsContext && usage.contextTokens !== null
    ? usage.contextTokens
    : conversationIsEmpty
      ? 0
      : null
  const metrics = getContextMeterMetrics(currentContext, windowTokens)
  const valueText = metrics.measured
    ? `${formatNumber(metrics.remainingTokens)} of ${formatNumber(windowTokens)} context tokens available (${metrics.remainingPercentage}%)`
    : `Context has not been measured for this model yet; ${formatNumber(windowTokens)} token window`

  const details = (
    <div className={styles.details}>
      <div className={styles.detailsHeader}>
        <div>
          <span className={styles.eyebrow}>Context remaining</span>
          <strong className={styles.contextHeadline}>
            {metrics.measured ? `${metrics.remainingPercentage}% available` : 'Waiting for a response'}
          </strong>
        </div>
        <span className={styles.status} data-tone={metrics.tone}>
          {toneLabel(metrics.tone)}
        </span>
      </div>

      <div className={styles.detailsGauge} data-tone={metrics.tone} aria-hidden="true">
        <Segments filled={metrics.filledSegments} />
      </div>

      <div className={styles.contextNumbers}>
        {metrics.measured ? (
          <>
            <span>{compactTokens(metrics.usedTokens)} used</span>
            <span>{compactTokens(metrics.remainingTokens)} available</span>
          </>
        ) : (
          <>
            <span>Updates after the next response</span>
            <span>{compactTokens(windowTokens)} window</span>
          </>
        )}
      </div>

      <div className={styles.billingHeader}>
        <span className={styles.eyebrow}>Conversation billing</span>
        <strong>{formatCost(usage.costUsd)}</strong>
      </div>
      <dl className={styles.usageGrid}>
        <div>
          <dt>Input</dt>
          <dd>{formatNumber(usage.promptTokens)}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{formatNumber(usage.completionTokens)}</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>{formatNumber(usage.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{formatNumber(usage.cacheCreationTokens)}</dd>
        </div>
      </dl>

      {pricing && (
        <div className={styles.pricing}>
          <span>Current model · per 1M tokens</span>
          <strong>
            {formatRate(pricing.inputPerMTok)} in · {formatRate(pricing.outputPerMTok)} out
          </strong>
        </div>
      )}
    </div>
  )

  return (
    <Tooltip content={details} side="top" align="end" size="wide" openOnFocus>
      <Button
        variant="ghost"
        size="xs"
        className={styles.meter}
        data-tone={metrics.tone}
        data-filled-segments={metrics.filledSegments}
        aria-label={`AI context remaining: ${valueText}`}
      >
        <span className={styles.battery} aria-hidden="true">
          <Segments filled={metrics.filledSegments} />
        </span>
      </Button>
    </Tooltip>
  )
}
