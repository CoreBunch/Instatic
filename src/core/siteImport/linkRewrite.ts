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
 * The page's head settings get the same pass: a canonical, `og:url` or
 * `<link>` href naming another imported page (an hreflang alternate) becomes
 * a page reference too, which the publisher's head emitter resolves the same
 * way.
 *
 * Fragments are preserved (`club.html#features` → `cms:page:<id>#features`).
 * Same-page anchors (`#features`), external URLs, `mailto:`/`tel:`, and links
 * to non-imported files are left untouched.
 */

import { makePageRef } from '@core/page-tree'
import type { PageNode, PageSeo } from '@core/page-tree'
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

    const seo = rewriteHeadLinks(plan.seo, plan.source, pageIdBySource)
    if (!touched && seo === plan.seo) return plan
    return { ...plan, seo, ...(touched ? { nodeFragment: { ...plan.nodeFragment, nodes } } : {}) }
  })
}

/** The head settings with every URL that names an imported page turned into its page reference. */
function rewriteHeadLinks(
  seo: PageSeo | null,
  source: string,
  pageIdBySource: ReadonlyMap<string, string>,
): PageSeo | null {
  if (!seo) return seo
  let touched = false
  const ref = (href: string) => {
    const pageRef = hrefToPageRef(href, source, pageIdBySource, true)
    if (pageRef === null) return href
    touched = true
    return pageRef
  }
  const next: PageSeo = {
    ...seo,
    ...(seo.canonical ? { canonical: ref(seo.canonical) } : {}),
    ...(seo.openGraph?.url ? { openGraph: { ...seo.openGraph, url: ref(seo.openGraph.url) } } : {}),
    ...(seo.links ? { links: seo.links.map((link) => ({ ...link, href: ref(link.href) })) } : {}),
  }
  return touched ? next : seo
}

/**
 * Resolve a single href to a `cms:page:<id>` reference, or null when it isn't
 * an internal link to an imported page.
 */
function hrefToPageRef(
  href: string,
  source: string,
  pageIdBySource: ReadonlyMap<string, string>,
  preserveQuery = false,
): string | null {
  if (!href) return null

  // Body links use slug routes. Head URLs can identify a particular edition
  // or paginated result, so retain their query along with the fragment.
  const suffixStart = preserveQuery ? href.search(/[?#]/) : href.indexOf('#')
  const suffix = suffixStart >= 0 ? href.slice(suffixStart) : ''
  const pathPart = suffixStart >= 0 ? href.slice(0, suffixStart) : href
  if (!pathPart) return null

  // resolveHref returns null for external / absolute-scheme / fragment hrefs,
  // and otherwise a normalized FileMap key relative to the source page.
  const resolved = resolveHref(pathPart, source)
  if (!resolved) return null

  const targetId = pageIdBySource.get(resolved)
  if (!targetId) return null

  return makePageRef(targetId, suffix)
}
