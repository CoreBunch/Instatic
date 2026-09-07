/**
 * TypeBox schemas for the site-root text surface — the host-managed
 * `/robots.txt` document and the root-level text files plugins can claim.
 *
 * These schemas are the source of truth for both `site.*` filter payloads.
 * All types are derived from them via `Static<>`.
 *
 * Used across:
 *   - `src/core/plugin-sdk/types/hooks.ts` — the `CmsServerFilters` entries
 *   - `server/siteRoot.ts`                 — host validation + rendering
 *
 * Why the payloads are structured rather than raw text: a filter that
 * returned a finished `robots.txt` string would let one plugin inject
 * arbitrary lines (comments, `Sitemap:` entries pointing anywhere, stray
 * CR/LF) that the host has no way to audit. Here the host owns the
 * serialization and every field carries a pattern, so a plugin can only
 * contribute values that render to exactly one directive line.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * A path prefix for an `Allow:` / `Disallow:` directive. Must start at the
 * site root and carry no whitespace (which would split the directive line)
 * and no `#` (which would open a robots.txt comment).
 */
export const RobotsPathSchema = Type.String({ pattern: '^/[^\\s#]{0,511}$' })

/**
 * A `Sitemap:` URL. Absolute by protocol requirement — a sitemap reference
 * is resolved against the origin, not the robots.txt file.
 */
export const SitemapUrlSchema = Type.String({
  maxLength: 2048,
  pattern: '^https?://[^\\s#]+$',
})

/**
 * Caps on how much one document can carry. The host validates list entries
 * one by one — a group with a bad `Disallow` is dropped without costing the
 * plugin its `Sitemap` lines — so these bounds are also what it truncates
 * the accepted lists to; a hostile handler cannot grow the response without
 * limit.
 */
export const MAX_ROBOTS_GROUPS = 20
export const MAX_ROBOTS_SITEMAPS = 50
const MAX_ROBOTS_PATHS_PER_GROUP = 100

/**
 * One `User-agent` group. The user-agent value is a product token (`*`,
 * `Googlebot`), so the same no-whitespace / no-comment rule applies.
 */
export const RobotsGroupSchema = Type.Object(
  {
    userAgent: Type.String({ maxLength: 200, pattern: '^[^\\s#]+$' }),
    allow: Type.Array(RobotsPathSchema, { maxItems: MAX_ROBOTS_PATHS_PER_GROUP }),
    disallow: Type.Array(RobotsPathSchema, { maxItems: MAX_ROBOTS_PATHS_PER_GROUP }),
  },
  { additionalProperties: false },
)

export type RobotsGroup = Static<typeof RobotsGroupSchema>

/**
 * The whole `/robots.txt` document, as the `site.robots` filter sees it.
 * Handlers mutate and return it; the host renders the result.
 */
export const RobotsDocumentSchema = Type.Object(
  {
    groups: Type.Array(RobotsGroupSchema, { maxItems: MAX_ROBOTS_GROUPS }),
    sitemaps: Type.Array(SitemapUrlSchema, { maxItems: MAX_ROBOTS_SITEMAPS }),
  },
  { additionalProperties: false },
)

export type RobotsDocument = Static<typeof RobotsDocumentSchema>

// ---------------------------------------------------------------------------
// Root-level text files
// ---------------------------------------------------------------------------

/**
 * The paths a plugin may claim: one root segment, `.txt` only, no percent
 * escapes, no dot segments (the leading character class rules out `.` and
 * `-`). Deliberately narrow — the site root is shared with page slugs,
 * the admin app, and every reserved namespace, so the claimable surface is
 * an allowlist rather than a denylist.
 */
export const ROOT_FILE_PATH_PATTERN = '^/[A-Za-z0-9][A-Za-z0-9._-]{0,62}\\.txt$'

/** Most claims the host accepts, and the bound it truncates the list to. */
export const MAX_ROOT_FILE_CLAIMS = 20

/**
 * A single claimed file. `content` allows tabs and newlines but no other C0
 * control characters, so the body can never carry NUL padding or terminal
 * escapes; 4 KiB is well above the largest legitimate case (an IndexNow key
 * is 8–128 characters).
 */
export const SiteRootFileSchema = Type.Object(
  {
    path: Type.String({ pattern: ROOT_FILE_PATH_PATTERN }),
    content: Type.String({
      maxLength: 4096,
      pattern: '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]*$',
    }),
  },
  { additionalProperties: false },
)

export type SiteRootFile = Static<typeof SiteRootFileSchema>

/**
 * The claim list, as the `site.rootFiles` filter sees it. Handlers append
 * their own entries and return it; the host resolves the claims.
 */
export const SiteRootFilesSchema = Type.Object(
  {
    files: Type.Array(SiteRootFileSchema, { maxItems: MAX_ROOT_FILE_CLAIMS }),
  },
  { additionalProperties: false },
)

export type SiteRootFiles = Static<typeof SiteRootFilesSchema>
