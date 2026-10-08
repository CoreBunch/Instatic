import {
  parsePageSeo, PageSeoValidationError, SeoAlternateSchema, SeoMetaSchema, SeoLinkSchema,
  SeoStructuredDataSchema, type PageSeo,
} from '@core/page-tree'
import { Type, safeParseValue, type TSchema } from '@core/utils/typeboxHelpers'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { DataRowCells } from './schemas'

const alternateCells = Type.Array(Type.Object({ id: Type.String(), cells: Type.Omit(SeoAlternateSchema, ['id']) }))
const optionalText = Type.Optional(Type.Union([Type.String(), Type.Null()]))
const metaCells = Type.Array(Type.Object({ id: Type.String(), cells: Type.Object({
  ...Type.Omit(SeoMetaSchema, ['id', 'content', 'media']).properties,
  content: optionalText, media: optionalText,
}, { additionalProperties: false }) }))
const linkCells = Type.Array(Type.Object({ id: Type.String(), cells: Type.Object({
  ...Type.Omit(SeoLinkSchema, ['id', 'type', 'sizes', 'media']).properties,
  type: optionalText, sizes: optionalText, media: optionalText,
}, { additionalProperties: false }) }))

function readText(cells: DataRowCells, key: string): string | undefined {
  const value = cells[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new PageSeoValidationError(`cells.${key}`, 'Expected text')
  return value
}

function readItems<T extends TSchema>(schema: T, raw: unknown, key: string) {
  if (raw === undefined || raw === null) return []
  const result = safeParseValue(schema, raw)
  if (!result.ok) throw new PageSeoValidationError(`cells.${key}`, result.errors[0]?.message ?? 'Invalid repeater')
  return result.value
}

/** The ordinary page fields are the storage contract; there is no parallel SEO document. */
export function readPageSeoCells(cells: DataRowCells): PageSeo | undefined {
  const title = readText(cells, 'seoTitle')
  const description = readText(cells, 'seoDescription')
  const canonical = readText(cells, 'seoCanonical')
  const alternates = readItems(alternateCells, cells.seoAlternates, 'seoAlternates')
    .map(({ id, cells: item }) => ({ id, ...item }))
  const meta = readItems(metaCells, cells.seoMeta, 'seoMeta').map(({ id, cells: item }) => ({
    id, attribute: item.attribute, key: item.key, content: item.content ?? '', ...(item.media != null ? { media: item.media } : {}),
  }))
  const links = readItems(linkCells, cells.seoLinks, 'seoLinks').map(({ id, cells: item }) => ({
    id, rel: item.rel, href: item.href,
    ...(item.type != null ? { type: item.type } : {}), ...(item.sizes != null ? { sizes: item.sizes } : {}),
    ...(item.media != null ? { media: item.media } : {}),
  }))
  const structuredText = readText(cells, 'seoStructuredData')
  let structuredData: PageSeo['structuredData']
  if (structuredText) {
    const parsed = safeParseJson(structuredText, SeoStructuredDataSchema)
    if (!parsed.ok) throw new PageSeoValidationError('cells.seoStructuredData', parsed.error.message)
    structuredData = parsed.value
  }
  const seo = {
    ...(title ? { title } : {}), ...(description ? { description } : {}), ...(canonical ? { canonical } : {}),
    ...(alternates.length ? { alternates } : {}), ...(meta.length ? { meta } : {}), ...(links.length ? { links } : {}),
    ...(structuredData?.length ? { structuredData } : {}),
  }
  return Object.keys(seo).length ? parsePageSeo(seo, 'cells.seo') : undefined
}

/** Empty values are written explicitly so clearing a field also clears its persisted draft. */
export function writePageSeoCells(seo: PageSeo | undefined): DataRowCells {
  parsePageSeo(seo)
  return {
    seoTitle: seo?.title ?? '',
    seoDescription: seo?.description ?? '',
    seoCanonical: seo?.canonical ?? '',
    seoAlternates: (seo?.alternates ?? []).map(({ id, ...cells }) => ({ id, cells })),
    seoMeta: (seo?.meta ?? []).map(({ id, ...cells }) => ({ id, cells })),
    seoLinks: (seo?.links ?? []).map(({ id, ...cells }) => ({ id, cells })),
    seoStructuredData: seo?.structuredData?.length ? JSON.stringify(seo.structuredData) : '',
  }
}
