/**
 * Run-progress model for the Super Import wizard's Import step.
 *
 * Lives in its own module (not the component file) so it can be imported by the
 * modal, the step, and tests without tripping the `react-refresh` "only export
 * components" rule.
 *
 * Everything here is driven by real pipeline state — media (asset uploads) is
 * the only genuinely incremental phase; every other category lands in one
 * atomic commit, so those counts flip from 0 → committed-total together.
 */

import type { ImportPlan, ImportResult } from '@core/siteImport'
import type { ImportResult as CmsImportResult } from '@core/data/bundleSchema'

type RunPhase = 'idle' | 'uploading' | 'applying' | 'done' | 'failed'

export type ImportCategoryId =
  | 'pages'
  | 'styles'
  | 'media'
  | 'colors'
  | 'fonts'
  | 'scripts'
  | 'site'
  | 'rows'
  | 'mediaFolders'
  | 'redirects'

export interface CategoryCount {
  done: number
  total: number
}

export interface RunProgress {
  phase: RunPhase
  categories: Record<ImportCategoryId, CategoryCount>
  /** The item currently being processed, shown in the mono ticker. */
  currentItem: string
  /** Populated when `phase === 'failed'`. */
  errorMessage?: string
}

export function makeInitialRunProgress(): RunProgress {
  const zero: CategoryCount = { done: 0, total: 0 }
  return {
    phase: 'idle',
    currentItem: '',
    categories: {
      pages: { ...zero },
      styles: { ...zero },
      media: { ...zero },
      colors: { ...zero },
      fonts: { ...zero },
      scripts: { ...zero },
      site: { ...zero },
      rows: { ...zero },
      mediaFolders: { ...zero },
      redirects: { ...zero },
    },
  }
}

/**
 * Upload-phase progress for a static run. Totals come from the plan being
 * committed; media is the only incremental category, the rest flip pending →
 * done together once the atomic commit completes.
 */
export function makeStaticRunProgress(plan: ImportPlan): RunProgress {
  const progress = makeInitialRunProgress()
  progress.phase = 'uploading'
  progress.categories.pages = { done: 0, total: plan.pages.length }
  // Kept stylesheet files count alongside converted rules — one "styles" row.
  progress.categories.styles = { done: 0, total: plan.styleRules.length + plan.stylesheets.length }
  progress.categories.media = { done: 0, total: plan.assets.length }
  progress.categories.colors = { done: 0, total: plan.colors.length }
  progress.categories.fonts = {
    done: 0,
    total: plan.fonts.length + plan.googleFonts.length + plan.fontTokens.length,
  }
  progress.categories.scripts = { done: 0, total: plan.scripts.length }
  return progress
}

/**
 * Done-phase progress reconciled to what a static run actually committed —
 * skipped pages or rules (conflict resolutions) leave fewer than the planned
 * totals.
 */
export function makeStaticRunDoneProgress(result: ImportResult): RunProgress {
  const progress = makeInitialRunProgress()
  progress.phase = 'done'
  progress.categories.pages = { done: result.pages.length, total: result.pages.length }
  const styleCount = result.styleRules.length + result.stylesheets.length
  progress.categories.styles = { done: styleCount, total: styleCount }
  progress.categories.media = { done: result.assets.length, total: result.assets.length }
  progress.categories.colors = { done: result.colors.length, total: result.colors.length }
  const fontCount = result.fonts.length + result.fontTokens.length
  progress.categories.fonts = { done: fontCount, total: fontCount }
  progress.categories.scripts = { done: result.scripts.length, total: result.scripts.length }
  return progress
}

/** Selected category totals for a CMS bundle run, computed before it starts. */
export interface CmsRunTotals {
  site: number
  rows: number
  media: number
  mediaFolders: number
  redirects: number
}

/** Applying-phase progress for a CMS bundle run (the server streams the archive). */
export function makeCmsRunProgress(totals: CmsRunTotals): RunProgress {
  const progress = makeInitialRunProgress()
  progress.phase = 'applying'
  progress.currentItem = 'Importing site bundle…'
  progress.categories.site = { done: 0, total: totals.site }
  progress.categories.rows = { done: 0, total: totals.rows }
  progress.categories.media = { done: 0, total: totals.media }
  progress.categories.mediaFolders = { done: 0, total: totals.mediaFolders }
  progress.categories.redirects = { done: 0, total: totals.redirects }
  return progress
}

/** Done-phase progress for a CMS bundle run, done counts from the server result. */
export function makeCmsRunDoneProgress(totals: CmsRunTotals, result: CmsImportResult): RunProgress {
  const progress = makeInitialRunProgress()
  progress.phase = 'done'
  progress.categories.site = { done: totals.site, total: totals.site }
  progress.categories.rows = {
    done: result.rowsInserted + result.rowsReplaced + result.rowsSkipped,
    total: totals.rows,
  }
  progress.categories.media = { done: result.mediaImported, total: totals.media }
  progress.categories.mediaFolders = { done: result.mediaFoldersImported, total: totals.mediaFolders }
  progress.categories.redirects = { done: result.redirectsImported, total: totals.redirects }
  return progress
}
