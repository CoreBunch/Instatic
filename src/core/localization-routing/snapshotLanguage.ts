import type { Locale } from '@core/localization-schema'

/** Stored releases before localization keep their original settings language. */
export function readSnapshotLanguage(
  localeId: string,
  locales: readonly Locale[] | undefined,
  storedLanguage: string | undefined,
): Pick<Locale, 'code' | 'direction'> {
  const locale = locales?.find((entry) => entry.id === localeId)
  if (locale) return { code: locale.code, direction: locale.direction }
  const code = storedLanguage || 'en'
  const base = code.toLowerCase().split('-')[0]
  return { code, direction: ['ar', 'fa', 'he', 'ur', 'ps', 'dv', 'yi'].includes(base) ? 'rtl' : 'ltr' }
}
