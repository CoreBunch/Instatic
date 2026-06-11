import type { SiteDocument } from '@core/page-tree'

/**
 * Which parts of the site document actually changed since the last successful
 * save. Produced by the editor store's patch-derived dirty tracking and
 * consumed by `saveSite` to ship only the changed pages/components.
 *
 * `all: true` is the conservative sentinel — full save (used after imports,
 * fresh-site marks, or any mutation whose patches could not be attributed to
 * specific pages/components). Over-marking is always safe; under-marking
 * would lose edits, so anything ambiguous must mark all.
 */
export interface SaveDirtyHints {
  all: boolean
  pageIds: ReadonlySet<string>
  componentIds: ReadonlySet<string>
  layoutIds: ReadonlySet<string>
}

export interface SaveSiteOptions {
  /**
   * Optimistic-concurrency token: the page ids the client loaded. When
   * supplied, the server only soft-deletes pages the client knew about and
   * dropped — never a page another session created concurrently (ISS-041).
   * Omit it for an authoritative full replace (e.g. import).
   */
  baselinePageIds?: string[]
  /** Dirty hints from the editor store. Absent → full save. */
  dirty?: SaveDirtyHints
}

/**
 * IPersistenceAdapter — the interface the CMS draft storage backend satisfies.
 */
export interface IPersistenceAdapter {
  /**
   * Persist the single site draft document. The shell is always written;
   * pages and components ship incrementally per `opts.dirty` (the full id
   * rosters always accompany the changed payloads so server-side reaping
   * keeps full-replace semantics).
   */
  saveSite(site: SiteDocument, opts?: SaveSiteOptions): Promise<void>

  /**
   * Load the single site draft document (shell + pages assembled).
   * Returns undefined before setup creates it.
   */
  loadSite(id: string): Promise<SiteDocument | undefined>
}
