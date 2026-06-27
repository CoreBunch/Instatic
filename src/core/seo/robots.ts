/**
 * robots.txt generation — pure function from the stored body + context to the
 * served `text/plain` file. The body is authored directly in the admin
 * Robots tab's editor (`SeoRobotsSettings.content`); this module only adds
 * the bits the author shouldn't have to manage by hand:
 *
 *   - a sensible default body when nothing is stored yet,
 *   - the origin-resolved `Sitemap:` line (unless the body already has one),
 *   - the `blockAll` short-circuit the endpoint uses on non-canonical hosts.
 *
 * Shared by the server endpoint (`server/publish/seoEndpoints.ts`) and the
 * admin editor's "served file" hint so both agree byte-for-byte.
 */

import type { SeoRobotsSettings } from './schema'

/**
 * Non-content routes worth disallowing by default. `/admin` covers
 * `/admin/api`; `/_instatic/` covers the lazy fragment + runtime endpoints.
 * Part of the default template and the Robots tab's "recommended" shortcut.
 */
export const SYSTEM_DISALLOW_PATHS = ['/admin', '/_instatic/'] as const

/** The body served (and shown in the editor) when nothing is stored yet. */
export const DEFAULT_ROBOTS_TEMPLATE = [
  'User-agent: *',
  'Allow: /',
  ...SYSTEM_DISALLOW_PATHS.map((path) => `Disallow: ${path}`),
].join('\n')

export interface GenerateRobotsTxtInput {
  robots?: SeoRobotsSettings
  /** Whether sitemap generation is enabled (adds the `Sitemap:` line). */
  sitemapEnabled: boolean
  /** Absolute public origin for the Sitemap line; absent ⇒ line omitted. */
  origin?: string
  /**
   * When true, serve a blanket `Disallow: /` regardless of the stored body —
   * the endpoint uses this on a non-canonical host (preview/staging) so a
   * non-production deploy never gets indexed. No sitemap line.
   */
  blockAll?: boolean
}

const SITEMAP_DIRECTIVE = /^\s*sitemap\s*:/im

export function generateRobotsTxt(input: GenerateRobotsTxtInput): string {
  if (input.blockAll) return 'User-agent: *\nDisallow: /\n'

  const body = (input.robots?.content ?? '').trim() || DEFAULT_ROBOTS_TEMPLATE
  const lines = [body]

  // Append the sitemap line unless the author already declared one.
  if (input.sitemapEnabled && input.origin && !SITEMAP_DIRECTIVE.test(body)) {
    lines.push('', `Sitemap: ${input.origin.replace(/\/+$/, '')}/sitemap.xml`)
  }

  return `${lines.join('\n')}\n`
}
