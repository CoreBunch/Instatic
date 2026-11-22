/**
 * PageSeo — the per-page `<head>` settings a page carries besides its title:
 * search metadata, social sharing cards, browser chrome hints, structured
 * data, and a small allowlisted set of extra `<meta>` / `<link>` tags.
 *
 * The shape is structured on purpose. There is no "raw head HTML" field:
 * every value is emitted by the publisher (`src/core/publisher/headTags.ts`)
 * through its own escaped attribute, so a stored value can never open a new
 * element, set `http-equiv`, or load a script.
 *
 * Every field is optional and an absent field emits nothing. Site settings
 * stay the fallback where one already exists: `description` falls back to
 * `settings.metaDescription`, `title` to `settings.metaTitle` / the page
 * title, and `favicon` to `settings.faviconUrl`.
 *
 * Stored on the page row as the `seo` cell (see `@core/data/pageFromRow`) and
 * carried in the page's collab doc meta like `template` and `access`.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static, type TSchema } from '@core/utils/typeboxHelpers'
import { compiledCheck } from '@core/utils/typeboxCompiler'

const Text = (maxLength: number) => Type.String({ maxLength })

/** `rel` values a page may emit as an extra `<link>`. Anything else is dropped. */
export const PAGE_HEAD_LINK_RELS = [
  'alternate',
  'preload',
  'prefetch',
  'preconnect',
  'dns-prefetch',
  'icon',
  'apple-touch-icon',
  'mask-icon',
  'manifest',
  'author',
  'license',
  'me',
  'help',
  'search',
] as const

export type PageHeadLinkRel = (typeof PAGE_HEAD_LINK_RELS)[number]

/**
 * `as` destinations a preload link may name. `script` and `worker` are left
 * out: a page setting has no business fetching code the page does not run.
 */
export const PAGE_HEAD_PRELOAD_AS = ['font', 'image', 'style', 'fetch', 'video', 'audio', 'track'] as const

export type PageHeadPreloadAs = (typeof PAGE_HEAD_PRELOAD_AS)[number]

const PageHeadLinkSchema = Type.Object({
  rel: Type.Union(PAGE_HEAD_LINK_RELS.map((rel) => Type.Literal(rel))),
  href: Text(2048),
  type: Type.Optional(Text(128)),
  title: Type.Optional(Text(256)),
  hreflang: Type.Optional(Text(64)),
  media: Type.Optional(Text(256)),
  sizes: Type.Optional(Text(64)),
  as: Type.Optional(Type.Union(PAGE_HEAD_PRELOAD_AS.map((value) => Type.Literal(value)))),
  crossorigin: Type.Optional(Type.Union([Type.Literal('anonymous'), Type.Literal('use-credentials')])),
})

export type PageHeadLink = Static<typeof PageHeadLinkSchema>

/**
 * An extra `<meta name|property="…" content="…">`. The name is limited to the
 * characters real meta names use (`og:image:width`, `google-site-verification`,
 * `fediverse:creator`), and the names the publisher already owns are refused
 * (see `RESERVED_PAGE_META_NAMES`). `http-equiv` cannot be expressed at all.
 */
const PageHeadMetaSchema = Type.Object({
  attribute: Type.Union([Type.Literal('name'), Type.Literal('property')]),
  name: Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9:._-]*$' }),
  content: Text(2048),
})

export type PageHeadMeta = Static<typeof PageHeadMetaSchema>

/**
 * Meta names an extra entry may not use: the publisher emits these itself
 * (from a structured field, or always), so a second copy would contradict it.
 */
export const RESERVED_PAGE_META_NAMES: ReadonlySet<string> = new Set([
  'viewport',
  'description',
  'robots',
  'theme-color',
  'color-scheme',
  'og:type',
  'og:url',
  'og:site_name',
  'og:title',
  'og:description',
  'og:image',
  'og:image:alt',
  'twitter:card',
  'twitter:site',
  'twitter:creator',
  'twitter:title',
  'twitter:description',
  'twitter:image',
])

const ThemeColorSchema = Type.Object({
  color: Type.String({ minLength: 1, maxLength: 64 }),
  /** Media query, e.g. `(prefers-color-scheme: dark)`. */
  media: Type.Optional(Text(256)),
})

export type PageThemeColor = Static<typeof ThemeColorSchema>

const OpenGraphSchema = Type.Object({
  type: Type.Optional(Text(64)),
  url: Type.Optional(Text(2048)),
  siteName: Type.Optional(Text(256)),
  title: Type.Optional(Text(512)),
  description: Type.Optional(Text(2048)),
  image: Type.Optional(Text(2048)),
  imageAlt: Type.Optional(Text(512)),
})

export type PageOpenGraph = Static<typeof OpenGraphSchema>

const TwitterCardSchema = Type.Object({
  card: Type.Optional(Text(64)),
  site: Type.Optional(Text(128)),
  creator: Type.Optional(Text(128)),
  title: Type.Optional(Text(512)),
  description: Type.Optional(Text(2048)),
  image: Type.Optional(Text(2048)),
})

export type PageTwitterCard = Static<typeof TwitterCardSchema>

const FaviconSchema = Type.Object({ href: Type.String({ minLength: 1, maxLength: 2048 }), type: Type.Optional(Text(128)) })

