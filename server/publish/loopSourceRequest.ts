/**
 * What a request-time render tells each loop source about the request.
 *
 * One render can hold several lists. The request is built per source, so the
 * visitor's cookies and the signed-in member reach only a `perVisitor`
 * source: a shared source in the same fragment is told neither. The fragment
 * endpoint (`handlers/cms/hole.ts`) and the list-page endpoint
 * (`handlers/cms/loop.ts`) both go through here, so they cannot drift.
 */
import type { CurrentMember } from '@core/members'
import type { Page, SiteDocument } from '@core/page-tree'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopEntitySource, SourceRequestContext, SourceRequestMember } from '@core/loops/types'
import { isSessionCookieName } from '../sessionCookies'
import type { Visitor } from './accessGate'
import { collectLoopNodes, readLoopProps } from './loopPrefetch'

/** The part of a request every request-time source may see. */
type SourceRequestBase = Pick<SourceRequestContext, 'query' | 'path' | 'slug'>

export interface LoopRequestScope {
  base: SourceRequestBase
  /**
   * Set when the render is for one visitor and is never cached. Absent for a
   * shared (cached) render and for previews, where there is no visitor.
   */
  visitor?: {
    cookies: Record<string, string>
    /** Looked up at most once, and only if a source is going to be told. */
    member: () => Promise<SourceRequestMember | null>
  }
}

/**
 * Parse a `Cookie` header into a flat map for a per-visitor loop source.
 * Session cookies are left out: sources can be plugin code. Returns `{}`
 * when absent.
 */
function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || isSessionCookieName(name)) continue
    out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

function sourceMemberFor(member: CurrentMember | null): SourceRequestMember | null {
  return member ? { id: member.id, email: member.email, tags: member.tags, profile: member.profile } : null
}

/** The scope of a render done for the visitor behind `req`. */
export function visitorRequestScope(base: SourceRequestBase, req: Request, visitor: Visitor): LoopRequestScope {
  return {
    base,
    visitor: {
      cookies: parseCookies(req.headers.get('cookie')),
      member: async () => sourceMemberFor(await visitor()),
    },
  }
}

/**
 * The request one source is given.
 *
 * A source that is not per-visitor gets the address and empty cookies. A
 * per-visitor source also gets the cookies and `member`, which is always
 * present for it: the signed-in member, or `null` when nobody is signed in
 * or the render has no visitor (a preview). The one exception is a source
 * that may not know the member (a plugin without `members.read`): it gets
 * the cookies and no `member` field, and the member is not looked up.
 */
export async function sourceRequestFor(
  source: Pick<LoopEntitySource, 'perVisitor' | 'mayKnowMember'>,
  scope: LoopRequestScope,
): Promise<SourceRequestContext> {
  if (source.perVisitor !== true) return { ...scope.base, cookies: {} }
  const cookies = scope.visitor?.cookies ?? {}
  if (source.mayKnowMember && !source.mayKnowMember()) return { ...scope.base, cookies }
  return { ...scope.base, cookies, member: scope.visitor ? await scope.visitor.member() : null }
}

/**
 * Whether any list in the subtree under `rootNodeId` uses a per-visitor
 * source: the root itself, a list nested in another list's item, or a list
 * inside a Visual Component the subtree places. Such a fragment is rendered
 * for one visitor and must never be cached or shared.
 */
export function subtreeHasPerVisitorSource(page: Page, site: SiteDocument, rootNodeId: string): boolean {
  return collectLoopNodes(page, site, rootNodeId).some((node) => {
    const { sourceId } = readLoopProps(node)
    return sourceId !== '' && loopSourceRegistry.get(sourceId)?.perVisitor === true
  })
}
