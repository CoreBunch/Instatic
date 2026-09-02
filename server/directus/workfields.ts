/**
 * Workfields, read from the collections the DEV reader can actually see.
 *
 * Upstream contract (verified live, 2026-09-02):
 * - `workfield_content` is the base row. It has NO `status` column; the
 *   content service's "published" set is `is_deleted = false AND
 *   is_shadow = false` (468 of 473 rows).
 * - Translations live on `workfield_content.translations` (one row per
 *   locale, 8 per workfield). `localised_slugs` is a comma-separated history,
 *   oldest first; the marketplace routes on the LAST entry.
 * - Pricing, example demands and blog are flat per-locale collections keyed
 *   by `workfield_content_id` + `languages_code`, each with its own `status`.
 * - FAQ is `workfield_faq_content` (`type` generic | location_specific,
 *   `geography_type`, `geography_id`, `status`) with `translations`
 *   (`intro_text`, `qa_text`).
 * - `average_rating` is an integer x100 (479 = 4.79).
 */
import type { DirectusClient } from './client'
import {
  isGeographyLevel,
  isSubRowStatus,
  isWorkfieldType,
  type GeographyLevel,
  type SubRowStatus,
  type WorkfieldType,
} from './collections'
import { directusBadRequest, directusNotFound } from './errors'
import {
  expandNames,
  parseTranslations,
  resolveName,
  resolveTranslationFields,
  translationsByLocale,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type DirectusTranslation,
  type LocaleNames,
  type SupportedLocale,
} from './locales'
import {
  asRecord,
  asRecords,
  assetUrl,
  boolField,
  filteredCount,
  numberField,
  stringField,
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

export const WORKFIELD_INCLUDES = ['pricing', 'demands', 'blog', 'faq'] as const
export type WorkfieldInclude = (typeof WORKFIELD_INCLUDES)[number]

/** Per-locale sub-collections keyed by `workfield_content_id` + `languages_code`. */
const FLAT_LOCALE_COLLECTIONS = {
  pricing: { collection: 'workfield_pricing_items', fields: 'id,sort,status,label,price_indication' },
  demands: { collection: 'workfield_example_demands', fields: 'id,sort,status,thumbnail,title,location,professionals' },
  blog: { collection: 'workfield_blog_content', fields: 'id,sort,status,thumbnail,url,title,date_label' },
} as const

const WORKFIELD_BASE_FIELDS = 'id,slug,type,is_deleted,is_shadow,professional_count,average_rating,thumbnail,demand_banner,listing_banner'
const WORKFIELD_LIST_FIELDS = `${WORKFIELD_BASE_FIELDS},translations.languages_code,translations.name,translations.localised_slugs`
const WORKFIELD_DETAIL_FIELDS = `${WORKFIELD_BASE_FIELDS},translations.*`
const FAQ_FIELDS = 'id,type,geography_type,geography_id,status,translations.languages_code,translations.intro_text,translations.qa_text'

/** The content service's published set: not deleted, not shadow. */
const PUBLISHED_FILTER = { is_deleted: { _eq: false }, is_shadow: { _eq: false } } as const

export interface WorkfieldRow {
  id: string
  slug: string
  type: string
  name?: string
  names?: LocaleNames
  localizedSlug?: string
  localizedSlugs?: LocaleNames
  professionalCount?: number
  averageRating?: number
  thumbnailUrl?: string
}

export interface WorkfieldDetail extends WorkfieldRow {
  isShadow: boolean
  /** The resolved locale's translation row, minus asset ids. */
  translation?: Record<string, string>
  /** Every locale's translation row, when `all_locales` is set. */
  translations?: Record<SupportedLocale, Record<string, string>>
  images: WorkfieldImages
  pricing?: Record<string, unknown>[]
  demands?: Record<string, unknown>[]
  blog?: Record<string, unknown>[]
  faq?: WorkfieldFaqRow[]
}

export interface WorkfieldImages {
  thumbnailUrl?: string
  demandBannerUrl?: string
  listingBannerUrl?: string
}

export interface WorkfieldFaqRow {
  id: string
  type: string
  status?: string
  geographyType?: string
  geographyId?: string
  /** The locale whose translation row was picked (after fallback). */
  locale: SupportedLocale
  introText?: string
  qaText?: string
}

export interface WorkfieldListQuery {
  locale?: SupportedLocale
  type?: WorkfieldType
  search?: string
  allLocales?: boolean
  limit?: number
  page?: number
}

export interface WorkfieldListResult {
  data: WorkfieldRow[]
  count: number
  page: number
  pageSize: number
}

export interface WorkfieldDetailQuery {
  locale?: SupportedLocale
  /** Filters the included pricing / demands / blog / faq rows, not the base row. */
  status?: SubRowStatus
  include?: WorkfieldInclude[]
  allLocales?: boolean
}

export interface WorkfieldFaqQuery {
  locale?: SupportedLocale
  status?: SubRowStatus
  type?: 'generic' | 'location_specific'
  geographyType?: GeographyLevel
  geographyId?: string
}

function parseSubRowStatus(raw: string | null): SubRowStatus | undefined {
  const value = optionalNonEmpty('status', raw)
  if (value === undefined) return undefined
  if (!isSubRowStatus(value)) throw directusBadRequest("Unknown 'status'")
  return value
}

export function parseWorkfieldListQuery(params: URLSearchParams): WorkfieldListQuery {
  const rawType = optionalNonEmpty('type', params.get('type'))
  let type: WorkfieldType | undefined
  if (rawType !== undefined) {
    if (!isWorkfieldType(rawType)) throw directusBadRequest("Unknown workfield 'type'")
    type = rawType
  }
  return {
    locale: optionalLocale(params.get('locale')),
    type,
    search: optionalNonEmpty('search', params.get('search')),
    allLocales: parseBool(params.get('all_locales')),
    limit: parseLimit(params.get('limit')),
    page: parsePage(params.get('page')),
  }
}

export function parseWorkfieldDetailQuery(params: URLSearchParams): WorkfieldDetailQuery {
  const includeRaw = optionalNonEmpty('include', params.get('include'))
  const include: WorkfieldInclude[] = []
  if (includeRaw) {
    for (const part of includeRaw.split(',').map((entry) => entry.trim()).filter(Boolean)) {
      if (!(WORKFIELD_INCLUDES as readonly string[]).includes(part)) {
        throw directusBadRequest(`Unknown include '${part}'`)
      }
      include.push(part as WorkfieldInclude)
    }
  }
  return {
    locale: optionalLocale(params.get('locale')),
    status: parseSubRowStatus(params.get('status')),
    include,
    allLocales: parseBool(params.get('all_locales')),
  }
}

export function parseWorkfieldFaqQuery(params: URLSearchParams): WorkfieldFaqQuery {
  const rawType = optionalNonEmpty('type', params.get('type'))
  let type: 'generic' | 'location_specific' | undefined
  if (rawType !== undefined) {
    if (rawType !== 'generic' && rawType !== 'location_specific') {
      throw directusBadRequest("FAQ 'type' must be generic or location_specific")
    }
    type = rawType
  }
  const rawGeography = optionalNonEmpty('geography_type', params.get('geography_type'))
  let geographyType: GeographyLevel | undefined
  if (rawGeography !== undefined) {
    if (!isGeographyLevel(rawGeography)) throw directusBadRequest('Unknown geography level')
    geographyType = rawGeography
  }
  return {
    locale: optionalLocale(params.get('locale')),
    status: parseSubRowStatus(params.get('status')),
    type,
    geographyType,
    geographyId: optionalUuid('geography_id', params.get('geography_id')),
  }
}

/**
 * `localised_slugs` holds a comma-separated history, oldest first
 * ("prevention-inondation,prevention-inondations"). The content service
 * routes on the last entry; earlier ones are superseded spellings kept for
 * redirects. Taking the first would 404 in the marketplace.
 */
export function canonicalLocalizedSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean)
  return parts.at(-1)
}

