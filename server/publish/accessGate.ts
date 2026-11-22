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
import { accessAllows, LOCKED_ACCESS, parseAccessRule, type AccessRule, type CurrentMember } from '@core/members'
import type { Page } from '@core/page-tree'
import {
  buildMemberFrame,
  isTemplatePage,
  type MemberAppRequestFrame,
  type MemberFrame,
} from '@core/templates'
import { resolveSignedInMember } from '../members/handlers'
import { getMemberPagePaths } from '../members/pages'
import { toCurrentMember } from '../members/repository'
import { listProtectedTables, listTableIdsBySlug } from '../repositories/data/tableAccess'
import { listPublishedPageAccess } from '../repositories/publish'
import type { ClosedContent } from '@core/loops/types'
import { createVersionedSingleFlight } from './publishState'
import { pageArtefactUrlPath } from './staticArtefact'

interface AccessIndex {
  /** Published page slug → rule, protected pages only. */
  pages: Map<string, AccessRule>
  /**
   * Normalised, lower-cased table route base → rules, protected tables only.
   * A list, because two tables can have route bases that differ only by
   * letter case: neither rule may replace the other.
   */
  routeBases: Map<string, AccessRule[]>
  /** Table logical id → rule, protected tables only (routable or not). */
  tableIds: Map<string, AccessRule>
  /**
   * Slug → id of EVERY live table. Entry-template targets name tables by
   * slug; they are resolved to ids here, and every rule is then looked up by
   * id. A slug that resolves to no table fails closed.
   */
  tableIdsBySlug: Map<string, string>
}

const indexMemo = createVersionedSingleFlight<AccessIndex>()

/**
 * The protected routes as the database holds them right now, uncached. For
 * the publish bake, which runs between a publish's writes and the version
 * bump that the cached index is keyed by.
 */
export async function loadAccessIndex(db: DbClient): Promise<AccessIndex> {
  const pages = new Map<string, AccessRule>()
  for (const row of await listPublishedPageAccess(db)) {
    const rule = parseAccessRule(row.access)
    if (rule.level !== 'public') pages.set(row.slug, rule)
  }
  const routeBases = new Map<string, AccessRule[]>()
  const tableIds = new Map<string, AccessRule>()
  for (const table of await listProtectedTables(db)) {
    if (table.routeBase !== null) {
      const key = table.routeBase.toLowerCase()
      routeBases.set(key, [...(routeBases.get(key) ?? []), table.rule])
    }
    tableIds.set(table.id, table.rule)
  }
  return { pages, routeBases, tableIds, tableIdsBySlug: await listTableIdsBySlug(db) }
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

/*
 * Every function below returns the LIST of rules that apply, protected rules
 * only (an empty list means public). Rules are never merged into one: when
 * several apply to a request, `decideAccess` requires every one to pass.
 */

/** Rules the index holds for a URL path: a page at that slug, and its table. */
export function indexedRulesForPath(index: AccessIndex, pathname: string): AccessRule[] {
  if (index.pages.size === 0 && index.routeBases.size === 0) return []
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    decoded = pathname
  }
  const rules: AccessRule[] = []
  const pageRule = index.pages.get(slugFromPath(pathname)) ?? index.pages.get(slugFromPath(decoded))
  if (pageRule) rules.push(pageRule)
  const parts = decoded.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length >= 2) {
    rules.push(...(index.routeBases.get(`/${parts.slice(0, -1).join('/')}`.toLowerCase()) ?? []))
  }
  return rules
}

/**
 * Every rule that applies to an entry of `tableId` served at `pathname`: the
 * table's own rule, found by the table's ID, and whatever the index holds for
 * the path as it is spelled. By id, never by route base or slug: those are
 * strings the owner can change while this index is cached, and a rule looked
 * up by a string that has moved on is a rule not found.
 */
export function rowRouteRules(index: AccessIndex, tableId: string, pathname: string): AccessRule[] {
  const rule = index.tableIds.get(tableId)
  return [...(rule ? [rule] : []), ...indexedRulesForPath(index, pathname)]
}

/**
 * Who the HTML of a render under these rules is for: `member` as soon as any
 * rule protects it. The one place this is decided, for the public router and
 * for background re-renders alike.
 */
export function audienceForRules(rules: readonly AccessRule[]): 'public' | 'member' {
  return rules.length > 0 ? 'member' : 'public'
}

/**
 * Every rule that applies to a page served at `pathname`: the page's own
 * (`pageRules`; a page that cannot be found is locked) AND whatever the index
 * holds for the path as it is spelled (a page at that slug, a protected
 * table whose route base the path sits under). The full rule set of a page
 * route, in one place: the public router decides access from it, and a
 * background re-render takes its audience from it.
 */
export function pageRouteRules(index: AccessIndex, page: Page | undefined, pathname: string): AccessRule[] {
  return [...(page ? pageRules(index, page) : [LOCKED_ACCESS]), ...indexedRulesForPath(index, pathname)]
}

/**
 * The audience of a published page rendered outside a request (a background
 * re-render), from the same rules as a request for the page's own address.
 */
