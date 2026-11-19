// ---------------------------------------------------------------------------
// Loop entity source — registered via api.cms.loops.registerSource
// ---------------------------------------------------------------------------

// Forward-declared opaque type — full shape lives in `@core/loops/types`.
// We keep it opaque on the SDK boundary so plugin authors aren't pulled
// into the loops module dependency graph until they need it.
export type LoopEntitySource = {
  id: string
  label: string
  description?: string
  filterSchema: Record<string, unknown>
  orderByOptions: Array<{ id: string; label: string }>
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
  fetch: (ctx: unknown) => Promise<{ items: unknown[]; totalItems: number }>
  preview: (ctx: unknown) => unknown[]
}