/** `average_rating` is an integer x100 in Directus (479 = 4.79). */
function rating(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value) / 100
}

function localizedSlugFor(
  translations: readonly DirectusTranslation[],
  locale: SupportedLocale,
): string | undefined {
  return canonicalLocalizedSlug(resolveTranslationFields(translations, locale, undefined).localised_slugs)
}

function expandLocalizedSlugs(translations: readonly DirectusTranslation[]): LocaleNames | undefined {
  const out = {} as LocaleNames
  let any = false
  for (const locale of SUPPORTED_LOCALES) {
    const slug = localizedSlugFor(translations, locale)
    if (slug) {
      out[locale] = slug
      any = true
    }
  }
  return any ? out : undefined
}

export function flattenWorkfieldRow(
  raw: unknown,
  options: { locale?: SupportedLocale; allLocales?: boolean; assetBase: string },
): WorkfieldRow | null {
  const rec = asRecord(raw)
  const id = rec ? stringField(rec, 'id') : undefined
  if (!rec || !id) return null
  const translations = parseTranslations(rec.translations)
  const slug = stringField(rec, 'slug') ?? id
  const locale = options.locale ?? 'fr-BE'
  const row: WorkfieldRow = {
    id,
    slug,
    type: stringField(rec, 'type') ?? '',
    professionalCount: numberField(rec, 'professional_count'),
    averageRating: rating(numberField(rec, 'average_rating')),
    thumbnailUrl: assetUrl(options.assetBase, rec.thumbnail),
  }
  if (options.allLocales) {
    row.names = expandNames(translations, undefined, slug)
    row.localizedSlugs = expandLocalizedSlugs(translations)
  } else {
    row.name = resolveName(translations, locale, undefined, slug)
    row.localizedSlug = localizedSlugFor(translations, locale)
  }
  return row
}

