import type {
  FragmentInsertPlacement,
  FragmentInsertReport,
  FragmentMedia,
  ThemeApplyReport,
} from '@core/fragments'

export type { FragmentInsertPlacement, FragmentInsertReport, FragmentMedia, ThemeApplyReport }

// ---------------------------------------------------------------------------
// api.editor.fragments: insert a site fragment into the open document
// ---------------------------------------------------------------------------

/** One step of an insert's (or a theme's) server work, for a progress line. */
export interface FragmentInsertProgress {
  phase: 'media' | 'fonts' | 'tables' | 'commit'
  done: number
  total: number
  label?: string
}

export interface FragmentInsertInput {
  /** Place the layout first, then import assets while editing, or skip asset imports. */
  assets?: 'background' | 'layout-only'
  /** A fragment object (`fragment.json`, parsed). Checked with `parseSiteFragment`. */
  fragment: unknown
  /**
   * The bytes of one media item the insert adds. Only called for media the
   * plan adds that the media library does not already hold. Return null when
   * the bytes are unavailable. A blocking insert stops before touching the
   * document. A background import keeps the layout and reports the missing file.
   */
  readMediaBytes: (media: FragmentMedia) => Uint8Array | null | Promise<Uint8Array | null>
  /** Where a section or component lands. Default `after-selection`. */
  placement?: FragmentInsertPlacement
  /** See `FragmentPlanInput.colorSources`. */
  colorSources?: Record<string, string>
  /** Aborts at the next step boundary; never after the store write started. */
  signal?: AbortSignal
  /** Background asset progress can arrive after the layout insertion resolves. */
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

/** Saved destination styles available before a fragment has been inserted. */
export interface FragmentPreviewStyles {
  /** Publisher reset, fonts, framework tokens, and the site's shared style rules. */
  css: string
  /** Exact selectors and bindings an insert can reuse, even if the site doesn’t use them yet. */
  rules: ReadonlyArray<{ kind: 'class' | 'ambient'; name: string; selector: string }>
}

export type FragmentPreviewStylesListener = (styles: FragmentPreviewStyles | null) => void

// ---------------------------------------------------------------------------
// api.editor.fragments: apply a site theme (design variables, no content)
// ---------------------------------------------------------------------------

export interface ThemePlanInput {
  /** A theme object (`theme.json`, parsed). Checked with `parseSiteTheme`. */
  theme: unknown
}

export interface ThemeApplyInput extends ThemePlanInput {
  /**
   * The bytes of one media item the theme needs (a custom font file the site
   * lacks). Only called for media the media library does not already hold.
   * Return null when the bytes are unavailable; the theme then stops before
   * touching the site.
   */
  readMediaBytes: (media: FragmentMedia) => Uint8Array | null | Promise<Uint8Array | null>
  /** Aborts at the next step boundary; never after the store write started. */
  signal?: AbortSignal
  /** Phases `media`, `fonts`, `commit`. */
  onProgress?: (progress: FragmentInsertProgress) => void
  /** Skip the editor's result toast (the plugin shows its own). */
  silent?: boolean
}

/**
 * Why a theme was not applied:
 * - `unavailable`: the site editor is not open;
 * - `plan`: the theme could not be planned against the site;
 * - `media`: an upload failed; the site is untouched;
 * - `commit`: the editor refused the write;
 * - `cancelled`: `signal` aborted, or the user closed the password prompt.
 */
export type ThemeApplyFailureStage = 'unavailable' | 'plan' | 'media' | 'commit' | 'cancelled'

export type ThemeApplyOutcome =
  | { ok: true; report: ThemeApplyReport }
  | { ok: false; stage: ThemeApplyFailureStage; message: string }

export type ThemePlanOutcome =
  | { ok: true; report: ThemeApplyReport }
  | { ok: false; message: string }

export interface FragmentCanvasDrop {
  preview: { left: number; top: number; width: number; height: number; position: 'before' | 'after' | 'inside' }
  /** Uses the document and position captured at hit testing. */
  insert: (input: FragmentInsertInput) => Promise<FragmentInsertOutcome>
}

export interface EditorFragmentsApi {
  /** Hit test an editor viewport point using the canvas insertion rules. */
  canvasDropAt: (clientX: number, clientY: number) => FragmentCanvasDrop | null
  /**
   * Observe the destination's saved styles for a preview. Emits null when the
   * site editor is unavailable. Call the returned function to unsubscribe.
   */
  watchPreviewStyles: (onChange: FragmentPreviewStylesListener) => () => void
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
  /**
   * Apply a theme to the site: unlike an insert, the theme's colours, font
   * tokens, scale groups and root custom properties REPLACE the site's
   * values (missing ones are added). Nodes, classes, pages, components and
   * tables are never touched. One undo step reverts it. Resolves with an
   * outcome; rejects only for a malformed `input` (including a theme
   * `parseSiteTheme` refuses).
   */
  applyTheme: (input: ThemeApplyInput) => Promise<ThemeApplyOutcome>
  /** Dry run: what applying the theme would change, with before → after values. Never changes anything. */
  planTheme: (input: ThemePlanInput) => Promise<ThemePlanOutcome>
}
