import { SUPPORTED_LOCALES, isSupportedLocale, type SupportedLocale } from '@core/locales'
import { directusBadRequest } from './errors'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function assertNoControlChars(field: string, value: string): void {
  if (hasControlChars(value)) {
    throw directusBadRequest(`'${field}' contains control characters`)
  }
}

export function assertUuid(field: string, value: string): void {
  assertNoControlChars(field, value)
  if (!UUID_RE.test(value)) {
    throw directusBadRequest(`'${field}' must be a uuid`)
  }
}

export function optionalNonEmpty(field: string, raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined
  const value = raw.trim()
  if (!value) return undefined
  assertNoControlChars(field, value)
  return value
}

export function optionalUuid(field: string, raw: string | null | undefined): string | undefined {
  const value = optionalNonEmpty(field, raw)
  if (value === undefined) return undefined
  assertUuid(field, value)
  return value
}

export function parseLimit(raw: string | null | undefined, fallback = 100): number {
  if (raw == null || raw === '') return fallback
  assertNoControlChars('limit', raw)
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw directusBadRequest("'limit' must be an integer from 1 to 1000")
  }
  return n
}

export function parsePage(raw: string | null | undefined, fallback = 1): number {
  if (raw == null || raw === '') return fallback
  assertNoControlChars('page', raw)
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw directusBadRequest("'page' must be a 1-based integer")
  }
  return n
}

export function parseBool(raw: string | null | undefined): boolean {
  if (raw == null || raw === '') return false
  assertNoControlChars('all_locales', raw)
  return raw === 'true' || raw === '1'
}

export function assertSupportedLocale(value: string): SupportedLocale {
  if (!isSupportedLocale(value)) {
    throw directusBadRequest(`'locale' must be one of ${SUPPORTED_LOCALES.join(', ')}`)
  }
  return value
}

/** `?locale=` query param: absent/blank → undefined, anything outside the catalog → 400. */
export function optionalLocale(raw: string | null | undefined): SupportedLocale | undefined {
  const value = optionalNonEmpty('locale', raw)
  if (value === undefined) return undefined
  return assertSupportedLocale(value)
}
