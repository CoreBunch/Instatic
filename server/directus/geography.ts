import type { DirectusClient } from './client'
import {
  GEOGRAPHY_PARENT_FIELD,
  isGeographyLevel,
  type GeographyLevel,
} from './collections'
import { directusBadRequest, directusNotFound } from './errors'
import {
  expandNames,
  parseTranslations,
  resolveName,
  type LocaleNames,
  type SupportedLocale,
} from './locales'
import {
  asRecord,
  asRecords,
  boolField,
  filteredCount,
  numberField,
  relationCode,
  relationId,
  stringField,
  stringList,
} from './rows'
import {
  assertNoControlChars,
  assertSupportedLocale,
  assertUuid,
  optionalLocale,
  optionalNonEmpty,
  optionalUuid,
  parseBool,
  parseLimit,
  parsePage,
} from './validate'

export interface GeographyRow {
  type: GeographyLevel
  /** Uuid for every level except `countries`, whose id is its ISO code. */
  id: string
  slug: string
  name?: string
  names?: LocaleNames
  country?: string
  officialCode?: string
  population?: number
  postalCodes?: string[]
  latitude?: number
  longitude?: number
  isMajor?: boolean
  provinceId?: string
  regionId?: string
  municipalityId?: string
}

export interface GeographyListQuery {
  parentId?: string
  country?: string
  slug?: string
  search?: string
  locale?: SupportedLocale
  allLocales?: boolean
  limit?: number
  page?: number
}

export interface GeographyListResult {
  data: GeographyRow[]
  count: number
  page: number
  pageSize: number
}

export interface AncestryQuery {
  slug?: string
  id?: string
  country?: string
  locale?: SupportedLocale
  allLocales?: boolean
}

export interface GeographyAncestry {
  municipality: GeographyRow
  province: GeographyRow | null
  region: GeographyRow | null
  country: GeographyRow | null
}

export function parseGeographyListQuery(
  level: string,
  params: URLSearchParams,
): { level: GeographyLevel } & GeographyListQuery {
  if (!isGeographyLevel(level)) throw directusBadRequest('Unknown geography level')
  const country = optionalNonEmpty('country', params.get('country'))
  if (country && !/^[A-Z]{2}$/i.test(country)) throw directusBadRequest("'country' must be a two-letter code")
  return {
    level,
    parentId: optionalUuid('parent_id', params.get('parent_id')),
    country: country?.toUpperCase(),
    slug: optionalNonEmpty('slug', params.get('slug')),
    search: optionalNonEmpty('search', params.get('search')),
    locale: optionalLocale(params.get('locale')),
    allLocales: parseBool(params.get('all_locales')),
    limit: parseLimit(params.get('limit')),
    page: parsePage(params.get('page')),
  }
}

export function parseAncestryQuery(params: URLSearchParams): AncestryQuery {
  const country = optionalNonEmpty('country', params.get('country'))
  if (country && !/^[A-Z]{2}$/i.test(country)) throw directusBadRequest("'country' must be a two-letter code")
  const slug = optionalNonEmpty('slug', params.get('slug'))
  const id = optionalUuid('id', params.get('id'))
  if (!slug && !id) throw directusBadRequest("Provide 'slug' or 'id'")
  return {
    slug,
    id,
    country: country?.toUpperCase(),
    locale: optionalLocale(params.get('locale')),
    allLocales: parseBool(params.get('all_locales')),
  }
}

/**
 * `countries` is keyed by `code` ("BE", "FR") and has no `id` or `slug`
 * column; every other level has a uuid `id` and a `slug`. Filtering
 * `countries` on `slug` is a Directus 403, so the identity column is chosen
 * per level and never guessed.
 */
function identityOf(level: GeographyLevel, rec: Record<string, unknown>): { id: string; slug: string } | null {
  if (level === 'countries') {
    const code = stringField(rec, 'code')
    return code ? { id: code, slug: code } : null
  }
  const id = stringField(rec, 'id')
  if (!id) return null
  return { id, slug: stringField(rec, 'slug') ?? id }
}

function identityFilter(level: GeographyLevel, value: string): Record<string, unknown> {
  return level === 'countries' ? { code: { _eq: value } } : { slug: { _eq: value } }
}

