/**
 * Shared system binding sources — `page`, `site`, `route`.
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

export type SystemSourceId = 'page' | 'site' | 'route' | 'member'

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
// member — the signed-in visitor
// ---------------------------------------------------------------------------

/**
 * Empty for a signed-out visitor. A value from here is different for every
 * visitor, so the publisher renders the element per visitor.
 *
 * `profile.name` is the profile field every site starts with. A field the
 * owner adds under member settings is bound the same way, by its id:
 * `{member.profile.<id>}`.
 */
const MEMBER_SOURCE: SystemSource = {
  id: 'member',
  label: 'Member',
  description: 'The signed-in member. Empty when the visitor is signed out.',
  fields: [
    { id: 'email', label: 'Email address' },
    { id: 'profile.name', label: 'Name' },
    { id: 'tagList', label: 'Tags' },
    { id: 'appRequest.name', label: 'App asking: name' },
    { id: 'appRequest.access', label: 'App asking: what it sees' },
    { id: 'appRequest.returnsTo', label: 'App asking: where it runs' },
    { id: 'appRequest.code', label: 'App connection: matching code' },
    { id: 'appRequest.email', label: 'App connection: verified address' },
    { id: 'appRequest.message', label: 'App connection: error message' },
    { id: 'appRequest.device', label: 'App asking: device name' },
  ],
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SYSTEM_SOURCES: readonly SystemSource[] = [
  PAGE_SOURCE,
  SITE_SOURCE,
  ROUTE_SOURCE,
  MEMBER_SOURCE,
]

/**
 * The member source's fields for a site: the fixed ones (email, tags) with
 * one `profile.<id>` entry per profile field the owner defined, in place of
 * the built-in `profile.name`.
 */
export function memberSourceFields(
  builtIn: readonly LoopSourceField[],
  profileFields: ReadonlyArray<{ id: string; label: string }>,
): LoopSourceField[] {
  const fixed = builtIn.filter((field) => !field.id.startsWith('profile.'))
  const [email, ...rest] = fixed
  return [
    ...(email ? [email] : []),
    ...profileFields.map((field) => ({ id: `profile.${field.id}`, label: field.label })),
    ...rest,
  ]
}
