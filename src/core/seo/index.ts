/**
 * @core/seo — public barrel.
 *
 * The SEO engine: persisted schemas, the shared fallback resolver, JSON-LD
 * builders, robots.txt generation, AI-crawler lists, per-target check
 * reports with weighted scores, and length meters. Imported by the publisher, server handlers, and the admin
 * SEO workspace. Deep imports are gated by
 * `src/__tests__/architecture/no-core-barrel-deep-imports.test.ts`.
 */

export {
  SeoMetadataSchema,
  SiteSeoSettingsSchema,
  SeoOrganizationSchema,
  SeoRobotsSettingsSchema,
  SeoSitemapSettingsSchema,
  OgTypeSchema,
  XCardTypeSchema,
  parseSeoMetadata,
  parseSiteSeoSettings,
  type SeoMetadata,
  type SiteSeoSettings,
  type SeoOrganization,
  type SeoRobotsSettings,
  type SeoSitemapSettings,
  type OgType,
  type XCardType,
} from './schema'

export {
  resolveSeoMetadata,
  isSafeCanonicalUrl,
  absoluteUrl,
  type ResolveSeoInput,
  type ResolvedSeoMetadata,
} from './resolve'

export {
  buildJsonLdEntities,
  serializeJsonLd,
  type JsonLdContext,
  type JsonLdEntity,
} from './jsonLd'

export { AI_TRAINING_CRAWLERS, AI_ANSWER_CRAWLERS } from './aiCrawlers'

export {
  generateRobotsTxt,
  SYSTEM_DISALLOW_PATHS,
  DEFAULT_ROBOTS_TEMPLATE,
  type GenerateRobotsTxtInput,
} from './robots'

export {
  lintRobotsTxt,
  matchRobots,
  type RobotsLintFinding,
  type RobotsLintLevel,
  type RobotsMatch,
} from './robotsAnalysis'

export {
  computeSeoReport,
  aggregateSeoScore,
  seoScoreTier,
  type SeoReport,
  type SeoCheck,
  type SeoCheckId,
  type SeoCheckStatus,
  type SeoScoreTier,
} from './health'

export {
  approxPixelWidth,
  meterZone,
  TITLE_PIXEL_BUDGET,
  TITLE_PIXEL_MIN,
  DESCRIPTION_PIXEL_BUDGET,
  DESCRIPTION_PIXEL_MIN,
  TITLE_CHAR_GUIDE,
  DESCRIPTION_CHAR_GUIDE,
  type MeterZone,
} from './lengthMeter'