export async function listWorkfields(
  client: DirectusClient,
  query: WorkfieldListQuery,
): Promise<WorkfieldListResult> {
  if (query.search) assertNoControlChars('search', query.search)
  if (query.locale) assertSupportedLocale(query.locale)
  const filter: Record<string, unknown> = { ...PUBLISHED_FILTER }
  if (query.type) filter.type = { _eq: query.type }

  const params: Record<string, string> = {
    fields: WORKFIELD_LIST_FIELDS,
    meta: 'filter_count',
    filter: JSON.stringify(filter),
    sort: 'slug',
    limit: String(query.limit ?? 100),
    page: String(query.page ?? 1),
  }
  if (query.search) params.search = query.search

  const response = await client.getItems('workfield_content', params)
  const rows = asRecords(response.data)
    .map((row) => flattenWorkfieldRow(row, { ...query, assetBase: client.url }))
    .filter((row): row is WorkfieldRow => row !== null)
  return {
    data: rows,
    count: filteredCount(response.meta, rows.length),
    page: query.page ?? 1,
    pageSize: query.limit ?? 100,
  }
}

/** Asset ids on a translation row become URLs on `images`, not raw strings on `translation`. */
const TRANSLATION_ASSET_KEYS = new Set(['thumbnail', 'listing_banner'])

function withoutAssetKeys(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !TRANSLATION_ASSET_KEYS.has(key)))
}

export async function getWorkfield(
  client: DirectusClient,
  slug: string,
  query: WorkfieldDetailQuery,
): Promise<WorkfieldDetail> {
  assertNoControlChars('slug', slug)
  if (query.locale) assertSupportedLocale(query.locale)
  const response = await client.getItems('workfield_content', {
    fields: WORKFIELD_DETAIL_FIELDS,
    filter: JSON.stringify({ slug: { _eq: slug } }),
    limit: '1',
  })
  const raw = asRecords(response.data)[0]
  const base = raw && flattenWorkfieldRow(raw, { locale: query.locale, allLocales: query.allLocales, assetBase: client.url })
  if (!raw || !base) throw directusNotFound('Workfield not found')

  const locale = query.locale ?? 'fr-BE'
  const translations = parseTranslations(raw.translations)
  const picked = resolveTranslationFields(translations, locale, undefined)
  const detail: WorkfieldDetail = {
    ...base,
    isShadow: boolField(raw, 'is_shadow'),
    images: {
      thumbnailUrl: assetUrl(client.url, picked.thumbnail ?? raw.thumbnail),
      demandBannerUrl: assetUrl(client.url, raw.demand_banner),
      listingBannerUrl: assetUrl(client.url, picked.listing_banner ?? raw.listing_banner),
    },
  }
  if (query.allLocales) {
    const byLocale = translationsByLocale(translations, undefined)
    detail.translations = Object.fromEntries(
      Object.entries(byLocale).map(([code, fields]) => [code, withoutAssetKeys(fields)]),
    ) as Record<SupportedLocale, Record<string, string>>
  } else {
    detail.translation = withoutAssetKeys(picked)
  }

  const include = new Set(query.include ?? [])
  const subRowLocale = query.allLocales ? undefined : locale
  const loads: Promise<void>[] = []
  for (const name of ['pricing', 'demands', 'blog'] as const) {
    if (!include.has(name)) continue
    loads.push(loadFlatLocaleRows(client, name, base.id, subRowLocale, query.status).then((rows) => {
      detail[name] = rows
    }))
  }
  if (include.has('faq')) {
    // Generic only. A popular workfield carries a location_specific row per
    // municipality (roofer has 128), so an unscoped include would return the
    // whole country. The FAQ route takes a geography for the local ones.
    loads.push(queryFaq(client, { workfieldId: base.id, type: 'generic', status: query.status, locale }).then((rows) => {
      detail.faq = rows
    }))
  }
  await Promise.all(loads)
  return detail
}

