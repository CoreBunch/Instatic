import { Type, Value } from '@core/utils/typeboxHelpers'

/** Stable authored identity shared by the translated versions of one page. */
export const PageTranslationGroupSchema = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' })

export class PageTranslationError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'PageTranslationError'
    this.path = path
  }
}

export function parsePageTranslationGroup(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (!Value.Check(PageTranslationGroupSchema, value)) {
    throw new PageTranslationError(path, 'Translation group must be a stable identifier of 1–128 letters, digits, dots, colons, underscores or hyphens')
  }
  return value
}
