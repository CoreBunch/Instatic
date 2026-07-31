/** Shared number and USD formatting for AI usage surfaces. */

/** Whole-number with locale grouping, no fraction (e.g. token + chat counts). */
export function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

/** USD spend: $0.00, "< $0.01" for tiny non-zero values, else 2-dp grouped. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `< $0.01`
  if (usd < 1) return `$${usd.toFixed(2)}`
  return `$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}
