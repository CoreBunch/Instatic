import type { PropertyCondition } from '@core/value-conditions-schema'

/** Declarative value conditions shared by property controls and native forms. */
export function evaluateCondition(condition: PropertyCondition, values: Record<string, unknown>): boolean {
  if ('and' in condition) return condition.and.every((child) => evaluateCondition(child, values))
  if ('or' in condition) return condition.or.some((child) => evaluateCondition(child, values))
  if ('eq' in condition) return values[condition.field] === condition.eq
  if ('notEq' in condition) return values[condition.field] !== condition.notEq
  if ('in' in condition) return condition.in.includes(values[condition.field])
  return !condition.notIn.includes(values[condition.field])
}
