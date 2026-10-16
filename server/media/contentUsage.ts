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
 * Deliberately reads DRAFTS, not the published artefacts: an image placed on
 * an unpublished page is still in use, and a warning that only knew about live
 * pages would let a delete quietly break the next publish.
 *
 * And it reads EVERY branch. Media is shared across branches while pages are
 * not, so purging a file removes it from all of them at once — an image that
 * only a branch uses breaks that branch's preview now, and the live site the
 * moment the branch merges. Main is reported plainly; a branch is named only
 * where it adds something main does not already say, so a site with five
 * branches does not list the same page five times.
 *
 * The cost lands where it belongs. The walk is O(branches × site), and it runs
 * only when someone asks to permanently delete something — never on a page
 * load, never on a trash. For the site sizes this product is built for, that
 * is milliseconds on an action that is about to be irreversible. If a site ever
 * grows past that, the fix is to cache this — with the walk still the source
 * of truth, so the cache can be checked against it.
 */

// Registry population. The walk asks the registry which props are
// image/media-typed, so without the base modules registered it matches
// nothing and reports NO usage — a warning that is silently always empty,
// which is the one failure mode worse than not having it. Same import
// `pageDiff.ts` and the collab relay make, and for the same reason.
import '@modules/base'
import { MAIN_BRANCH_ID } from '@core/branches'
import { registry } from '@core/module-engine'
import type { SiteDocument } from '@core/page-tree'
import { collectSiteStyleBackgroundImagePaths } from '@core/publisher'
import { MAIN_SCOPE } from '../branches/scope'
import { placeholder, type DbClient } from '../db/client'
import { listBranches } from '../repositories/branches'
import type { MediaUsageRef } from '../repositories/media'
import { getDraftSiteDocument } from '../repositories/publish'
import { collectPageMediaPaths } from '../publish/mediaPrefetch'

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

/** One place a file is used, before it is decided which branch to name. */
interface Sighting {
  assetId: string
  refKind: string
  refId: string
  label: string
}

/**
 * Identity of a sighting, independent of branch. Page ids are LOGICAL on every
 * branch, so the same page on main and on a fork produces the same key.
 */
function sightingKey(sighting: Sighting): string {
  return JSON.stringify([sighting.assetId, sighting.refKind, sighting.refId])
}

/**
 * Everywhere one branch's draft uses one of the requested files.
 *
 * One sighting per (asset, page) — a file used by four nodes on one page is
 * one page to fix, and repeating its title four times would turn the warning
 * into the wall of text it exists to avoid.
 */
function sightingsInSite(
  site: SiteDocument,
  assetIdByPath: ReadonlyMap<string, string>,
): Sighting[] {
  const found = new Map<string, Sighting>()
  const add = (sighting: Sighting) => found.set(sightingKey(sighting), sighting)

  for (const page of site.pages) {
    // `collectPageMediaPaths` descends into the definition tree of every
    // Visual Component the page references, so an image inside a VC body is
    // attributed to the page that renders it — which is the page that would
    // break, and so the one worth naming.
    for (const path of collectPageMediaPaths(page, site, registry)) {
      const assetId = assetIdByPath.get(path)
      if (!assetId) continue
      add({ assetId, refKind: PAGE_CONTENT_REF_KIND, refId: page.id, label: page.title || page.slug })
    }
  }

  // Site-level style backgrounds belong to no single page — every page that
  // matches the rule renders them, so naming one page would be misleading.
  for (const path of collectSiteStyleBackgroundImagePaths(site)) {
    const assetId = assetIdByPath.get(path)
    if (!assetId) continue
    add({ assetId, refKind: SITE_STYLES_REF_KIND, refId: 'site', label: 'site styles' })
  }

  return [...found.values()]
}

/**
 * Which of `assetIds` the site's own content references, and where — across
 * every branch.
 */
export async function collectContentUsageRefs(
  db: DbClient,
  assetIds: string[],
): Promise<MediaUsageRef[]> {
  if (assetIds.length === 0) return []

  const assetIdByPath = await pathsForAssetIds(db, assetIds)
  if (assetIdByPath.size === 0) return []

  // Main first, read explicitly: everything a branch reports is measured
  // against it, so a branch that shares a use with main adds nothing.
  const mainSite = await getDraftSiteDocument(db, MAIN_SCOPE)
  const refs: MediaUsageRef[] = mainSite ? sightingsInSite(mainSite, assetIdByPath) : []
  const onMain = new Set(refs.map(sightingKey))

  for (const branch of await listBranches(db)) {
    if (branch.id === MAIN_BRANCH_ID) continue
    const site = await getDraftSiteDocument(db, { branchId: branch.id })
    if (!site) continue
    for (const sighting of sightingsInSite(site, assetIdByPath)) {
      if (onMain.has(sightingKey(sighting))) continue
      refs.push({ ...sighting, branchName: branch.name })
    }
  }

  return refs
}
