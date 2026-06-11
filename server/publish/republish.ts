/**
 * Background republish primitives.
 *
 * Called from the plugin API surface `api.cms.pages.republish(pageId)` and
 * `api.cms.pages.republishAll()`. These drive the full publish pipeline
 * (publish.before → publish.html filter → publish.after) for already-
 * published pages, without writing a new snapshot. The side-effects — hook
 * listeners and filter handlers firing — are the whole point.
 *
 * Note on the synthetic URL: `renderPublishedSnapshot` accepts an optional
 * `url` on its context for per-loop pagination and `{route.*}` binding
 * resolution. For background republish (not driven by an inbound HTTP
 * request), we pass a synthetic localhost URL so the renderer has a valid
 * URL object to work with. The URL is not user-visible and its exact value
 * is irrelevant beyond being parseable.
 */

import type { DbClient } from '../db/client'
import { getPublishedPageSnapshotById } from '../repositories/publish'
import { renderPublishedSnapshot } from './publicRenderer'
import { applyPublishedHtmlPipeline } from './publishedHtmlPipeline'

// ---------------------------------------------------------------------------
// Typed error — callers can distinguish "page not found / not published" from
// transient failures.
// ---------------------------------------------------------------------------

class PageNotPublishedError extends Error {
  readonly pageId: string
  constructor(pageId: string) {
    super(`Page "${pageId}" is not currently published`)
    this.name = 'PageNotPublishedError'
    this.pageId = pageId
  }
}

// ---------------------------------------------------------------------------
// Republish helpers
// ---------------------------------------------------------------------------

/**
 * Re-run the full publish pipeline for a single page that is already in the
 * `published` state. Discards the rendered HTML — the sole purpose is to
 * fire plugin hook listeners and filters so their side-effects are applied to
 * a page that was published before the plugin was activated.
 *
 * Throws `PageNotPublishedError` if the page is not found or is not
 * currently published.
 */
async function republishSinglePage(db: DbClient, pageId: string): Promise<void> {
  // Typed read through the publish repository — the snapshot column is parsed
  // by the DbClient (`*_json` auto-parse) and typed as `PublishedPageSnapshot`,
  // so there is no boundary cast here.
  const snapshot = await getPublishedPageSnapshotById(db, pageId)
  if (!snapshot) {
    throw new PageNotPublishedError(pageId)
  }

  // Synthetic URL for background republish. The URL object is used by
  // renderPublishedSnapshot for pagination helpers and {route.*} bindings.
  // Its exact value is irrelevant for background re-renders.
  const syntheticUrl = new URL('http://localhost/__republish')

  // Drive the full pipeline (publish.before → frontend.assets injection →
  // publish.html filter → publish.after). The returned HTML is discarded —
  // the side-effects are what the caller actually needs (lets plugins
  // catch up on pages published before they were activated).
  const rendered = await renderPublishedSnapshot(snapshot, { db, url: syntheticUrl })
  await applyPublishedHtmlPipeline(rendered, db)
}

/**
 * Republish every currently-published page. Iterates all published pages and
 * calls `republishSinglePage` for each. Returns the total count published.
 *
 * Errors for individual pages are logged and do not abort the batch — the
 * count reflects pages that completed without error.
 */
export async function republishAllPages(db: DbClient): Promise<number> {
  const { rows } = await db<{ id: string }>`
    select id
    from data_rows
    where table_id = 'pages'
      and status = 'published'
      and deleted_at is null
    order by created_at asc
  `
  const results = await Promise.allSettled(rows.map(row => republishSinglePage(db, row.id)))
  let count = 0
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      count++
    } else {
      console.error(`[publish:republish] republishSinglePage("${rows[i].id}") threw:`, result.reason)
    }
  }
  return count
}
