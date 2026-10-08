import type { StorageFilterValue } from './storageSchemas'

function equalValue(value: unknown, operand: unknown): boolean {
  // SQL comparisons with a missing/null operand do not satisfy a WHERE clause.
  if (value == null || operand == null) return false
  const left = typeof value === 'object' ? JSON.stringify(value) : value
  const right = typeof operand === 'object' ? JSON.stringify(operand) : operand
  return left === right
}

function compareValue(value: unknown, operand: unknown): number | null {
  if (typeof value === 'number' && typeof operand === 'number') return value - operand
  if (typeof value === 'string' && typeof operand === 'string') return value < operand ? -1 : value > operand ? 1 : 0
  if (typeof value === 'boolean' && typeof operand === 'boolean') return Number(value) - Number(operand)
  return null
}

/** SQL LIKE wildcards remain % and _; all other characters are literal. */
function matchesLike(value: unknown, pattern: string): boolean {
  if (value === null || value === undefined || typeof value === 'object') return false
  const expression = Array.from(pattern, character => character === '%' ? '.*' : character === '_' ? '.'
    : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^${expression}$`, 'isu').test(String(value))
}

/** The existing storage operator contract applied to already-projected values. */
export function matchesStorageFilterValue(value: unknown, filter: StorageFilterValue): boolean {
  if (filter === null || typeof filter !== 'object') return equalValue(value, filter)
  if (filter.eq !== undefined && !equalValue(value, filter.eq)) return false
  if (filter.ne !== undefined && (value == null || filter.ne === null || equalValue(value, filter.ne))) return false
  for (const [operator, operand] of [
    ['gt', filter.gt], ['gte', filter.gte], ['lt', filter.lt], ['lte', filter.lte],
  ] as const) {
    if (operand === undefined) continue
    const comparison = compareValue(value, operand)
    if (comparison === null) return false
    if (operator === 'gt' && comparison <= 0) return false
    if (operator === 'gte' && comparison < 0) return false
    if (operator === 'lt' && comparison >= 0) return false
    if (operator === 'lte' && comparison > 0) return false
  }
  if (filter.in !== undefined && !filter.in.some(operand => equalValue(value, operand))) return false
  if (filter.like !== undefined && !matchesLike(value, filter.like)) return false
  return true
}
