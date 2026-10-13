import type {
  FragmentInsertPlacement,
  FragmentInsertReport,
  FragmentMedia,
} from '@core/fragments'

export type { FragmentInsertPlacement, FragmentInsertReport, FragmentMedia }

// ---------------------------------------------------------------------------
// api.editor.fragments: insert a site fragment into the open document
// ---------------------------------------------------------------------------

/** One step of an insert's server work, for a progress line. */
export interface FragmentInsertProgress {
  phase: 'media' | 'fonts' | 'tables' | 'commit'
  done: number
  total: number
  label?: string
}

export interface FragmentInsertInput {
  /** A fragment object (`fragment.json`, parsed). Checked with `parseSiteFragment`. */
  fragment: unknown
  /**
   * The bytes of one media item the insert adds. Only called for media the
   * plan adds that the media library does not already hold. Return null when
   * the bytes are unavailable; the insert then stops before touching the
   * document.
   */
  readMediaBytes: (media: FragmentMedia) => Uint8Array | null | Promise<Uint8Array | null>
  /** Where a section or component lands. Default `after-selection`. */
  placement?: FragmentInsertPlacement
  /** See `FragmentPlanInput.colorSources`. */
  colorSources?: Record<string, string>
  /** Aborts at the next step boundary; never after the store write started. */
  signal?: AbortSignal
  onProgress?: (progress: FragmentInsertProgress) => void
  /** Skip the editor's result toast (the plugin shows its own). */
  silent?: boolean
}

/**
 * Why an insert did not happen:
 * - `unavailable`: no site editor document is open;
 * - `plan`: the fragment cannot go into this document (a second outlet, a
 *   component cycle) or the site's tables could not be read;
 * - `media` / `tables`: a server write failed; the document is untouched;
 * - `commit`: the editor could not place it (the document changed, or the
 *   edit was refused);
 * - `cancelled`: `signal` aborted, or the user closed the password prompt.
 */
export type FragmentInsertFailureStage = 'unavailable' | 'plan' | 'media' | 'tables' | 'commit' | 'cancelled'

export type FragmentInsertOutcome =
  | { ok: true; report: FragmentInsertReport; insertedRootIds: string[]; pageId?: string }
  | { ok: false; stage: FragmentInsertFailureStage; message: string }

export interface FragmentPlanInput {
  fragment: unknown
  /**
   * Fill a colour the fragment adds from one of the site's own colours:
   * `{ 'bg-alt': 'bg-surface' }` gives the new `bg-alt` token the site's
   * `bg-surface` values. Same option on `insert`.
   */
  colorSources?: Record<string, string>
}

export type FragmentPlanOutcome =
  | { ok: true; report: FragmentInsertReport }
  | { ok: false; message: string }

export interface EditorFragmentsApi {
  /**
   * Insert a fragment into the open document with the same engine as the
   * Insert fragment dialog: the site's own classes, components, tokens and
   * tables win, the whole insert is one undo step, and the inserted root is
   * selected. Resolves with an outcome; rejects only for a malformed `input`
   * (including a fragment `parseSiteFragment` refuses).
   */
  insert: (input: FragmentInsertInput) => Promise<FragmentInsertOutcome>
  /** Dry run against the open document: what an insert would add. Never changes anything. */
  plan: (input: FragmentPlanInput) => Promise<FragmentPlanOutcome>
}
