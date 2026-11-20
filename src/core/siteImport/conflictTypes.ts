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
   * defined when action is `auto-rename` or `custom-rename`).
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
 * One divergent cross-sheet definition of a class name among CONVERTED
 * stylesheets: two page cascades define the same class with different
 * effective declarations. The first-encountered definition keeps the bare
 * name; each later distinct definition raises one conflict.
 *
 * Resolutions (applied by `applyCrossSheetClassResolutions`):
 * - `auto-rename` / `custom-rename` (default): this definition moves to
 *   `resolvedName` — its pages' class tokens and its cascade's selectors
 *   follow, so every page keeps rendering with its own styles.
 * - `skip`: drop this definition; its pages bind to the first definition.
 * - `overwrite`: this definition wins the bare name; the other definitions'
 *   class fragments are dropped and their pages bind to this one.
 */
export interface CrossSheetClassConflict {
  /** The colliding class name as authored in the source CSS. */
  desiredName: string
  /** Stable id of this divergent definition (hash of its effective declarations). */
  definitionId: string
  /**
   * CSS file paths whose class fragments produce this definition and are not
   * shared with the kept (first) definition's cascades.
   */
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
 * - `skip` (default when the content is the same): keep the existing file and
 *   its content; the pages this import links it from join its page scope.
 * - `overwrite` (default when the content differs): replace the existing
 *   file in place (same id and path: content, load order, a script's format
 *   and npm dependencies) and widen its page scope the same way.
 * - `auto-rename`: import a second copy under a free `-2` path, as a new file.
 */
export interface FileConflict {
  kind: 'script' | 'style'
  /** The import path (`ImportScript.path` / `ImportStylesheet.path`). */
  path: string
  /** The site file path both sides resolve to. */
  sitePath: string
  /** Id of the existing `SiteFile`. */
  existingFileId: string
  /**
   * The imported text equals the existing file's. Compared at plan time, so a
   * kept stylesheet with `url()`s (still bundle paths here, media URLs in the
   * site) reads as changed even when it is not; replacing it is harmless.
   */
  sameContent: boolean
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
