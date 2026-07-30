import type { SiteDocument } from '@core/page-tree'

/**
 * Which parts of the site document actually changed — and which rows were
 * deleted — since the last successful save. Produced by the editor store's
 * patch-derived dirty tracking and consumed by `saveSite` to ship an
 * incremental-mode save (changed rows + explicit deleted ids).
 *
 * `all: true` is the conservative sentinel — the save ships as a
 * replace-mode full save (used after imports, fresh-site marks, or any
 * mutation whose patches could not be attributed to specific rows).
 * Over-marking is always safe; under-marking would lose edits, so anything
 * ambiguous must mark all.
 */
interface SaveDirtyHints {
  all: boolean
  pageIds: ReadonlySet<string>
  componentIds: ReadonlySet<string>
  layoutIds: ReadonlySet<string>
  deletedPageIds: ReadonlySet<string>
  deletedComponentIds: ReadonlySet<string>
  deletedLayoutIds: ReadonlySet<string>
}

export interface SaveSiteOptions {
  /** Dirty hints from the editor store. Absent → replace-mode full save. */
  dirty?: SaveDirtyHints
  /**
   * Conflict-detection bases for an incremental save: rowId → the sync seq
   * the client last synchronized with (seeded at load, bumped on every
   * successful save). The adapter ships the subset covering the changed and
   * deleted rows; the server 409s the save when any stored row is newer.
   * Irrelevant for replace-mode saves (the server skips the check).
   */
  baseSeqs?: Readonly<Record<string, number>>
  /** The shell seq the client last synchronized with (same protocol as `baseSeqs`). */
  shellBaseSeq?: number
}

export interface SaveSiteResult {
  /**
   * The save's site-global sync seq — stamped on every row the save wrote or
   * deleted (and the shell, when it changed). The client bumps its base seqs
   * to this value on success.
   */
  seq: number
}

/** The loaded document plus the sync-seq bases the editor tracks alongside it. */
export interface SiteLoadResult {
  site: SiteDocument
  /** rowId → stored sync seq at load time, across pages + components + layouts. */
  rowSeqs: Record<string, number>
  /** The shell's sync seq at load time. */
  shellSeq: number
}

/**
 * IPersistenceAdapter — the interface the CMS draft storage backend satisfies.
 */
export interface IPersistenceAdapter {
  /**
   * Persist the single site draft document atomically (one request, one
   * server transaction). With `opts.dirty`, ships an incremental save:
   * only the changed pages/components/layouts plus explicitly deleted row
   * ids. Without hints (or `dirty.all`), ships a replace-mode full save —
   * the server derives deletions as stored − shipped.
   *
   * Throws `SaveConflictError` (see ./saveConflict) when the server rejects
   * an incremental save because another admin stored newer versions of rows
   * this save ships. Nothing is written on conflict.
   */
  saveSite(site: SiteDocument, opts?: SaveSiteOptions): Promise<SaveSiteResult>

  /**
   * Load the single site draft document (shell + pages assembled) together
   * with its sync-seq bases. Returns undefined before setup creates it.
   */
  loadSite(id: string): Promise<SiteLoadResult | undefined>
}
