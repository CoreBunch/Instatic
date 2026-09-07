import { nanoid } from 'nanoid'
import { LocaleSchema, type Locale, type LocaleInput, type LocaleUpdateInput } from '@core/localization-schema'
import { LocalizedRouteError, normalizeLocalePathPrefix } from '@core/localization-routing'
import { parseValue } from '@core/utils/typeboxHelpers'
import type { DbClient } from '../../db/client'
import { LocalizationError } from './errors'

interface LocaleRow {
  id: string
  code: string
  name: string
  path_prefix: string
  is_default: boolean | number
  enabled: boolean | number
  direction: string
}

function mapLocale(row: LocaleRow): Locale {
  return parseValue(LocaleSchema, {
    id: row.id,
    code: row.code,
    name: row.name,
    pathPrefix: row.path_prefix,
    isDefault: Boolean(row.is_default),
    enabled: Boolean(row.enabled),
    direction: row.direction,
  })
}

export async function listLocales(db: DbClient): Promise<Locale[]> {
  const { rows } = await db<LocaleRow>`
    select id, code, name, path_prefix, is_default, enabled, direction
    from site_locales order by is_default desc, created_at asc, id asc
  `
  return rows.map(mapLocale)
}

export async function getLocale(db: DbClient, localeId: string): Promise<Locale | null> {
  const { rows } = await db<LocaleRow>`
    select id, code, name, path_prefix, is_default, enabled, direction
    from site_locales where id = ${localeId}
  `
  return rows[0] ? mapLocale(rows[0]) : null
}

export async function getDefaultLocale(db: DbClient): Promise<Locale> {
  const { rows } = await db<LocaleRow>`
    select id, code, name, path_prefix, is_default, enabled, direction
    from site_locales where is_default = ${true}
  `
  if (!rows[0]) throw new Error('Default locale is missing')
  return mapLocale(rows[0])
}

/** An omitted selection means source; an explicit unknown or empty ID is invalid. */
export async function resolveContentLocale(db: DbClient, localeId?: string): Promise<Locale> {
  const locale = localeId === undefined ? await getDefaultLocale(db) : await getLocale(db, localeId)
  if (!locale) throw new LocalizationError('Unknown content language', 'localeId')
  return locale
}

function normalizeLocale(input: LocaleInput, isDefault: boolean): LocaleInput {
  let code: string
  try {
    const codes = Intl.getCanonicalLocales(input.code.trim())
    if (!codes[0]) throw new RangeError('Empty locale')
    code = codes[0]
  } catch (err) {
    // Intl rejects malformed BCP 47 tags; expose a field-local validation error.
    throw new LocalizationError('Use a valid language code, such as de or en-GB', 'code', { cause: err })
  }
  const name = input.name.trim()
  if (!name) throw new LocalizationError('A language name is required', 'name')
  let pathPrefix: string
  try {
    pathPrefix = normalizeLocalePathPrefix(input.pathPrefix.trim().toLowerCase())
  } catch (err) {
    if (err instanceof LocalizedRouteError) throw new LocalizationError(err.message, 'pathPrefix', { cause: err })
    throw err
  }
  if (isDefault ? pathPrefix !== '' : pathPrefix === '') {
    throw new LocalizationError(isDefault
      ? 'The default language uses the root URL'
      : 'A language URL prefix is required', 'pathPrefix')
  }
  return { ...input, code, name, pathPrefix }
}

async function assertUniqueLocale(db: DbClient, input: LocaleInput, excludeId: string): Promise<void> {
  const { rows } = await db<{ code: string; path_prefix: string }>`
    select code, path_prefix from site_locales
    where id <> ${excludeId} and (lower(code) = ${input.code.toLowerCase()} or path_prefix = ${input.pathPrefix})
  `
  if (!rows[0]) return
  if (rows.some((row) => row.code.toLowerCase() === input.code.toLowerCase())) {
    throw new LocalizationError('This language already exists', 'code')
  }
  throw new LocalizationError('This URL prefix is already used by another language', 'pathPrefix')
}

export async function createLocale(db: DbClient, input: LocaleInput): Promise<Locale> {
  const normalized = normalizeLocale(input, false)
  const id = nanoid()
  await assertUniqueLocale(db, normalized, id)
  await db`
    insert into site_locales (id, code, name, path_prefix, is_default, enabled, direction)
    values (${id}, ${normalized.code}, ${normalized.name}, ${normalized.pathPrefix}, ${false}, ${normalized.enabled}, ${normalized.direction})
  `
  return { ...normalized, id, isDefault: false }
}

export async function updateLocale(db: DbClient, localeId: string, input: LocaleUpdateInput): Promise<Locale | null> {
  const current = await getLocale(db, localeId)
  if (!current) return null
  const normalized = normalizeLocale({ ...current, ...input }, current.isDefault)
  await assertUniqueLocale(db, normalized, localeId)
  await db`
    update site_locales
    set code = ${normalized.code}, name = ${normalized.name}, path_prefix = ${normalized.pathPrefix},
        enabled = ${normalized.enabled}, direction = ${normalized.direction}, updated_at = current_timestamp
    where id = ${localeId}
  `
  return { ...normalized, id: localeId, isDefault: current.isDefault }
}

/** Bundle restore preserves identities; a merge must not relabel existing rows. */
export async function importLocale(db: DbClient, input: Locale, strategy: 'replace' | 'merge-add' | 'merge-overwrite'): Promise<void> {
  const normalized = normalizeLocale(input, input.isDefault)
  const current = await getLocale(db, input.id)
  if (current && strategy !== 'replace' && (current.code !== normalized.code || current.isDefault !== input.isDefault)) {
    throw new LocalizationError('The imported language identity refers to a different local language; use replace to restore this bundle', 'locales')
  }
  if (current && strategy === 'merge-add') return
  await assertUniqueLocale(db, normalized, input.id)
  await db`insert into site_locales (id, code, name, path_prefix, is_default, enabled, direction)
    values (${input.id}, ${normalized.code}, ${normalized.name}, ${normalized.pathPrefix}, ${input.isDefault}, ${normalized.enabled}, ${normalized.direction})
    on conflict (id) do update set code = excluded.code, name = excluded.name,
      path_prefix = excluded.path_prefix, enabled = excluded.enabled, direction = excluded.direction,
      updated_at = current_timestamp`
}
