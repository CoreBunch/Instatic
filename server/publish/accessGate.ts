/**
 * Who may open a published route.
 *
 * Two things keep a protected page from ever reaching someone who may not
 * see it:
 *
 *  1. **It is never stored where a request could be answered without
 *     asking.** Protected routes are not baked to the static slot and never
 *     enter the render cache (see `publishSite.ts`, `bakeDataRows.ts`,
 *     `publishRow.ts`, `publicRouter.ts`).
 *  2. **The rule is checked on every request**, from the route that actually
 *     resolved, before anything is rendered.
 *
 * The access index is the publish-time map of protected routes. The public
 * router consults it first so a protected path skips both cache layers
 * outright; the per-request check after resolution is the one that decides.
 */
import type { DbClient } from '../db/client'
import { accessAllows, parseAccessRule, PUBLIC_ACCESS, type AccessRule } from '@core/members'
import type { Page } from '@core/page-tree'
import { isTemplatePage, normalizeRouteBase } from '@core/templates'
import { resolveSignedInMember } from '../members/handlers'
import { getMemberSettings, listActiveMemberTags } from '../members/repository'
import { listProtectedTableRoutes } from '../repositories/data/tableAccess'
import { listPublishedPageAccess } from '../repositories/publish'
import { createVersionedSingleFlight } from './publishState'

interface AccessIndex {
  /** Published page slug → rule, protected pages only. */
  pages: Map<string, AccessRule>
  /** Normalised table route base → rule, protected tables only. */
  routeBases: Map<string, AccessRule>
}

const indexMemo = createVersionedSingleFlight<AccessIndex>()

async function loadAccessIndex(db: DbClient): Promise<AccessIndex> {
  const pages = new Map<string, AccessRule>()
  for (const row of await listPublishedPageAccess(db)) {
    const rule = parseAccessRule(row.access)
    if (rule.level !== 'public') pages.set(row.slug, rule)
  }
  const routeBases = new Map<string, AccessRule>()
  for (const entry of await listProtectedTableRoutes(db)) routeBases.set(entry.routeBase, entry.rule)
  return { pages, routeBases }
}

/**
 * The protected routes for a publish version. Loaded once per version; a
 * page publish or a table access change bumps the version.
 */
export async function getAccessIndex(db: DbClient, version: number): Promise<AccessIndex> {
  const index = await indexMemo.get(version, () => loadAccessIndex(db))
  if (!index) throw new Error('access index failed to load')
  return index
}

function slugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

/** The rule the index holds for a URL path: a page at that slug, else its table. */
export function indexedRuleForPath(index: AccessIndex, pathname: string): AccessRule {
  if (index.pages.size === 0 && index.routeBases.size === 0) return PUBLIC_ACCESS
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    decoded = pathname
  }
  const pageRule = index.pages.get(slugFromPath(pathname)) ?? index.pages.get(slugFromPath(decoded))
  if (pageRule) return pageRule
  const parts = decoded.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length < 2) return PUBLIC_ACCESS
  return index.routeBases.get(`/${parts.slice(0, -1).join('/')}`) ?? PUBLIC_ACCESS
}

export function tableRuleForRouteBase(index: AccessIndex, routeBase: string): AccessRule {
  return index.routeBases.get(normalizeRouteBase(routeBase)) ?? PUBLIC_ACCESS
}

/** A page's own rule: the published one from the index, or the one on the page object. */
export function pageRule(index: AccessIndex, page: Page): AccessRule {
  if (isTemplatePage(page)) return PUBLIC_ACCESS // templates only wrap; the route they wrap decides
  return index.pages.get(page.slug) ?? page.access ?? PUBLIC_ACCESS
}

/** Of two rules for the same route, the one that is not public (the first wins a tie). */
export function strictest(first: AccessRule, second: AccessRule): AccessRule {
  return first.level !== 'public' ? first : second
}

// ─── The visitor ───────────────────────────────────────────────────────────

/**
 * The signed-in member's tags, or null when signed out. Resolved at most
 * once per request, and only when a protected route is actually hit: public
 * pages never read a session.
 */
export type Visitor = () => Promise<string[] | null>

export function visitorFromRequest(db: DbClient, req: Request): Visitor {
  let resolved: Promise<string[] | null> | null = null
  return () => {
    resolved ??= (async () => {
      const current = await resolveSignedInMember(db, req)
      return current ? listActiveMemberTags(db, current.member.id) : null
    })()
    return resolved
  }
}

const SIGNED_OUT: Visitor = () => Promise.resolve(null)

export type AccessDecision = 'allow' | 'login' | 'forbidden' | 'hide'

export async function decideAccess(rule: AccessRule, visitor: Visitor = SIGNED_OUT): Promise<AccessDecision> {
  if (rule.level === 'public') return 'allow'
  const tags = await visitor()
  if (accessAllows(rule, tags)) return 'allow'
  if (rule.onDeny === 'hide') return 'hide'
  return tags === null ? 'login' : 'forbidden'
}

/** Headers for anything rendered for one visitor: no shared or browser cache may keep it. */
export const PRIVATE_HEADERS = { 'cache-control': 'private, no-store' } as const

export const MEMBER_SIGN_IN_PATH = '/_instatic/members/sign-in'

/**
 * The response for a visitor who may not open a route and should be told so.
 * `login`: send them to the sign-in page, remembering where they were going.
 * `forbidden`: they are signed in but lack the tag.
 * (`hide` has no response here: the caller answers as if nothing existed.)
 */
export async function denyResponse(
  db: DbClient,
  url: URL,
  decision: 'login' | 'forbidden',
): Promise<Response> {
  if (decision === 'forbidden') {
    return new Response(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
        '<title>No access</title></head><body><h1>No access</h1>' +
        '<p>Your account does not include this page.</p><p><a href="/">Back to the home page</a></p></body></html>',
      { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS } },
    )
  }
  const settings = await getMemberSettings(db)
  const target = new URL(settings.pages.login ?? MEMBER_SIGN_IN_PATH, url.origin)
  target.searchParams.set('next', `${url.pathname}${url.search}`)
  return new Response(null, {
    status: 302,
    headers: { location: `${target.pathname}${target.search}`, ...PRIVATE_HEADERS },
  })
}
