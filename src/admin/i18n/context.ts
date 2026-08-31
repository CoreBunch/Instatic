import { createContext, useContext } from 'react'
import { DEFAULT_ADMIN_LOCALE, translate, type AdminLocale, type MessageKey, type MessageParams } from './catalog'

export interface I18nContextValue {
  locale: AdminLocale
  setLocale: (locale: AdminLocale) => void
  t: (key: MessageKey, params?: MessageParams) => string
}

export const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_ADMIN_LOCALE,
  setLocale: () => {},
  t: (key, params) => translate(DEFAULT_ADMIN_LOCALE, key, params),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