export const PageSeoSchema = Type.Object({
  /** `<title>` override. Falls back to `settings.metaTitle`, then the page title. */
  title: Type.Optional(Text(512)),
  /** `<meta name="description">`. Falls back to `settings.metaDescription`. */
  description: Type.Optional(Text(2048)),
  canonical: Type.Optional(Text(2048)),
  /** `<meta name="robots">`, e.g. `noindex, follow`. */
  robots: Type.Optional(Text(256)),
  /** `<meta name="color-scheme">`, e.g. `light dark`. */
  colorScheme: Type.Optional(Text(64)),
  themeColors: Type.Optional(Type.Array(ThemeColorSchema, { maxItems: 8 })),
  /** `<link rel="icon">`. Falls back to `settings.faviconUrl`. */
  favicon: Type.Optional(FaviconSchema),
  openGraph: Type.Optional(OpenGraphSchema),
  twitter: Type.Optional(TwitterCardSchema),
  /** Extra `<meta>` tags (e.g. `og:image:width`, verification codes). */
  meta: Type.Optional(Type.Array(PageHeadMetaSchema, { maxItems: 64 })),
  /** Extra `<link>` tags: alternates, preloads, touch icons, manifest. */
  links: Type.Optional(Type.Array(PageHeadLinkSchema, { maxItems: 64 })),
  /**
   * Structured data. Each entry is the JSON text of one
   * `<script type="application/ld+json">` block; text that does not parse as
   * JSON is not emitted.
   */
  jsonLd: Type.Optional(Type.Array(Text(65536), { maxItems: 16 })),
})

export type PageSeo = Static<typeof PageSeoSchema>

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

const TEXT_KEYS = ['title', 'description', 'canonical', 'robots', 'colorScheme'] as const

/**
 * Parse a stored `seo` value field by field. A malformed entry drops that
 * entry only, never the whole object, so one bad value from an outside writer
 * cannot wipe a page's head. Returns `null` when nothing usable remains.
 *
 * The same function normalises editor input: blank strings and empty lists
 * are removed, so "cleared" and "never set" store the same way.
 */
export function parsePageSeo(raw: unknown): PageSeo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const seo: PageSeo = {}

  for (const key of TEXT_KEYS) {
    const value = r[key]
    if (typeof value !== 'string' || !compiledCheck(PageSeoSchema.properties[key], value)) continue
    const trimmed = value.trim()
    if (trimmed) seo[key] = trimmed
  }

  const themeColors = arrayOf<PageThemeColor>(r.themeColors, ThemeColorSchema)
    .map((entry) => compactStrings(entry))
    .filter((entry): entry is PageThemeColor => Boolean(entry?.color))
  if (themeColors.length > 0) seo.themeColors = themeColors.slice(0, 8)

  const favicon = compactStrings(compiledCheck(FaviconSchema, r.favicon) ? (r.favicon as PageSeo['favicon']) : undefined)
  if (favicon?.href) seo.favicon = favicon as NonNullable<PageSeo['favicon']>

  const openGraph = compactStrings(compiledCheck(OpenGraphSchema, r.openGraph) ? (r.openGraph as PageOpenGraph) : undefined)
  if (openGraph) seo.openGraph = openGraph
  const twitter = compactStrings(compiledCheck(TwitterCardSchema, r.twitter) ? (r.twitter as PageTwitterCard) : undefined)
  if (twitter) seo.twitter = twitter

  const meta = arrayOf<PageHeadMeta>(r.meta, PageHeadMetaSchema)
    .filter((entry) => !RESERVED_PAGE_META_NAMES.has(entry.name.toLowerCase()))
  if (meta.length > 0) seo.meta = meta.slice(0, 64)

  const links = arrayOf<PageHeadLink>(r.links, PageHeadLinkSchema)
    .map((link) => compactStrings(link))
    // A preload without a destination fetches nothing useful; drop it.
    .filter((link): link is PageHeadLink => Boolean(link?.href) && (link?.rel !== 'preload' || Boolean(link.as)))
  if (links.length > 0) seo.links = links.slice(0, 64)

  const jsonLd = Array.isArray(r.jsonLd)
    ? r.jsonLd
      .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 65536)
      .map((entry) => entry.trim())
      .filter(Boolean)
    : []
  if (jsonLd.length > 0) seo.jsonLd = jsonLd.slice(0, 16)

  return Object.keys(seo).length > 0 ? seo : null
}

function arrayOf<T>(raw: unknown, schema: TSchema): T[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry) => compiledCheck(schema, entry)) as T[]
}

/**
 * The object with its string fields trimmed and blank ones removed, or null
 * when no field remains. Non-string fields pass through untouched.
 */
function compactStrings<T extends object>(value: T | undefined | null): T | null {
  if (!value) return null
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === 'string') {
      const trimmed = field.trim()
      if (trimmed) out[key] = trimmed
    } else if (field !== undefined) {
      out[key] = field
    }
  }
  return Object.keys(out).length > 0 ? (out as T) : null
}

/** Combine authored layers from broadest to most specific. Social tags inherit
 * individually. A favicon or a list is one setting and is replaced as a unit. */
export function mergePageSeo(...layers: (PageSeo | undefined)[]): PageSeo | undefined {
  let result: PageSeo | undefined
  for (const layer of layers) {
    if (!layer) continue
    const previous = result
    result = { ...previous, ...layer }
    if (layer.openGraph) result.openGraph = { ...previous?.openGraph, ...layer.openGraph }
    if (layer.twitter) result.twitter = { ...previous?.twitter, ...layer.twitter }
  }
  return result
}
