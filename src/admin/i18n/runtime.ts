import { DEFAULT_ADMIN_LOCALE, type AdminLocale } from './catalog'

let activeLocale: AdminLocale = DEFAULT_ADMIN_LOCALE

export function getActiveAdminLocale(): AdminLocale {
  return activeLocale
}

export function setActiveAdminLocale(locale: AdminLocale): void {
  activeLocale = locale
}

export function localizeAdminLiteral(english: string, chinese: string): string {
  return activeLocale === 'zh-CN' ? chinese : english
}

export function formatAdminLiteral(
  english: string,
  chinese: string,
  values: readonly unknown[],
): string {
  return localizeAdminLiteral(english, chinese).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = values[Number(index)]
    return value === undefined ? placeholder : String(value)
  })
}
