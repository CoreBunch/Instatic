/**
 * Locale resolution for Directus translations.
 *
 * Deep-filtering a query to one hardcoded locale returns `name: null` for
 * every foreign address. This layer fetches every translation and resolves
 * in order: exact locale → same language other region → the row's country
 * default → any fr-* → first available. `names` always carries all 8 keys.
 */
import { SUPPORTED_LOCALES, isSupportedLocale, type SupportedLocale } from '@core/locales'

export { SUPPORTED_LOCALES, isSupportedLocale, type SupportedLocale }

export type LocaleNames = Record<SupportedLocale, string>

export interface DirectusTranslation {
  /** Raw `languages_code` as Directus sent it — matched against the catalog, never trusted as one. */
  languagesCode: string
  name: string
  fields: Record<string, string>
}

function countryDefaultLocale(country: string | undefined): SupportedLocale {
  return country?.toUpperCase() === 'FR' ? 'fr-FR' : 'fr-BE'
}

function languageOf(tag: string): string {
  return tag.split('-')[0]?.toLowerCase() ?? tag.toLowerCase()
}

function normalizeLocaleCode(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>
    if (typeof rec.code === 'string' && rec.code.trim()) return rec.code.trim()
    if (typeof rec.languages_code === 'string' && rec.languages_code.trim()) return rec.languages_code.trim()
  }
  return null
}

export function parseTranslations(raw: unknown): DirectusTranslation[] {
  if (!Array.isArray(raw)) return []
  const out: DirectusTranslation[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    const languagesCode = normalizeLocaleCode(rec.languages_code)
      ?? normalizeLocaleCode(rec.locale)
      ?? normalizeLocaleCode(rec.language)
    if (!languagesCode) continue
    const name = typeof rec.name === 'string' ? rec.name : ''
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(rec)) {
      if (typeof value === 'string') fields[key] = value
    }
    out.push({ languagesCode, name, fields })
  }
  return out
}

function pickTranslation(
  translations: readonly DirectusTranslation[],
  locale: SupportedLocale,
  country: string | undefined,
): DirectusTranslation | undefined {
  if (translations.length === 0) return undefined
  const exact = translations.find((row) => row.languagesCode === locale)
  if (exact && (exact.name || Object.keys(exact.fields).length > 0)) return exact

  const lang = languageOf(locale)
  const sameLanguage = translations.find((row) => languageOf(row.languagesCode) === lang && row.name)
  if (sameLanguage) return sameLanguage

  const countryLocale = countryDefaultLocale(country)
  const implied = translations.find((row) => row.languagesCode === countryLocale && row.name)
  if (implied) return implied

  const french = translations.find((row) => languageOf(row.languagesCode) === 'fr' && row.name)
  if (french) return french

  return translations.find((row) => row.name) ?? translations[0]
}

export function resolveName(
  translations: readonly DirectusTranslation[],
  locale: SupportedLocale,
  country: string | undefined,
  fallback = '',
): string {
  const picked = pickTranslation(translations, locale, country)
  return picked?.name || fallback
}

export function resolveTranslationFields(
  translations: readonly DirectusTranslation[],
  locale: SupportedLocale,
  country: string | undefined,
): Record<string, string> {
  return pickTranslation(translations, locale, country)?.fields ?? {}
}

export function expandNames(
  translations: readonly DirectusTranslation[],
  country: string | undefined,
  fallback = '',
): LocaleNames {
  const names = {} as LocaleNames
  for (const locale of SUPPORTED_LOCALES) {
    names[locale] = resolveName(translations, locale, country, fallback)
  }
  return names
}

export function translationsByLocale(
  translations: readonly DirectusTranslation[],
  country: string | undefined,
): Record<SupportedLocale, Record<string, string>> {
  const out = {} as Record<SupportedLocale, Record<string, string>>
  for (const locale of SUPPORTED_LOCALES) {
    out[locale] = resolveTranslationFields(translations, locale, country)
  }
  return out
}
