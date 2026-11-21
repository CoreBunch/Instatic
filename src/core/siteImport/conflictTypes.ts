/**
 * Conflict shapes of an `ImportPlan`: what collides with the site (or within
 * the import) and how the user chose to resolve it. Detected by
 * `conflicts.ts`, `classCascades.ts` and `mediaConflicts.ts`; resolved by
 * `applyConflictResolutions` and `commitImportPlan`.
 */

/** How a slug, rule-name, or token-variable conflict is resolved for a single item. */
export interface ConflictResolution {
  action: 'auto-rename' | 'overwrite' | 'skip' | 'custom-rename'
  /** Resolved slug (for page conflicts; defined when action !== 'skip'). */
  resolvedSlug?: string
  /** Resolved name (for rule conflicts; defined when action !== 'skip'). */
  resolvedName?: string
  /**
   * Resolved CSS custom-property name without leading `--` (for token conflicts;
   * a default overwrite can also carry the target of a later rename choice).
   */
  resolvedVariable?: string
}

/** A page slug that collides with an existing page. */
export interface PageConflict {
  /** FileMap key of the HTML source file. */
  source: string
  /** The slug the importer wanted to use. */
  desiredSlug: string
  /** ID of the existing page that owns the slug. */
  existingPageId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A `kind:'class'` rule name that collides with an existing class rule.
 *
 * Ambient rules NEVER conflict — multiple ambient rules with the same
 * selector are allowed; cascade resolves by `order`.
 */
export interface RuleConflict {
  /** FileMap key of the CSS source file (or empty if unknown). */
  source: string
  /** The class name the importer wanted to use. */
  desiredName: string
  /** ID of the existing StyleRule that owns the name. */
  existingRuleId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * One cross-sheet class conflict among CONVERTED stylesheets (see
 * `classCascades.ts`). `kind: 'leak'`: a sheet (`sources[0]`) styles a
 * class another imported page uses without loading it. `kind: 'divergent'`:
 * pages load the defining sheets in orders no global order satisfies; the
 * first definition keeps the bare name.
 *
 * Resolutions (applied by `applyCrossSheetClassResolutions`):
 * - `auto-rename` / `custom-rename` (default): leak — the sheet's fragments
 *   move to `resolvedName`, which its pages carry next to the bare class, so
 *   each page keeps its own cascade; divergent — this definition moves to
 *   `resolvedName` with its pages' class tokens.
 * - `skip`: drop the sheet's rules naming the class (leak) or this definition.
 * - `overwrite`: keep the sheet global (leak), or this definition wins the
 *   bare name (divergent).
 */
export interface CrossSheetClassConflict {
  kind: 'divergent' | 'leak'
  /** The colliding class name as authored in the source CSS. */
  desiredName: string
  /** Stable id of this row (hash of the definition, or of the leaking sheet). */
  definitionId: string
  /** CSS file paths whose class fragments this row moves. */
  sources: string[]
  /** HTML page sources rendered with this definition. */
  pageSources: string[]
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A design-token CSS custom property (`--bg`, `--font-body`) extracted from
 * the import that collides with an existing token in the site.
 *
 * Both colour tokens (keyed by `--<slug>`) and font tokens (keyed by
 * `--font-*`) are modelled here: they are the same thing — a `--var` contract
 * referenced by `var(--x)` in the imported CSS — and resolve through one UI.
 *
 * `auto-rename` / `custom-rename` rename the imported token AND rewrite every
 * `var(--old)` reference in the imported style rules and node inline styles to
 * the new name, so the imported design stays faithful. `skip` keeps the
 * existing token (imported `var(--x)` binds to it). `overwrite` replaces the
 * existing token's value, keeping its name so both sides keep resolving.
 */
export interface TokenConflict {
  /** Which registry the token lives in. */
  kind: 'color' | 'font'
  /**
   * The CSS custom-property name without the leading `--` the importer wanted
   * (e.g. `bg` for `--bg`, `font-body` for `--font-body`).
   */
  desiredVariable: string
  /** ID of the existing token (framework colour / font token) that owns the name. */
  existingTokenId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * An imported script or kept stylesheet whose site file path is already taken
 * by a file of the same kind, typically because this bundle was imported
 * before.
 *
 * Resolutions (applied by `commitImportPlan`):
 * - `skip` (default unless `state` is `changed`): keep the existing file and
 *   its content; the pages this import links it from join its page scope.
 * - `overwrite` (default when `state` is `changed`): replace the existing
 *   file in place (same id, path and load order; new content, a script's
 *   format and npm dependencies) and widen its page scope the same way.
 * - `auto-rename`: import a second copy under a free `-2` path, as a new file.
 */
export type FileConflictState = 'unchanged' | 'changed' | 'edited' | 'differs'

export interface FileConflict {
  kind: 'script' | 'style'
  /** The import path (`ImportScript.path` / `ImportStylesheet.path`). */
  path: string
  /** The site file path both sides resolve to. */
  sitePath: string
  /** Id of the existing `SiteFile`. */
  existingFileId: string
  /**
   * What changed since this file was imported, read from the file's
   * `importRecord`:
   * - `unchanged`: the bundle has the same text as the last import (or, with
   *   no record, the site copy equals it).
   * - `changed`: the bundle changed it and nobody edited the site copy.
   * - `edited`: the site copy was edited in Instatic since the import.
   * - `differs`: no record, and the site copy differs; who changed what is
   *   unknown, so the site copy is kept by default.
   */
  state: FileConflictState
  defaultResolution: ConflictResolution
}

/**
 * An imported media file whose bytes are already in the media library
 * (matched by content hash), typically because this bundle was imported
 * before. Detected by the wizard after the plan is built, since the lookup
 * needs the server (`detectMediaConflicts`).
 *
 * Resolutions (applied by `commitImportPlan`):
 * - `skip` (default): do not upload; every reference points at the existing
 *   asset's URL.
 * - `auto-rename`: upload it again as a separate asset.
 */
export interface MediaConflict {
  /** FileMap key of the imported file. */
  sourcePath: string
  existingAssetId: string
  /** Public URL of the existing asset, used in place of an upload. */
  existingUrl: string
  /** File name the existing asset was uploaded under. */
  existingFilename: string
  defaultResolution: ConflictResolution
}
