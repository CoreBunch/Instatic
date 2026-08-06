import type { AdminLocale } from './catalog'

let activeLocale: AdminLocale = 'zh-CN'

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
