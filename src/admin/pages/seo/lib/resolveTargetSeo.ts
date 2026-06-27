/**
 * Admin-side SEO resolution helpers — bridge the workspace's target list to
 * the shared `@core/seo` resolver so previews, placeholders, and health
 * indicators show EXACTLY what the publisher will emit.
 *
 * Token interpolation: the publisher interpolates `{source.field}` patterns
 * against the live render context. The admin preview approximates the same
 * result with the values it has (page title, site name) — enough for the
 * editor to see "Hello World — Acme" instead of raw pattern syntax.
 */
import {
  resolveSeoMetadata,
  type ResolvedSeoMetadata,
  type SeoMetadata,
  type SiteSeoSettings,
} from '@core/seo'
import type { SeoTarget } from './seoApi'

/**
 * Preview-grade token interpolation. Replaces the tokens the SEO title
 * patterns commonly use with the values the workspace knows; unknown tokens
 * collapse to empty string — same forgiving behaviour as the real engine.
 */
export function previewInterpolate(
  pattern: string,
  values: { pageTitle: string; siteName: string },
): string {
  return pattern
    .replaceAll('{page.title}', values.pageTitle)
    .replaceAll('{currentEntry.title}', values.pageTitle)
    .replaceAll('{site.name}', values.siteName)
    .replace(/\{[a-zA-Z0-9_.]+\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface ResolveTargetSeoContext {
  siteName: string
  language: string | null
  publicOrigin: string | null
  siteSeo: SiteSeoSettings | null
  /** All targets — used to find a post's entry template for its patterns. */
  targets: SeoTarget[]
}

/** The entry template whose target list covers this post's table. */
export function templateForPost(target: SeoTarget, targets: SeoTarget[]): SeoTarget | undefined {
  if (target.kind !== 'post' || !target.tableSlug) return undefined
  return targets.find(
    (candidate) =>
      candidate.kind === 'template' &&
      (candidate.templateTableSlugs ?? []).includes(target.tableSlug!),
  )
}

/**
 * Resolve the final metadata for a target with a draft SEO object overlayed
 * (the editor passes its in-progress draft; the index passes the stored
 * value). Same fallback engine as the publisher.
 */
export function resolveTargetSeo(
  target: SeoTarget,
  draft: SeoMetadata | undefined,
  ctx: ResolveTargetSeoContext,
): ResolvedSeoMetadata {
  const template = templateForPost(target, ctx.targets)
  return resolveSeoMetadata({
    target: draft ?? target.seo ?? undefined,
    templateSeo: template?.seo ?? undefined,
    siteSeo: ctx.siteSeo ?? undefined,
    siteName: ctx.siteName,
    baseTitle: target.title,
    routeKind: target.kind === 'post' ? 'row' : 'page',
    routePath: target.route ?? '/',
    origin: ctx.publicOrigin ?? undefined,
    language: ctx.language ?? undefined,
    publishedAt: target.publishedAt ?? undefined,
    updatedAt: target.updatedAt,
    interpolate: (pattern) =>
      previewInterpolate(pattern, { pageTitle: target.title, siteName: ctx.siteName }),
  })
}
