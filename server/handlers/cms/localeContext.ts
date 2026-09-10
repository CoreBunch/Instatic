import { Type, parseValue } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { getDefaultLocale, getLocale } from '../../repositories/localization'
import { badRequest, jsonResponse } from '../../http'

const LocaleQuerySchema = Type.String({ minLength: 1, maxLength: 100 })

/** Resolve an explicit language once at the HTTP boundary. Omission selects the source. */
export async function requestLocale(req: Request, db: DbClient, bodyLocaleId?: string) {
  const queryLocaleId = new URL(req.url).searchParams.get('localeId')
  if (bodyLocaleId && queryLocaleId && bodyLocaleId !== queryLocaleId) {
    return badRequest('The language in the URL and request body must match')
  }
  const rawId = bodyLocaleId ?? queryLocaleId
  if (rawId === null || rawId === undefined) return getDefaultLocale(db)
  let id: string
  try {
    id = parseValue(LocaleQuerySchema, rawId)
  } catch (_err) {
    // Invalid URL input is a client error, never an implicit source-language edit.
    return badRequest('Invalid language identifier')
  }
  const locale = await getLocale(db, id)
  return locale ?? jsonResponse({ error: 'Language not found' }, { status: 404 })
}
