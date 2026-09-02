/**
 * Allow-listed Directus collections. The instance hosts many more; this
 * reader never forwards an unknown collection name.
 */
export const GEOGRAPHY_LEVELS = [
  'countries',
  'regions',
  'provinces',
  'municipalities',
  'localities',
] as const

export type GeographyLevel = (typeof GEOGRAPHY_LEVELS)[number]

export const WORKFIELD_TYPES = [
  'category',
  'trade',
  'product',
  'service',
  'topic',
  'material',
] as const

export type WorkfieldType = (typeof WORKFIELD_TYPES)[number]

/**
 * Status of the per-locale sub-rows (pricing, demands, blog, FAQ). The base
 * `workfield_content` row has no status column: its published set is
 * `is_deleted = false AND is_shadow = false`.
 */
export const SUB_ROW_STATUSES = ['draft', 'published', 'archived'] as const

export type SubRowStatus = (typeof SUB_ROW_STATUSES)[number]

/**
 * Names as they exist in DEV Directus. The reader token can read exactly
 * these; anything else is a 403 upstream and is refused here first.
 */
const DIRECTUS_COLLECTIONS = [
  ...GEOGRAPHY_LEVELS,
  'workfield_content',
  'workfield_faq_content',
  'workfield_pricing_items',
  'workfield_example_demands',
  'workfield_blog_content',
] as const

export type DirectusCollection = (typeof DIRECTUS_COLLECTIONS)[number]

export function isGeographyLevel(value: string): value is GeographyLevel {
  return (GEOGRAPHY_LEVELS as readonly string[]).includes(value)
}

export function isDirectusCollection(value: string): value is DirectusCollection {
  return (DIRECTUS_COLLECTIONS as readonly string[]).includes(value)
}

export function isWorkfieldType(value: string): value is WorkfieldType {
  return (WORKFIELD_TYPES as readonly string[]).includes(value)
}

export function isSubRowStatus(value: string): value is SubRowStatus {
  return (SUB_ROW_STATUSES as readonly string[]).includes(value)
}

/** One level up from `level` — used for `parent_id` filters. */
export const GEOGRAPHY_PARENT_FIELD: Record<GeographyLevel, string | null> = {
  countries: null,
  regions: 'country',
  provinces: 'region',
  municipalities: 'province',
  localities: 'municipality',
}
