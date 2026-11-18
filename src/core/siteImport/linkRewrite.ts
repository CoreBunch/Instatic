/**
 * rewriteInternalLinks — turn intra-site `<a href>` links into dynamic page
 * references during Super Import.
 *
 * A multi-page export links its pages to each other by source file
 * (`<a href="club.html">`). Those filenames are NOT the CMS routes (the page
 * lands at `/club`), so the raw href would 404. Worse, hard-coding the slug
 * would break the moment the user renames the page.
 *
 * This pass rewrites every imported `href` that resolves to another imported
 * page's source file into a `cms:page:<pageId>` reference. The publisher then
 * resolves that ref to the page's CURRENT path at publish time, so links keep
 * working across slug renames.
 *
 * Fragments are preserved (`club.html#features` → `cms:page:<id>#features`).
 * Same-page anchors (`#features`), external URLs, `mailto:`/`tel:`, and links
 * to non-imported files are left untouched.
 */

import { makePageRef } from '@core/page-tree'
import type { PageNode } from '@core/page-tree'
import type { PagePlan } from './types'
import { resolveHref } from './htmlPagePlan'

/**
 * Rewrite internal links across all imported pages.
 *
 * @param pages           Imported page plans (node fragments still hold raw hrefs).
 * @param pageIdBySource  Map from each imported page's source FileMap key
 *                        (e.g. `"club.html"`) to its committed page id.
 */
export function rewriteInternalLinks(
  pages: PagePlan[],
  pageIdBySource: ReadonlyMap<string, string>,
): PagePlan[] {
  if (pageIdBySource.size === 0) return pages

  return pages.map((plan) => {
    let touched = false
    const nodes: Record<string, PageNode> = {}

    for (const [id, node] of Object.entries(plan.nodeFragment.nodes)) {
      const href = node.props?.href
      const ref =
        typeof href === 'string' ? hrefToPageRef(href, plan.source, pageIdBySource) : null
      if (ref === null) {
        nodes[id] = node
        continue
      }
      touched = true
      nodes[id] = { ...node, props: { ...node.props, href: ref } }
    }

    if (!touched) return plan
    return { ...plan, nodeFragment: { ...plan.nodeFragment, nodes } }
  })
}

/**
 * Resolve a single href to a `cms:page:<id>` reference, or null when it isn't
 * an internal link to an imported page.
 */
function hrefToPageRef(
  href: string,
  source: string,
  pageIdBySource: ReadonlyMap<string, string>,
): string | null {
  if (!href) return null

  // Split off the fragment, which is KEPT and re-attached to the page ref below.
  // Any query string is dropped by `resolveHref` — CMS routes are slugs.
  const hashIdx = href.indexOf('#')
  const fragment = hashIdx >= 0 ? href.slice(hashIdx) : ''
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href

  // Pure same-page anchor (`#features`) or empty → not an internal page link.
  if (!pathPart) return null

  // resolveHref returns null for external / absolute-scheme / fragment hrefs,
  // and otherwise a normalized FileMap key relative to the source page.
  const resolved = resolveHref(pathPart, source)
  if (!resolved) return null

  const targetId = pageIdBySource.get(resolved)
  if (!targetId) return null

  return makePageRef(targetId, fragment)
}
