import { Type } from '@core/utils/typeboxHelpers'

export const DIRECTORY_PAGE_SIZE = 50

export const directoryPageFields = {
  offset: Type.Integer({ minimum: 0 }),
  matching: Type.Integer({ minimum: 0 }),
}

/** A deletion can remove the requested page between visits. Return the last available page. */
export function directoryPageOffset(requested: number, matching: number): number {
  const page = Number.isSafeInteger(requested) ? Math.floor(requested / DIRECTORY_PAGE_SIZE) : 0
  const lastPage = Math.ceil(matching / DIRECTORY_PAGE_SIZE) - 1
  return Math.max(0, Math.min(page, lastPage)) * DIRECTORY_PAGE_SIZE
}
