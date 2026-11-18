/** Authorized content statistics returned by the dashboard repository. */
// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface PagesStats {
  total: number
  published: number
  drafts: number
  scheduled: number
  /**
   * How many pages were published in the trailing 7 days. Used by the
   * Pages widget's "+N this week" delta line.
   */
  deltaPublishedThisWeek: number
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export interface PostsStats {
  total: number
  /** Number of `kind: 'postType'` tables. */
  categories: number
  scheduled: number
  /**
   * Daily count of post publishes for the last 28 days, oldest first.
   * Drives the Posts widget's mini bar chart.
   */
  daily28: number[]
}

// ---------------------------------------------------------------------------
// Publish lineup
// ---------------------------------------------------------------------------

/**
 * A single row in the "Publish lineup" widget. Surfaces what's coming
 * up (scheduled), what just shipped (published), and the drafts the
 * operator is still working on.
 *
 *   • `path` — public route ("/blog/sandbox-deep-dive") derived from
 *     the row's table.route_base + row.slug. Falls back to
 *     `/${tableId}/${slug}` when route_base is missing.
 *
 *   • `at` — ISO datetime relevant to the status:
 *       - 'scheduled' → scheduled_publish_at (future)
 *       - 'published' → published_at (past)
 *       - 'draft'     → null
 *
 *   The widget formats this client-side relative to "now" so the labels
 *   say "in 12m" / "2h ago" without the server having to know the
 *   user's clock.
 */
export interface PublishLineupRow {
  id: string
  path: string
  status: 'scheduled' | 'published' | 'draft'
  at: string | null
}

export interface PublishLineupStats {
  rows: PublishLineupRow[]
}

