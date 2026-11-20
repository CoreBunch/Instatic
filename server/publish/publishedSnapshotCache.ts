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
 * This module owns ONE snapshot memo plus the derived per-version site +
 * fingerprint the fragment endpoints read, all built on
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
import type { SiteDocument } from '@core/page-tree'
import type { PublishedPageSnapshot } from '../repositories/publish'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { createVersionedSingleFlight } from './publishState'
import { contentHash } from '../branches/contentHash'

// ---------------------------------------------------------------------------
// Latest snapshot
// ---------------------------------------------------------------------------

// Published documents are immutable. Cache the fingerprint by object identity
// so a full-site bake hashes the document once, not once per rendered page.
const snapshotHashes = new WeakMap<SiteDocument, string>()

/** Stable across cache invalidations and process restarts; changes with the frozen site. */
export function getPublishedSnapshotHash(site: SiteDocument): string {
  let hash = snapshotHashes.get(site)
  if (hash === undefined) {
    hash = contentHash(site)
    snapshotHashes.set(site, hash)
  }
  return hash
}

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
// Published site + fingerprint (Layer C holes, infinite-loop load-more)
// ---------------------------------------------------------------------------

interface PublishedSite {
  site: SiteDocument
  snapshotHash: string
}

const siteMemo = createVersionedSingleFlight<PublishedSite>()

/**
 * The published site and its fingerprint for `version`. The fragment
 * endpoints resolve the caller's page URL against it (`composedRouteForPath`)
 * to find a node under the id the page was served with.
 */
export function getPublishedSiteForVersion(
  db: DbClient,
  version: number,
): Promise<PublishedSite | null> {
  return siteMemo.get(version, async () => {
    const snapshot = await getLatestSnapshotForVersion(db, version)
    if (!snapshot) return null
    return { site: snapshot.site, snapshotHash: getPublishedSnapshotHash(snapshot.site) }
  })
}
