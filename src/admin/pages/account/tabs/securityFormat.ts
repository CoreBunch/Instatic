import { getActiveAdminLocale } from "@admin/i18n"
export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(getActiveAdminLocale())
}
