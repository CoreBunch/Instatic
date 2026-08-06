import { createContext, useContext } from 'react'
import { translate, type AdminLocale, type MessageKey, type MessageParams } from './catalog'

export interface I18nContextValue {
  locale: AdminLocale
  setLocale: (locale: AdminLocale) => void
  t: (key: MessageKey, params?: MessageParams) => string
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key, params) => translate('en', key, params),
})

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