export function pageAudience(index: AccessIndex, page: Page | undefined): 'public' | 'member' {
  return audienceForRules(pageRouteRules(index, page, page ? pageArtefactUrlPath(page.slug) : '/'))
}

/**
 * The rules that go with a page object, for the page itself and for anything
 * served on its behalf (hole and loop fragments).
 *
 * A routable page: its own rule. An entry template: the rule of every table
 * it renders, found by table id, so a fragment of a protected table's
 * template is protected whatever route the caller claims to be on; a target
 * that names no live table is locked. Any other template (a layout,
 * the 404 page) only wraps and has no rule of its own.
 */
export function pageRules(index: AccessIndex, page: Page): AccessRule[] {
  if (!isTemplatePage(page)) {
    const rule = index.pages.get(page.slug) ?? page.access
    return rule && rule.level !== 'public' ? [rule] : []
  }
  const target = page.template?.target
  if (target?.kind !== 'postTypes') return []
  return target.tableSlugs.flatMap((slug) => {
    const tableId = index.tableIdsBySlug.get(slug)
    // A target naming a table that is not there (renamed, deleted): nothing
    // tells whose entries this template was made for, so it is locked.
    if (tableId === undefined) return [LOCKED_ACCESS]
    const rule = index.tableIds.get(tableId)
    return rule ? [rule] : []
  })
}

/**
 * What a visitor with these tags (null = signed out) may not open: the
 * tables and pages a listing must leave out for them.
 */
export function closedContentFor(index: AccessIndex, tags: readonly string[] | null): ClosedContent {
  const closedIds = (rules: Map<string, AccessRule>): Set<string> =>
    new Set([...rules].filter(([, rule]) => !accessAllows(rule, tags)).map(([key]) => key))
  return { tableIds: closedIds(index.tableIds), pageSlugs: closedIds(index.pages) }
}

// ─── The visitor ───────────────────────────────────────────────────────────

/**
 * The signed-in member, or null when signed out. Resolved at most once per
 * request, and only when something actually depends on the visitor (a
 * protected route, or a fragment that shows member data): plain public pages
 * never read a session.
 */
export type Visitor = () => Promise<CurrentMember | null>

export function visitorFromRequest(db: DbClient, req: Request): Visitor {
  let resolved: Promise<CurrentMember | null> | null = null
  return () => {
    resolved ??= (async () => {
      const current = await resolveSignedInMember(db, req)
      return current ? toCurrentMember(db, current.member) : null
    })()
    return resolved
  }
}

/**
 * The `member` slot of a render context for one visitor: the member's frame,
 * or null for a signed-out visitor. (Leaving the slot out altogether means
 * the render is for nobody in particular; see `TemplateRenderDataContext`.)
 */
export function memberFrameFor(
  member: CurrentMember | null,
  appRequest: MemberAppRequestFrame | null = null,
): MemberFrame | null {
  return member ? buildMemberFrame(member, appRequest) : null
}

const SIGNED_OUT: Visitor = () => Promise.resolve(null)

export type AccessDecision = 'allow' | 'login' | 'forbidden' | 'hide'

/**
 * Decide for a request that `rules` apply to. Every rule must let the
 * visitor in. When one does not, a hiding rule wins over a telling one, so a
 * route is never confirmed to exist to someone a rule hides it from.
 */
export async function decideAccess(rules: readonly AccessRule[], visitor: Visitor = SIGNED_OUT): Promise<AccessDecision> {
  const protecting = rules.filter((rule) => rule.level !== 'public')
  if (protecting.length === 0) return 'allow'
  const tags = (await visitor())?.tags ?? null
  const denying = protecting.filter((rule) => !accessAllows(rule, tags))
  if (denying.length === 0) return 'allow'
  if (denying.some((rule) => rule.onDeny === 'hide')) return 'hide'
  return tags === null ? 'login' : 'forbidden'
}

/** Headers for anything rendered for one visitor: no shared or browser cache may keep it. */
export const PRIVATE_HEADERS = { 'cache-control': 'private, no-store' } as const

/**
 * The response for a signed-out visitor who should be asked to sign in: a
 * redirect to the site's sign-in page, remembering where they were going.
 *
 * Returns null when there is nothing to send them to, and the caller then
 * answers as if the route did not exist:
 *  - the owner has not assigned a sign-in page, or it is not published
 *    (core has none of its own);
 *  - the visitor is signed in but lacks the tag (`forbidden`): signing in
 *    again would not help, and the site has no page for that either.
 */
export async function denyResponse(
  db: DbClient,
  url: URL,
  decision: 'login' | 'forbidden',
): Promise<Response | null> {
  if (decision === 'forbidden') return null
  const pages = await getMemberPagePaths(db)
  if (!pages.login) return null
  const target = new URL(pages.login, url.origin)
  target.searchParams.set('next', `${url.pathname}${url.search}`)
  return new Response(null, {
    status: 302,
    headers: { location: `${target.pathname}${target.search}`, ...PRIVATE_HEADERS },
  })
}
