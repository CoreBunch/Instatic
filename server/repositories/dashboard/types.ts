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
