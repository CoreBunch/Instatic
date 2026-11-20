/**
 * pageSlug — the route an imported HTML file is served at. Shared by the page
 * plan (`htmlPagePlan.ts`) and the head URL normaliser (`headSeo.ts`), which
 * points a head link naming another imported file at that page's route.
 */
import { normalizePageSlug } from '@core/page-tree'

/**
 * Derive a URL-safe slug from an HTML file path.
 *
 * Rules:
 *   - Strip the extension from the HTML file path.
 *   - Preserve safe nested path segments (`docs/api.html` → `docs/api`).
 *   - Treat nested `index.html` as the directory route
 *     (`docs/index.html` → `docs`), while root `index.html` stays `index`.
 *   - Lowercase and sanitise each segment with page-slug rules.
 *   - If the result is empty, fall back to `'page'`.
 */
export function deriveSlug(htmlPath: string): string {
  const pathWithoutExtension = htmlPath
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.[^/.]+$/, '')
  const rawSegments = pathWithoutExtension.split('/').filter(Boolean)
  const lastIndex = rawSegments.length - 1
  const slugSegments = rawSegments.flatMap((segment, index) => {
    const normalized = normalizePageSlug(segment)
    if (normalized) return [normalized]
    return index === lastIndex ? ['page'] : []
  })

  if (slugSegments.length > 1 && slugSegments[slugSegments.length - 1] === 'index') {
    slugSegments.pop()
  }

  return slugSegments.join('/') || 'page'
}
