/**
 * Which pages use these files — worked out from the site itself, not from a
 * stored index.
 *
 * The counterpart to `media_usage_refs`, and the split between them is the
 * point: a stored reference suits a SETTING, which has one writer and an
 * explicit set/unset — an avatar, a favicon, a logo. Page content has
 * neither. It is written continuously by the collab relay, and removing an
 * image produces no event at all, so a table would fill with references to
 * nodes that no longer exist and the warning would start being wrong.
 *
 * A wrong warning is worse than none: an operator who is misled once stops
 * reading it. So this computes the answer at the moment it is asked, from
 * `getDraftSiteDocument` — which cannot drift, because there is nothing to
 * keep in sync.
 *
 * The cost lands where it belongs. Walking every page tree is O(site), and it
 * happens only when someone asks to permanently delete something — never on a
 * page load, never on a trash. For the site sizes this product is built for,
 * that is a few milliseconds on an action that is about to be irreversible.
 * If a site ever grows past that, the fix is to cache this — with the walk
 * still the source of truth, so the cache can be checked against it.
 *
 * Deliberately reads the DRAFT document, not the published artefacts: an
 * image placed on an unpublished page is still in use, and a warning that
 * only knew about live pages would let a delete quietly break the next
 * publish.
 */

// Registry population. The walk asks the registry which props are
// image/media-typed, so without the base modules registered it matches
// nothing and reports NO usage — a warning that is silently always empty,
// which is the one failure mode worse than not having it. Same import
// `pageDiff.ts` and the collab relay make, and for the same reason.
import '@modules/base'
import { registry } from '@core/module-engine'
import { collectSiteStyleBackgroundImagePaths } from '@core/publisher'
import { placeholder, type DbClient } from '../db/client'
import { getDraftSiteDocument } from '../repositories/publish'
import { collectPageMediaPaths } from '../publish/mediaPrefetch'
import type { MediaUsageRef } from '../repositories/media'

/**
 * `ref_kind` values this module produces. They share the namespace with the
 * stored kinds (`user.avatar`), so a caller merges the two lists without
 * caring which side each one came from.
 */
export const PAGE_CONTENT_REF_KIND = 'page.content'
export const SITE_STYLES_REF_KIND = 'site.styles'

/**
 * Map the requested asset ids to the `public_path` each one is stored under.
 *
 * Content props hold the path, not the id — and `replaceMediaAssetBinary`
 * keeps the path stable across a file swap precisely so page references
 * survive it. The path is therefore the join key, and this is the one query
 * that translates.
 */
async function pathsForAssetIds(
  db: DbClient,
  assetIds: string[],
): Promise<Map<string, string>> {
  const placeholders = assetIds.map((_, i) => placeholder(db.dialect, i + 1)).join(', ')
  const { rows } = await db.unsafe<{ id: string; public_path: string }>(
    `select id, public_path from media_assets where id in (${placeholders})`,
    assetIds,
  )
  const byPath = new Map<string, string>()
  for (const row of rows) byPath.set(row.public_path, row.id)
  return byPath
}

/**
 * Which of `assetIds` the site's own content references, and where.
 *
 * One ref per (asset, page) — a file used by four nodes on one page is one
 * page to fix, and repeating its title four times would turn the warning into
 * the wall of text it exists to avoid.
 */
export async function collectContentUsageRefs(
  db: DbClient,
  assetIds: string[],
): Promise<MediaUsageRef[]> {
  if (assetIds.length === 0) return []

  const assetIdByPath = await pathsForAssetIds(db, assetIds)
  if (assetIdByPath.size === 0) return []

  const site = await getDraftSiteDocument(db)
  if (!site) return []

  const refs: MediaUsageRef[] = []

  for (const page of site.pages) {
    // `collectPageMediaPaths` descends into the definition tree of every
    // Visual Component the page references, so an image inside a VC body is
    // attributed to the page that renders it — which is the page that would
    // break, and so the one worth naming.
    const used = collectPageMediaPaths(page, site, registry)
    for (const path of used) {
      const assetId = assetIdByPath.get(path)
      if (!assetId) continue
      refs.push({
        assetId,
        refKind: PAGE_CONTENT_REF_KIND,
        refId: page.id,
        label: page.title || page.slug,
      })
    }
  }

  // Site-level style backgrounds belong to no single page — every page that
  // matches the rule renders them, so naming one page would be misleading.
  for (const path of collectSiteStyleBackgroundImagePaths(site)) {
    const assetId = assetIdByPath.get(path)
    if (!assetId) continue
    refs.push({
      assetId,
      refKind: SITE_STYLES_REF_KIND,
      refId: 'site',
      label: 'site styles',
    })
  }

  return refs
}
