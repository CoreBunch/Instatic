/**
 * Named context frames — the data behind every non-entry binding source.
 *
 * The publisher hands each render a `TemplateRenderDataContext` (defined in
 * `./dynamicBindings.ts`) whose entry-stack is augmented with four
 * always-present frames:
 *
 *   - `page`   — fields of the page currently being rendered
 *   - `site`   — site-level fields
 *   - `route`  — URL frame for the current request
 *
 * Each frame is a flat `Record<string, unknown>` keyed by the field id the
 * binding's `field` path opens with. Deep traversal (relations on
 * `currentEntry.author.name`) is handled by the resolver — frames
 * themselves are intentionally flat to keep schemas predictable.
 *
 * Builders below normalise each frame's shape once per render so the
 * resolver stays a one-line lookup at the binding site.
 */

import type { CurrentMember } from '@core/members'
import type { Page, SiteDocument } from '@core/page-tree'
import { primaryTemplateTableSlug } from './templateMatching'

// ---------------------------------------------------------------------------
// Frame shapes
// ---------------------------------------------------------------------------

export interface PageFrame {
  id: string
  slug: string
  title: string
  permalink: string
  isTemplate: boolean
  templateTableSlug: string | null
  parentSlug: string | null
}

export interface SiteFrame {
  id: string
  name: string
}

/**
 * URL frame for the current request.
 *
 * - `path` is the full URL path (`/posts/hello`).
 * - `slug` is the trailing segment, useful for template pages where the
 *   row's slug is the only meaningful URL bit.
 * - `segments` is the full path split — `["posts", "hello"]`.
 * - `query` is a flat map of URL query params for `route.query.*` bindings.
 */
export interface RouteFrame {
  path: string
  slug: string | null
  segments: string[]
  query: Record<string, string>
}

/**
 * The signed-in member, for `member.*` bindings and show-when rules.
 * `tags` is the list a show-when rule checks; `tagList` is the same tags as
 * text, for a binding.
 */
export interface MemberFrame {
  id: string
  email: string
  profile: Record<string, string>
  tags: readonly string[]
  tagList: string
  /**
   * The app waiting for this member's answer, on a page opened with an app's
   * sign-in request in its address. Null everywhere else. The values come
   * from the stored request, never from the address itself.
   */
  appRequest: MemberAppRequestFrame | null
}

export interface MemberAppRequestFrame {
  /** The app's name, as the site owner registered it. */
  name: string
  /** What the app asks to see, as a sentence fragment. */
  access: string
  /** The host the answer is sent back to. */
  returnsTo: string
  /** What the app calls the device it runs on. The app's own word; empty when it gave none. */
  device: string
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Build a page frame from the in-memory page document. Used by both
 * the publisher (server-side) and the editor canvas preview hook.
 *
 * The `permalink` mirrors the public URL convention used elsewhere
 * (`'/' + slug`, special-casing `index`).
 */
export function buildPageFrame(page: Page): PageFrame {
  const slug = page.slug
  const normalizedSlug = slug.startsWith('/') ? slug : `/${slug}`
  const permalink = normalizedSlug === '/index' ? '/' : normalizedSlug
  const parentSlug = (() => {
    const trimmed = slug.replace(/^\/+|\/+$/g, '')
    const idx = trimmed.lastIndexOf('/')
    return idx > 0 ? trimmed.slice(0, idx) : null
  })()
  return {
    id: page.id,
    slug,
    title: page.title,
    permalink,
    isTemplate: page.template?.enabled === true,
    templateTableSlug: primaryTemplateTableSlug(page),
    parentSlug,
  }
}

export function buildSiteFrame(site: SiteDocument): SiteFrame {
  return {
    id: site.id,
    name: site.name,
  }
}

/**
 * Build the route frame from a URL string. The publisher passes the
 * request URL; for the editor preview we pass a synthesized one based
 * on the page slug so token interpolation has stable values to show.
 */
export function buildRouteFrame(urlOrPath: string): RouteFrame {
  let path: string
  let query: Record<string, string>
  try {
    const u = new URL(urlOrPath, 'http://_invalid')
    path = u.pathname
    query = Object.fromEntries(u.searchParams.entries())
  } catch {
    const [rawPath, rawQuery = ''] = urlOrPath.split('?', 2)
    path = rawPath ?? urlOrPath
    query = Object.fromEntries(new URLSearchParams(rawQuery).entries())
  }
  if (!path.startsWith('/')) path = `/${path}`
  const segments = path.split('/').filter((s) => s.length > 0)
  const slug = segments.length > 0 ? segments[segments.length - 1]! : null
  return {
    path,
    slug,
    segments,
    query,
  }
}

/** A checkbox profile field reads as "yes" or blank, so a binding prints something sensible. */
export function buildMemberFrame(
  member: CurrentMember,
  appRequest: MemberAppRequestFrame | null = null,
): MemberFrame {
  return {
    id: member.id,
    email: member.email,
    profile: Object.fromEntries(
      Object.entries(member.profile).map(([key, value]) => [key, typeof value === 'boolean' ? (value ? 'yes' : '') : value]),
    ),
    tags: member.tags,
    tagList: member.tags.join(', '),
    appRequest,
  }
}

/**
 * A stand-in member for the editor canvas, so an element bound to member
 * data shows where the value will go instead of collapsing to nothing.
 */
export const PREVIEW_MEMBER_FRAME: MemberFrame = {
  id: 'preview-member',
  email: 'member@example.com',
  profile: { name: 'Member name' },
  tags: [],
  tagList: 'tag',
  appRequest: { name: 'App name', access: 'what the app asks to see', returnsTo: 'this device', device: 'Device name' },
}
