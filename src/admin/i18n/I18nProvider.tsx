import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react'
import { translate, type AdminLocale, type MessageKey, type MessageParams } from './catalog'
import {
  ADMIN_LOCALE_STORAGE_KEY,
  resolveInitialAdminLocale,
  writeAdminLocalePreference,
} from './localePreference'
import { setActiveAdminLocale } from './runtime'
import { I18nContext } from './context'
import { UiMessagesContext } from '@ui/i18n'
import { uiMessageCatalogs } from './uiMessages'

interface I18nProviderProps {
  children: ReactNode
  initialLocale?: AdminLocale
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<AdminLocale>(
    () => initialLocale ?? resolveInitialAdminLocale(),
  )
  setActiveAdminLocale(locale)

  useLayoutEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    function handleStorage(event: StorageEvent): void {
      if (event.key !== null && event.key !== ADMIN_LOCALE_STORAGE_KEY) return
      setLocaleState(resolveInitialAdminLocale())
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  function setLocale(nextLocale: AdminLocale): void {
    setLocaleState(nextLocale)
    writeAdminLocalePreference(nextLocale)
  }

  function t(key: MessageKey, params?: MessageParams): string {
    return translate(locale, key, params)
  }

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      <UiMessagesContext.Provider value={uiMessageCatalogs[locale]}>
        <Fragment key={locale}>{children}</Fragment>
      </UiMessagesContext.Provider>
    </I18nContext.Provider>
  )
}
