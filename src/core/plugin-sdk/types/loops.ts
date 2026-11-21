// ---------------------------------------------------------------------------
// Loop entity source — registered via api.cms.loops.registerSource
// ---------------------------------------------------------------------------

import type { ServerPluginMember } from './routes'

/** One item of a list: a stable id and the values of the source's declared fields. */
export interface LoopSourceItem {
  id: string
  fields: Record<string, unknown>
}

/** What `fetch()` is handed for one list on one render. */
export interface LoopSourceFetchContext {
  /** The loop's filter values, keyed as in the source's `filterSchema`. */
  filters: Record<string, unknown>
  /** One of the source's `orderByOptions[].id` values, or `''`. */
  orderBy: string
  /**
   * The loop's direction: the author's pick, or the source's
   * `defaultDirection` when they never picked one. What each direction
   * means is the source's to decide; a source with no `defaultDirection`
   * should list its natural order for `'asc'`.
   */
  direction: 'asc' | 'desc'
  limit: number
  offset: number
  /**
   * The page request, for a `requestDependent` / `perVisitor` source rendered
   * at request time. `undefined` at publish time.
   */
  request?: {
    query: Record<string, string>
    path: string
    slug: string | null
    /** Empty unless the source is `perVisitor`; session cookies are removed. */
    cookies: Record<string, string>
    /**
     * `perVisitor` sources of a plugin holding `members.read` only: the
     * signed-in member, or `null` when nobody is signed in.
     */
    member?: ServerPluginMember | null
  }
  site: { id?: string; name?: string }
}

/**
 * What `preview()` is handed. There is no request, visitor or member here:
 * a preview is drawn for whoever is editing the page, not for a visitor.
 */
export interface LoopSourcePreviewContext {
  /** The loop's filter values, keyed as in the source's `filterSchema`. */
  filters: Record<string, unknown>
  /** How many sample items the canvas can use (at most 12). */
  limit: number
}

export type LoopEntitySource = {
  id: string
  label: string
  description?: string
  filterSchema: Record<string, unknown>
  orderByOptions: Array<{ id: string; label: string }>
  /**
   * Direction a new loop uses until its author picks one. Unset means
   * `'asc'`. Declare the direction under which `fetch()` lists your items
   * in their natural order, e.g. `'desc'` for a newest-first listing.
   */
  defaultDirection?: 'asc' | 'desc'
  fields: Array<{ id: string; label: string; description?: string; format?: 'plain' | 'html' | 'url' | 'media' }>
  /**
   * Mark the source request-dependent so a `base.loop` using it renders at
   * request time as a Layer C dynamic island (hole), cached per publish
   * version + query. Set for sources that hit live external APIs.
   */
  requestDependent?: boolean
  /**
   * Mark the source per-visitor: the hole bypasses the cache, runs `fetch()`
   * on every page load, and receives request cookies. Implies
   * `requestDependent`. Use for cookie/randomised/wall-clock content.
   *
   * A per-visitor source of a plugin that holds `members.read` also gets
   * `ctx.request.member`: the signed-in site member (`ServerPluginMember`),
   * or `null` for a signed-out visitor. No other source is told.
   */
  perVisitor?: boolean
  /** Runs in the sandbox for every publish or request-time render of a list. */
  fetch: (ctx: LoopSourceFetchContext) => Promise<{ items: LoopSourceItem[]; totalItems: number }>
  /**
   * Sample items for the editor canvas. Synchronous, and sample data by
   * contract: return invented items that show every field, never real
   * records. Anyone who can open the editor sees the result, including
   * people who may not see the plugin's data, and for a `perVisitor` source
   * there is no visitor to answer for. Without a `preview` the canvas says
   * the list has no sample items.
   */
  preview?: (ctx: LoopSourcePreviewContext) => LoopSourceItem[]
}
