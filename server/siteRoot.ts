/**
 * The site-root text surface — `/robots.txt` and plugin-claimed
 * `/<name>.txt` files.
 *
 * Both exist because two SEO standards authorize by *file location*, and
 * neither can be satisfied from a plugin's runtime path
 * (`/admin/api/cms/plugins/<id>/runtime/...`): the sitemaps.org protocol
 * scopes a sitemap to its own directory and below, and indexnow.org scopes
 * a key file the same way. See issue #425.
 *
 * Two plugin surfaces, both hook-bus filters (`cms.hooks` permission):
 *
 *   • `site.robots`     — the host seeds a default document, plugins add
 *                         directives (in practice `Sitemap:` URLs), the
 *                         HOST renders the text. Plugins never write robots
 *                         syntax, so they cannot inject comments, extra
 *                         directives, or stray CR/LF.
 *   • `site.rootFiles`  — plugins claim one root `.txt` path each with its
 *                         body. The host validates the path against an
 *                         allowlist pattern and serves the body as inert
 *                         `text/plain`.
 *
 * Ordering in the dispatcher: both handlers sit directly BEFORE
 * `tryServePublicRoute`, so every host-owned namespace (`/admin/*`,
 * `/_instatic/*`, `/uploads/*`, `/assets/*` from `dist/`) still wins. They
 * cannot shadow content either: `pageSlugError` in
 * `src/core/page-tree/slugs.ts` rejects any slug containing `.`, and a
 * data-row route needs at least `/<table>/<slug>`, so no published URL can
 * ever be a root `.txt` path.
 *
 * Neither response is baked into the published slot (Layer A). Artefacts
 * there are `.html` files named from page routes, written wholesale per
 * publish; these two documents depend on which plugins are active right
 * now, so a baked copy would keep serving a disabled plugin's sitemap
 * reference or IndexNow key until the next publish. Same reasoning as the
 * `no-store` on the signed media redirect in `server/router.ts`.
 *
 * The filters run per request rather than behind a memo: the
 * `hasFiltersFor` short-circuit means a site with no contributing plugin
 * does zero work, and a memo keyed on registration would go stale when a
 * plugin's settings change the key it serves.
 */

import { filterArray } from '@core/utils/typeboxHelpers'
import { hookBus } from '@core/plugins/hookBus'
import {
  MAX_ROBOTS_GROUPS,
  MAX_ROBOTS_SITEMAPS,
  MAX_ROOT_FILE_CLAIMS,
  ROOT_FILE_PATH_PATTERN,
  RobotsGroupSchema,
  SiteRootFileSchema,
  SitemapUrlSchema,
  type RobotsDocument,
  type SiteRootFile,
} from '@core/plugin-sdk'

const ROBOTS_PATH = '/robots.txt'
const ROBOTS_FILTER = 'site.robots'
const ROOT_FILES_FILTER = 'site.rootFiles'

/**
 * Root paths a plugin can never claim. `/robots.txt` is host-managed
 * through the `site.robots` filter, and letting a plugin claim it as a raw
 * file would be a second, conflicting way to write the same document.
 */
const RESERVED_ROOT_FILE_PATHS: ReadonlySet<string> = new Set([ROBOTS_PATH])

const ROOT_FILE_PATH_RE = new RegExp(ROOT_FILE_PATH_PATTERN)

/**
 * The document the `site.robots` chain starts from, and the group the host
 * re-inserts when the filtered document has no valid group left. Permissive
 * on purpose: it is the same instruction to a crawler that the previous
 * `/robots.txt` 404 carried (RFC 9309 §2.3.1.3 — an unavailable robots.txt
 * means "crawl freely"), so adding the file changes no crawler's behaviour
 * on a site with no plugins.
 */
function defaultRobotsDocument(): RobotsDocument {
  return { groups: [{ userAgent: '*', allow: ['/'], disallow: [] }], sitemaps: [] }
}

/**
 * Serialize a validated document. One group per block, `User-agent` first,
 * then its `disallow` lines, then its `allow` lines; `Sitemap:` lines last
 * because they are global rather than group-scoped.
 */
function renderRobotsTxt(document: RobotsDocument): string {
  const blocks = document.groups.map((group) =>
    [
      `User-agent: ${group.userAgent}`,
      ...group.disallow.map((path) => `Disallow: ${path}`),
      ...group.allow.map((path) => `Allow: ${path}`),
    ].join('\n'),
  )
  if (document.sitemaps.length > 0) {
    blocks.push(document.sitemaps.map((url) => `Sitemap: ${url}`).join('\n'))
  }
  return `${blocks.join('\n\n')}\n`
}

