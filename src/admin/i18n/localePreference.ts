import { Type, type Static } from '@sinclair/typebox'
import { safeParseJson } from '@core/utils/jsonValidate'
import { DEFAULT_ADMIN_LOCALE, type AdminLocale } from './catalog'
import { ADMIN_LOCALE_STORAGE_KEY } from './constants'

export { ADMIN_LOCALE_STORAGE_KEY } from './constants'

const AdminLocalePreferenceSchema = Type.Object(
  {
    locale: Type.Union([Type.Literal('en'), Type.Literal('zh-CN')]),
  },
  { additionalProperties: true },
)

type AdminLocalePreference = Static<typeof AdminLocalePreferenceSchema>

function browserStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage
}

export function readAdminLocalePreference(): AdminLocale | null {
  const storage = browserStorage()
  if (!storage) return null

  const raw = storage.getItem(ADMIN_LOCALE_STORAGE_KEY)
  if (!raw) return null

  const result = safeParseJson(raw, AdminLocalePreferenceSchema)
  return result.ok ? result.value.locale : null
}

export function writeAdminLocalePreference(locale: AdminLocale): void {
  const storage = browserStorage()
  if (!storage) return

  const preference: AdminLocalePreference = { locale }
  try {
    storage.setItem(ADMIN_LOCALE_STORAGE_KEY, JSON.stringify(preference))
  } catch (_err) {
    // Locale persistence is best-effort; the live selection still works.
  }
}

export function resolveInitialAdminLocale(): AdminLocale {
  const stored = readAdminLocalePreference()
  if (stored) return stored
  return DEFAULT_ADMIN_LOCALE
}
