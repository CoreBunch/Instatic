/**
 * Locale catalog.
 *
 * Exactly the 8 BCP 47 tags the Directus API client supports. It is the
 * single source of truth for every locale surface: the Directus reader and
 * its translation fallback, MCP tool enums, and (as they land) the Page and
 * Content settings pickers. `locale-enum-usage.test.ts` gates every other
 * surface against it, so a new feature cannot re-open the field to any string.
 */
import { Type } from '@core/utils/typeboxHelpers'

export const SUPPORTED_LOCALES = [
  'fr-BE',
  'nl-BE',
  'de-BE',
  'en-BE',
  'fr-FR',
  'en-FR',
  'nl-NL',
  'en-NL',
] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

const SUPPORTED_LOCALE_SET: ReadonlySet<string> = new Set(SUPPORTED_LOCALES)

const SUPPORTED_LOCALE_ENUM = Object.fromEntries(SUPPORTED_LOCALES.map((code) => [code, code])) as {
  [K in SupportedLocale]: K
}

/** Compact JSON Schema `enum` so MCP / API clients see every allowed tag. */
export const SupportedLocaleSchema = Type.Enum(SUPPORTED_LOCALE_ENUM)

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === 'string' && SUPPORTED_LOCALE_SET.has(value)
}