/**
 * Run the filter chain and keep only what validates. Entries are dropped
 * one by one (`filterArray`) rather than failing the whole document,
 * matching how the site document tolerates one corrupt font file — a group
 * is the validation unit, so a stray `Disallow` drops its group and nothing
 * else. Sitemap URLs are de-duplicated, first occurrence winning, so two
 * plugins pushing the same sitemap emit one line.
 */
async function buildRobotsDocument(): Promise<RobotsDocument> {
  const seed = defaultRobotsDocument()
  if (!hookBus.hasFiltersFor(ROBOTS_FILTER)) return seed

  const filtered = await hookBus.applyFilter<RobotsDocument>(ROBOTS_FILTER, seed)
  const groups = filterArray(RobotsGroupSchema, filtered.groups).slice(0, MAX_ROBOTS_GROUPS)
  const sitemaps = [...new Set(filterArray(SitemapUrlSchema, filtered.sitemaps))]
    .slice(0, MAX_ROBOTS_SITEMAPS)
  return {
    // A document with no valid group would render as crawl rules the site
    // owner never asked for, so the host default stands in.
    groups: groups.length > 0 ? groups : defaultRobotsDocument().groups,
    sitemaps,
  }
}

/**
 * Resolve the claimed root files, keyed by path. A path claimed by more
 * than one handler is dropped and logged: serving one of two IndexNow keys
 * would silently authorize the wrong submitter, so "refuse and say so" is
 * the only deterministic answer. `applyFilter` chains handlers opaquely, so
 * the log names every plugin registered on the filter as the candidates.
 *
 * Entries past `MAX_ROOT_FILE_CLAIMS` are discarded, so the accepted set is
 * bounded no matter how many a handler appends.
 */
async function resolveRootFileClaims(): Promise<Map<string, string>> {
  const filtered = await hookBus.applyFilter(ROOT_FILES_FILTER, { files: [] as SiteRootFile[] })
  const claims = new Map<string, string>()
  const contested = new Set<string>()
  const accepted = filterArray(SiteRootFileSchema, filtered.files).slice(0, MAX_ROOT_FILE_CLAIMS)
  for (const file of accepted) {
    if (RESERVED_ROOT_FILE_PATHS.has(file.path)) {
      console.error(
        `[siteRoot] root file "${file.path}" is reserved by the host; ignoring the claim. ` +
          `Registered by one of: ${hookBus.pluginsFor(ROOT_FILES_FILTER).join(', ')}`,
      )
      continue
    }
    if (claims.has(file.path) || contested.has(file.path)) {
      contested.add(file.path)
      claims.delete(file.path)
      console.error(
        `[siteRoot] root file "${file.path}" was claimed more than once; refusing to serve it. ` +
          `Registered by one of: ${hookBus.pluginsFor(ROOT_FILES_FILTER).join(', ')}`,
      )
      continue
    }
    claims.set(file.path, file.content)
  }
  return claims
}

/**
 * `text/plain` with the same hardening the published runtime assets get:
 * `nosniff` so the body can never be re-interpreted as HTML or script, and
 * a `default-src 'none'` CSP so it stays inert even if a browser navigates
 * to it directly. `no-store` because the body reflects live plugin state.
 */
function textResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  })
}

/**
 * Serve `/robots.txt`. Always answers for that exact path — the document is
 * host-managed whether or not a plugin contributes to it.
 */
export async function serveRobotsTxt(pathname: string): Promise<Response | null> {
  if (pathname !== ROBOTS_PATH) return null
  return textResponse(renderRobotsTxt(await buildRobotsDocument()))
}

/**
 * Serve a plugin-claimed root text file, or `null` when the path isn't
 * claimable or isn't claimed.
 *
 * The pathname is matched raw, never percent-decoded: a registered path
 * cannot contain `%` (the allowlist pattern excludes it), so an encoded
 * request like `/%2e%2e/key.txt` fails the pattern instead of resolving to
 * a claim.
 */
export async function serveRootFile(pathname: string): Promise<Response | null> {
  if (!hookBus.hasFiltersFor(ROOT_FILES_FILTER)) return null
  if (RESERVED_ROOT_FILE_PATHS.has(pathname)) return null
  if (!ROOT_FILE_PATH_RE.test(pathname)) return null

  const claims = await resolveRootFileClaims()
  const content = claims.get(pathname)
  if (content === undefined) return null
  return textResponse(content)
}
