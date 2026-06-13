/**
 * Version-keyed caches over the latest published site snapshot.
 *
 * The published snapshot (the entire SiteDocument) changes only when the
 * publish version moves, yet three request-time consumers used to load and
 * JSON-parse it from the DB per request — the per-request cost flagged in the
 * architecture review:
 *
 *   - the public router's row-route resolution (`publicRouter.ts`)
 *   - the Layer C hole endpoint (`handlers/cms/hole.ts`)
 *   - the infinite-loop load-more endpoint (`handlers/cms/loop.ts`)
 *
 * This module owns ONE snapshot memo plus the two derived per-version indexes
 * (nodeId → page for holes, loopId → page+node for loops), all built on
 * `createVersionedSingleFlight` from `publishState.ts`: one concurrent loader
 * per version, cached until the version changes, reset together with the rest
 * of the publish state in tests. A publish bump simply makes the next read
 * miss and reload against the fresh snapshot.
 *
 * The publish-time bake may pass `nextPublishVersion` (the version that
 * becomes current the instant `bumpPublishVersion()` runs after the slot
 * swap) — that pre-warms the memo for the version visitors are about to hit.
 */

import type { DbClient } from '../db/client'
import type { Page, PageNode, SiteDocument } from '@core/page-tree'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { collectLoopNodes } from './loopPrefetch'
import { createVersionedSingleFlight } from './publishState'

// ---------------------------------------------------------------------------
// Latest snapshot
// ---------------------------------------------------------------------------

const snapshotMemo = createVersionedSingleFlight<PublishedPageSnapshot>()

/**
 * The latest published site snapshot for `version`. Loads (and JSON-parses)
 * it from the DB once per publish version; warm calls do zero I/O.
 */
export function getLatestSnapshotForVersion(
  db: DbClient,
  version: number,
): Promise<PublishedPageSnapshot | null> {
  return snapshotMemo.get(version, () => getLatestPublishedSiteSnapshot(db))
}

// ---------------------------------------------------------------------------
// nodeId → page index (Layer C holes)
// ---------------------------------------------------------------------------

interface PublishedNodeIndex {
  site: SiteDocument
  /** First page wins on the (extremely unlikely) duplicate node id. */
  nodeIndex: Map<string, Page>
}

const nodeIndexMemo = createVersionedSingleFlight<PublishedNodeIndex>()

/**
 * The published site plus a `nodeId → page` index for `version`, so the hole
 * endpoint locates a fragment's page in O(1) instead of scanning all pages.
 */
export function getPublishedNodeIndexForVersion(
  db: DbClient,
  version: number,
): Promise<PublishedNodeIndex | null> {
  return nodeIndexMemo.get(version, async () => {
    const snapshot = await getLatestSnapshotForVersion(db, version)
    if (!snapshot) return null
    const nodeIndex = new Map<string, Page>()
    for (const page of snapshot.site.pages) {
      for (const nodeId of Object.keys(page.nodes)) {
        if (!nodeIndex.has(nodeId)) nodeIndex.set(nodeId, page)
      }
    }
    return { site: snapshot.site, nodeIndex }
  })
}

// ---------------------------------------------------------------------------
// loopId → page + node index (infinite-loop load-more)
// ---------------------------------------------------------------------------

interface PublishedLoopIndex {
  site: SiteDocument
  /** First page wins on a duplicate loop id, matching the old scan order. */
  loops: Map<string, { page: Page; node: PageNode }>
}

const loopIndexMemo = createVersionedSingleFlight<PublishedLoopIndex>()

/**
 * The published site plus a `loopId → { page, node }` index for `version`.
 * Built once per publish version by walking each page's render tree (the same
 * `collectLoopNodes` walk the loop endpoint used to repeat per request).
 */
export function getPublishedLoopIndexForVersion(
  db: DbClient,
  version: number,
): Promise<PublishedLoopIndex | null> {
  return loopIndexMemo.get(version, async () => {
    const snapshot = await getLatestSnapshotForVersion(db, version)
    if (!snapshot) return null
    const loops = new Map<string, { page: Page; node: PageNode }>()
    for (const page of snapshot.site.pages) {
      for (const node of collectLoopNodes(page, snapshot.site)) {
        if (!loops.has(node.id)) loops.set(node.id, { page, node })
      }
    }
    return { site: snapshot.site, loops }
  })
}
