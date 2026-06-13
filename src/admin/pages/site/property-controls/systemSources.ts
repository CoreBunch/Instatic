/**
 * System binding sources — `page`, `site`, `route`.
 *
 * The dynamic binding picker lists these alongside post-types and data
 * tables in its left pane. Each entry declares the fields a binding can
 * resolve against; the publisher's render context guarantees the
 * matching frames are populated on every render.
 *
 * Field definitions are intentionally hand-maintained (rather than
 * derived from schemas) because they're small, stable, and we want
 * explicit user-facing labels per field — not auto-camelCase magic.
 *
 * Each field's `format` lines up with `LoopSourceField['format']` so the
 * same compatibility filter the loop picker uses works here verbatim.
 */

import type { LoopSourceField } from '@core/loops/types'

export type SystemSourceId = 'page' | 'site' | 'route'

interface SystemSource {
  id: SystemSourceId
  label: string
  description: string
  fields: LoopSourceField[]
}

// ---------------------------------------------------------------------------
// page — current page being rendered
// ---------------------------------------------------------------------------

const PAGE_SOURCE: SystemSource = {
  id: 'page',
  label: 'Page',
  description: 'Fields of the page currently being rendered.',
  fields: [
    { id: 'title', label: 'Page title' },
    { id: 'slug', label: 'Slug' },
    { id: 'permalink', label: 'Permalink', format: 'url' },
    { id: 'parentSlug', label: 'Parent slug' },
  ],
}

// ---------------------------------------------------------------------------
// site — site-level fields
// ---------------------------------------------------------------------------

const SITE_SOURCE: SystemSource = {
  id: 'site',
  label: 'Site',
  description: 'Site-wide author-facing fields.',
  fields: [
    { id: 'name', label: 'Site name' },
  ],
}

// ---------------------------------------------------------------------------
// route — current URL frame
// ---------------------------------------------------------------------------

const ROUTE_SOURCE: SystemSource = {
  id: 'route',
  label: 'Route',
  description: 'Current URL path and slug. Useful for SEO and breadcrumbs.',
  fields: [
    { id: 'path', label: 'Path', format: 'url' },
    { id: 'slug', label: 'URL slug' },
  ],
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SYSTEM_SOURCES: readonly SystemSource[] = [
  PAGE_SOURCE,
  SITE_SOURCE,
  ROUTE_SOURCE,
]
