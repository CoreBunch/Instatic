/**
 * PageTemplateConfig — optional CMS template configuration on a Page.
 *
 * When present, the page is a template: it declares a `target` (everywhere, or
 * one/more post types) and matched content flows into its single `base.outlet`.
 * `priority` breaks ties when multiple templates compete at the same breadth
 * level. The resolver orders matching templates broadest → narrowest.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// TemplateTargetSchema
// ---------------------------------------------------------------------------

const TemplateTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal('everywhere') }),
  Type.Object({
    kind: Type.Literal('postTypes'),
    tableSlugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
  /**
   * The site's 404 page. Never matched by route resolution — the public
   * router renders it (wrapped in the `everywhere` layout chain) whenever a
   * GET falls through every other route. Baked to `404.html` at publish time.
   */
  Type.Object({ kind: Type.Literal('notFound') }),
])
export type TemplateTarget = Static<typeof TemplateTargetSchema>

// ---------------------------------------------------------------------------
// PageTemplateConfigSchema
// ---------------------------------------------------------------------------

export const PageTemplateConfigSchema = Type.Object({
  enabled: Type.Literal(true),
  target: TemplateTargetSchema,
  /**
   * Falls back to 0 when missing or not a finite number —
   * handled in parsePageTemplate.
   */
  priority: Type.Number(),
})
export type PageTemplateConfig = Static<typeof PageTemplateConfigSchema>

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

function parseTarget(raw: unknown): TemplateTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.kind === 'everywhere') return { kind: 'everywhere' }
  if (r.kind === 'notFound') return { kind: 'notFound' }
  if (r.kind === 'postTypes') {
    const slugs = Array.isArray(r.tableSlugs)
      ? r.tableSlugs.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : []
    return slugs.length > 0 ? { kind: 'postTypes', tableSlugs: slugs } : null
  }
  return null
}

/** Parse a PageTemplateConfig, providing a fallback for priority. */
export function parsePageTemplate(raw: unknown): PageTemplateConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.enabled !== true) return null
  const target = parseTarget(r.target)
  if (!target) return null
  const priority = typeof r.priority === 'number' && isFinite(r.priority) ? r.priority : 0
  return { enabled: true, target, priority }
}