export function flattenGeographyRow(
  level: GeographyLevel,
  raw: unknown,
  options: { locale?: SupportedLocale; allLocales?: boolean },
): GeographyRow | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const identity = identityOf(level, rec)
  if (!identity) return null
  const translations = parseTranslations(rec.translations)
  const country = level === 'countries'
    ? identity.id
    : (relationCode(rec.country) ?? stringField(rec, 'country_code'))
  const fallbackName = stringField(rec, 'name') ?? identity.slug
  const locale = options.locale ?? (country === 'FR' ? 'fr-FR' : 'fr-BE')
  const row: GeographyRow = {
    type: level,
    id: identity.id,
    slug: identity.slug,
    country,
    officialCode: stringField(rec, 'official_code'),
    population: numberField(rec, 'population'),
    postalCodes: stringList(rec.postal_codes),
    latitude: numberField(rec, 'latitude'),
    longitude: numberField(rec, 'longitude'),
    isMajor: boolField(rec, 'is_major') || undefined,
    provinceId: relationId(rec.province),
    regionId: relationId(rec.region),
    municipalityId: relationId(rec.municipality),
  }
  if (options.allLocales) {
    row.names = expandNames(translations, country, fallbackName)
  } else {
    row.name = resolveName(translations, locale, country, fallbackName)
  }
  return row
}

export async function listGeography(
  client: DirectusClient,
  level: GeographyLevel,
  query: GeographyListQuery,
): Promise<GeographyListResult> {
  if (query.parentId) assertUuid('parent_id', query.parentId)
  if (query.country) assertNoControlChars('country', query.country)
  if (query.slug) assertNoControlChars('slug', query.slug)
  if (query.search) assertNoControlChars('search', query.search)
  if (query.locale) assertSupportedLocale(query.locale)
  const filter: Record<string, unknown> = {}
  const parentField = GEOGRAPHY_PARENT_FIELD[level]
  if (query.parentId) {
    if (!parentField) throw directusBadRequest("'parent_id' is not valid for countries")
    filter[parentField] = { _eq: query.parentId }
  }
  if (query.country && level !== 'countries') {
    filter.country = { _eq: query.country }
  }
  if (query.slug) {
    Object.assign(filter, identityFilter(level, query.slug))
  }

  const params: Record<string, string> = {
    fields: '*,translations.*',
    meta: 'filter_count',
    limit: String(query.limit ?? 100),
    page: String(query.page ?? 1),
  }
  if (Object.keys(filter).length > 0) params.filter = JSON.stringify(filter)
  if (query.search) params.search = query.search

  const response = await client.getItems(level, params)
  const rows = asRecords(response.data)
    .map((row) => flattenGeographyRow(level, row, query))
    .filter((row): row is GeographyRow => row !== null)
  return {
    data: rows,
    count: filteredCount(response.meta, rows.length),
    page: query.page ?? 1,
    pageSize: query.limit ?? 100,
  }
}

export async function getGeographyAncestry(
  client: DirectusClient,
  query: AncestryQuery,
): Promise<GeographyAncestry> {
  if (query.id) assertUuid('id', query.id)
  if (query.slug) assertNoControlChars('slug', query.slug)
  if (query.country) assertNoControlChars('country', query.country)
  if (query.locale) assertSupportedLocale(query.locale)
  if (!query.slug && !query.id) throw directusBadRequest("Provide 'slug' or 'id'")
  const municipality = query.id
    ? await loadLevel(client, 'municipalities', query.id, query)
    : (await listGeography(client, 'municipalities', {
        slug: query.slug,
        country: query.country,
        locale: query.locale,
        allLocales: query.allLocales,
        limit: 2,
        page: 1,
      })).data[0] ?? null
  if (!municipality) throw directusNotFound('Municipality not found')

  const province = municipality.provinceId
    ? await loadLevel(client, 'provinces', municipality.provinceId, query)
    : null
  const regionId = province?.regionId
  const region = regionId ? await loadLevel(client, 'regions', regionId, query) : null
  const country = await loadCountry(client, municipality.country, query)

  return { municipality, province, region, country }
}

async function loadLevel(
  client: DirectusClient,
  level: GeographyLevel,
  id: string,
  query: { locale?: SupportedLocale; allLocales?: boolean },
): Promise<GeographyRow | null> {
  const response = await client.getItems(level, {
    fields: '*,translations.*',
    filter: JSON.stringify({ id: { _eq: id } }),
    limit: '1',
  })
  return flattenGeographyRow(level, asRecords(response.data)[0], query)
}

async function loadCountry(
  client: DirectusClient,
  code: string | undefined,
  query: { locale?: SupportedLocale; allLocales?: boolean },
): Promise<GeographyRow | null> {
  if (!code) return null
  const response = await client.getItems('countries', {
    fields: '*,translations.*',
    filter: JSON.stringify(identityFilter('countries', code)),
    limit: '1',
  })
  return flattenGeographyRow('countries', asRecords(response.data)[0], query)
}

