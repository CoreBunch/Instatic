import type { TranslationFieldMetadata, TranslationMetadata } from '@core/localization-schema'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { deepEqual } from '@core/utils/deepEqual'
import { cloneContentValue } from './contentValues'
import { LocalizationValidationError } from './errors'

export const TranslationFieldStateSchema = Type.Union([
  Type.Literal('missing'),
  Type.Literal('inherited'),
  Type.Literal('needs_review'),
  Type.Literal('reviewed'),
])
export type TranslationFieldState = Static<typeof TranslationFieldStateSchema>

function canonicalSource(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalSource).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalSource(entry)}`)
      .join(',')}}`
  }
  throw new LocalizationValidationError('source', 'Translation source must contain JSON values.')
}

/**
 * Deterministic content-change fingerprint, not an authenticity/security hash.
 * Two independent 32-bit accumulators plus length keep it compact for rich
 * text while distinguishing missing, empty and null source values. Object key
 * insertion order has no effect; array order and rich-text content do.
 */
export function translationSourceFingerprint(value: unknown): string {
  const source = canonicalSource(value)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x5bd1e995)
  }
  return `${source.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`
}

export function createTranslationFieldMetadata(
  sourceValue: unknown,
  reviewState: TranslationFieldMetadata['reviewState'] = 'needs_review',
): TranslationFieldMetadata {
  return { sourceFingerprint: translationSourceFingerprint(sourceValue), reviewState }
}

/** A reviewed translation becomes stale when the current source fingerprint differs. */
export function getTranslationFieldState(
  sourceValues: Record<string, unknown>,
  localizedValues: Record<string, unknown>,
  field: string,
  metadata?: TranslationFieldMetadata,
): TranslationFieldState {
  if (!Object.hasOwn(localizedValues, field)) {
    return Object.hasOwn(sourceValues, field) ? 'inherited' : 'missing'
  }
  if (metadata?.reviewState === 'reviewed'
    && metadata.sourceFingerprint === translationSourceFingerprint(Object.hasOwn(sourceValues, field) ? sourceValues[field] : undefined)) {
    return 'reviewed'
  }
  return 'needs_review'
}

/** Record the source at each changed translation; resetting a field removes its review metadata. */
export function updateTranslationMetadata(
  sourceValues: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  previous: TranslationMetadata,
  reviewState: TranslationFieldMetadata['reviewState'] = 'needs_review',
): TranslationMetadata {
  const result = cloneContentValue(previous)
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const hadValue = Object.hasOwn(before, key)
    const hasValue = Object.hasOwn(after, key)
    if (!hasValue) {
      delete result[key]
    } else if (!hadValue || !deepEqual(before[key], after[key])) {
      Object.defineProperty(result, key, {
        value: createTranslationFieldMetadata(Object.hasOwn(sourceValues, key) ? sourceValues[key] : undefined, reviewState),
        enumerable: true, configurable: true, writable: true,
      })
    }
  }
  return result
}