async function loadFlatLocaleRows(
  client: DirectusClient,
  name: keyof typeof FLAT_LOCALE_COLLECTIONS,
  workfieldId: string,
  locale: SupportedLocale | undefined,
  status: SubRowStatus | undefined,
): Promise<Record<string, unknown>[]> {
  const { collection, fields } = FLAT_LOCALE_COLLECTIONS[name]
  const filter: Record<string, unknown> = { workfield_content_id: { _eq: workfieldId } }
  if (locale) filter.languages_code = { _eq: locale }
  if (status) filter.status = { _eq: status }
  const response = await client.getItems(collection, {
    fields,
    filter: JSON.stringify(filter),
    sort: 'sort',
    limit: '1000',
  })
  return asRecords(response.data).map((row) => {
    if (typeof row.thumbnail === 'string') {
      return { ...row, thumbnailUrl: assetUrl(client.url, row.thumbnail), thumbnail: undefined }
    }
    return row
  })
}

function flattenFaqRow(raw: unknown, locale: SupportedLocale): WorkfieldFaqRow | null {
  const rec = asRecord(raw)
  const id = rec ? stringField(rec, 'id') : undefined
  if (!rec || !id) return null
  const fields = resolveTranslationFields(parseTranslations(rec.translations), locale, undefined)
  const picked = fields.languages_code
  return {
    id,
    type: stringField(rec, 'type') ?? 'generic',
    status: stringField(rec, 'status'),
    geographyType: stringField(rec, 'geography_type'),
    geographyId: stringField(rec, 'geography_id'),
    locale: isSupportedLocale(picked) ? picked : locale,
    introText: fields.intro_text,
    qaText: fields.qa_text,
  }
}

async function queryFaq(
  client: DirectusClient,
  options: {
    workfieldId?: string
    workfieldSlug?: string
    type?: 'generic' | 'location_specific'
    status?: SubRowStatus
    geographyType?: GeographyLevel
    geographyId?: string
    locale: SupportedLocale
  },
): Promise<WorkfieldFaqRow[]> {
  const filter: Record<string, unknown> = options.workfieldId
    ? { workfield_content_id: { _eq: options.workfieldId } }
    : { workfield_content_id: { slug: { _eq: options.workfieldSlug } } }
  if (options.type) filter.type = { _eq: options.type }
  if (options.status) filter.status = { _eq: options.status }
  if (options.geographyType) filter.geography_type = { _eq: options.geographyType }
  if (options.geographyId) filter.geography_id = { _eq: options.geographyId }
  const response = await client.getItems('workfield_faq_content', {
    fields: FAQ_FIELDS,
    filter: JSON.stringify(filter),
    sort: 'type',
    limit: '1000',
  })
  return asRecords(response.data)
    .map((row) => flattenFaqRow(row, options.locale))
    .filter((row): row is WorkfieldFaqRow => row !== null)
}

export async function listWorkfieldFaq(
  client: DirectusClient,
  slug: string,
  query: WorkfieldFaqQuery,
): Promise<WorkfieldFaqRow[]> {
  assertNoControlChars('slug', slug)
  if (query.geographyId) assertUuid('geography_id', query.geographyId)
  if (query.locale) assertSupportedLocale(query.locale)
  const rows = await queryFaq(client, {
    workfieldSlug: slug,
    type: query.type ?? (query.geographyId ? 'location_specific' : undefined),
    status: query.status,
    geographyType: query.geographyType,
    geographyId: query.geographyId,
    locale: query.locale ?? 'fr-BE',
  })
  if (rows.length === 0) {
    // Distinguish "no FAQ" from "no such workfield" so callers get the 404.
    const exists = await client.getItems('workfield_content', {
      fields: 'id',
      filter: JSON.stringify({ slug: { _eq: slug } }),
      limit: '1',
    })
    if (asRecords(exists.data).length === 0) throw directusNotFound('Workfield not found')
  }
  return rows
}
