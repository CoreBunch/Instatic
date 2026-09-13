/**
 * ImportStep — the Import stage of the Super Import wizard.
 *
 * Replaces the old terminal-style upload log with a calm, determinate progress
 * surface built in the same vocabulary as the Review step: the shared
 * `ImportStepper`, categorical accent identity, and the achromatic shell.
 *
 * Three states, all driven by the real import pipeline (see SiteImportModal):
 *   running   — a headline activity (phase verb + N of M), a determinate bar
 *               with a travelling shimmer, a one-line current-item ticker, and a
 *               per-category breakdown mirroring the Review navigator.
 *   complete  — a success mark + summary, with every category shown as done.
 *               A category that fell short of its planned total (media
 *               uploads that failed) stays visibly partial — `22 / 30`, a
 *               warning mark, and a line saying how many failed — instead
 *               of collapsing to `22 / 22` (#412).
 *   failed    — an inline error surface (failures are also surfaced via toast).
 *
 * Media (asset uploads) is the only genuinely incremental phase — every other
 * category is added in one atomic commit, so it flips pending → done together
 * once the commit lands. Media therefore naturally dominates the bar.
 */
import { type CSSProperties } from 'react'
import type { RailAccent } from '@ui/railAccent'
import { FileTextSolidIcon } from 'pixel-art-icons/icons/file-text-solid'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { PaintBucketSolidIcon } from 'pixel-art-icons/icons/paint-bucket-solid'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import type { ImportResult } from '@core/siteImport'
import type { ImportResult as CmsImportResult } from '@core/data/bundleSchema'
import { ImportStepper } from '../shared/ImportStepper'
import { withSiteImportCategoryTints } from '../shared/importCategoryAccent'
import {
  rankWarning,
  type CategoryCount,
  type ImportCategoryId,
  type RunProgress,
} from '../shared/importProgress'
import styles from './ImportStep.module.css'

// ---------------------------------------------------------------------------
// Category config — order + identity mirror the Review navigator
// ---------------------------------------------------------------------------

interface CategoryConfig {
  id: ImportCategoryId
  label: string
  accent: RailAccent
  tint: string
  unit: string
  verb: string
  Icon: typeof FileTextSolidIcon
}

type BaseCategoryConfig = Omit<CategoryConfig, 'accent' | 'tint'>

const CATEGORIES: CategoryConfig[] = withSiteImportCategoryTints<BaseCategoryConfig>([
  { id: 'pages', label: 'Pages', unit: 'pages', verb: 'Building pages', Icon: FileTextSolidIcon },
  { id: 'styles', label: 'Style rules', unit: 'rules', verb: 'Applying style rules', Icon: BracesIcon },
  { id: 'media', label: 'Media', unit: 'files', verb: 'Uploading media', Icon: ImageSolidIcon },
  { id: 'colors', label: 'Color tokens', unit: 'tokens', verb: 'Creating color tokens', Icon: PaintBucketSolidIcon },
  { id: 'fonts', label: 'Fonts', unit: 'fonts', verb: 'Embedding fonts', Icon: HeadingIcon },
  { id: 'scripts', label: 'Scripts', unit: 'files', verb: 'Attaching scripts', Icon: CodeIcon },
])

const CMS_CATEGORIES: CategoryConfig[] = withSiteImportCategoryTints<BaseCategoryConfig>([
  { id: 'site', label: 'Theme & settings', unit: 'shell', verb: 'Applying site shell', Icon: PaintBucketSolidIcon },
  { id: 'rows', label: 'Rows', unit: 'rows', verb: 'Importing rows', Icon: FileTextSolidIcon },
  { id: 'media', label: 'Media', unit: 'files', verb: 'Streaming media', Icon: ImageSolidIcon },
  { id: 'mediaFolders', label: 'Media folders', unit: 'folders', verb: 'Restoring folders', Icon: HeadingIcon },
  { id: 'redirects', label: 'Redirects', unit: 'redirects', verb: 'Restoring redirects', Icon: CodeIcon },
])

/** `partial`: the run finished but this category fell short of its planned total. */
type RowState = 'pending' | 'active' | 'done' | 'partial'

interface ImportStepProps {
  progress: RunProgress
  siteName: string
  result: ImportResult | null
  cmsResult?: CmsImportResult | null
  mode?: 'static' | 'cms'
  droppedAtRules: number
  /** When true, the complete state additionally reveals the import-log details. */
  logOpen: boolean
}

export function ImportStep({
  progress,
  siteName,
  result,
  cmsResult = null,
  mode = 'static',
  droppedAtRules,
  logOpen,
}: ImportStepProps) {
  const { phase, categories, currentItem } = progress
  const configs = mode === 'cms' ? CMS_CATEGORIES : CATEGORIES
  const done = phase === 'done'
  const failed = phase === 'failed'

  const media = categoryCount(categories, 'media')
  const uploadFrac = media.total > 0 ? media.done / media.total : 1
  // Reserve the final slice for the atomic commit so the bar doesn't sit at
  // 100% while pages/rules/tokens are still being written.
  const pct = done ? 100 : Math.min(99, Math.round(uploadFrac * 92))

  function rowState(id: string, c: CategoryCount): RowState {
    if (done) return c.done < c.total ? 'partial' : 'done'
    if (c.total === 0) return 'done' // nothing to import in this category
    if (id === 'media') {
      if (c.done >= c.total) return 'done'
      return phase === 'uploading' ? 'active' : 'pending'
    }
    // Non-media categories commit atomically at the end.
    return phase === 'applying' ? 'active' : 'pending'
  }

  // Headline activity: media while uploading; otherwise the first category that
  // still has work (only briefly visible — the commit is atomic).
  const activeCfg =
    phase === 'uploading' && media.total > 0 && media.done < media.total
      ? configs.find((c) => c.id === 'media')!
      : configs.find((c) => categoryCount(categories, c.id).total > 0) ?? configs[0]
  const activeCount = categoryCount(categories, activeCfg.id)

  return (
    <div className={styles.step}>
      <ImportStepper current="import" allDone={done} />

      <div className={styles.body}>
        {failed ? (
          <div className={styles.failed} role="alert">
            <span className={styles.failedMark}>
              <WarningDiamondSolidIcon size={26} />
            </span>
            <h3 className={styles.failedTitle}>Import didn’t finish</h3>
            <p className={styles.failedSub}>
              {progress.errorMessage ?? 'Something went wrong while importing. No changes were applied.'}
            </p>
          </div>
        ) : done ? (
          <div className={styles.doneHead}>
            <span className={styles.doneMark} data-partial={media.done < media.total ? 'true' : undefined}>
              {media.done < media.total ? <WarningDiamondSolidIcon size={26} /> : <CheckIcon size={28} />}
            </span>
            <h3 className={styles.doneTitle}>Imported into {siteName}</h3>
            {mode === 'cms' && cmsResult && <p className={styles.doneSub}>{cmsSummaryLine(cmsResult)}</p>}
            {mode !== 'cms' && result && <p className={styles.doneSub}>{summaryLine(result, media)}</p>}
            {mode !== 'cms' && media.done < media.total && (
              <p className={styles.doneWarn} role="status">
                {media.total - media.done} of {media.total} media files failed to upload. Their pages
                still point at the original file paths — the import log lists them.
              </p>
            )}
          </div>
        ) : (
          <div className={styles.summary} role="status" aria-live="polite">
            <div className={styles.summaryTop}>
              <div className={styles.activity}>
                <span className={styles.activityIcon}>
                  <activeCfg.Icon size={15} />
                </span>
                <span className={styles.activityText}>
                  <span className={styles.activityTitle}>{activeCfg.verb}</span>
                  <span className={styles.activitySub}>
                    {activeCount.done} of {activeCount.total} {activeCfg.unit}
                  </span>
                </span>
              </div>
              <span className={styles.percent}>{pct}%</span>
            </div>
            <div className={styles.bar} data-active="true">
              <div className={styles.barFill} style={{ width: `${pct}%` }} />
            </div>
            <div className={styles.current}>
              <span className={styles.currentFile}>{currentItem}</span>
              <span className={styles.currentCaret} />
            </div>
          </div>
        )}

        {!failed && (
          <>
            <p className={styles.catsLabel}>{done ? 'Imported' : 'Progress'}</p>
            <div className={styles.cats}>
              {configs.map((cfg) => {
                const c = categoryCount(categories, cfg.id)
                const state = rowState(cfg.id, c)
                const local = state === 'done' ? 1 : c.total > 0 && (state === 'partial' || cfg.id === 'media') ? c.done / c.total : 0
                const countText =
                  state === 'done'
                    ? `${c.total} / ${c.total}`
                    : state === 'partial' || (state === 'active' && cfg.id === 'media')
                      ? `${c.done} / ${c.total}`
                      : `0 / ${c.total}`
                return (
                  <div
                    key={cfg.id}
                    className={styles.cat}
                    data-state={state}
                    data-accent={cfg.accent}
                    data-testid={`site-import-category-${cfg.id}`}
                    style={{ '--cat-tint': cfg.tint, '--cat-p': local } as CSSProperties}
                  >
                    <span className={styles.catIcon}>
                      <cfg.Icon size={15} />
                    </span>
                    <span className={styles.catName}>
                      <span className={styles.catTitle}>{cfg.label}</span>
                      <span className={styles.catMeta}>
                        {c.total} {cfg.unit}
                      </span>
                    </span>
                    <span className={styles.catCount}>{countText}</span>
                    <span className={styles.catStatus}>
                      {state === 'done' ? (
                        <span className={styles.check}>
                          <CheckIcon size={13} />
                        </span>
                      ) : state === 'partial' ? (
                        <span className={styles.partialMark}>
                          <WarningDiamondSolidIcon size={13} />
                        </span>
                      ) : state === 'active' ? (
                        <span className={styles.spinner} />
                      ) : (
                        <span className={styles.dotPending} />
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {mode === 'static' && logOpen && done && result && (
          <ImportLog result={result} media={media} droppedAtRules={droppedAtRules} />
        )}
        {mode === 'cms' && logOpen && done && cmsResult && (
          <CmsImportLog result={cmsResult} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import log — revealed on demand from the complete state
// ---------------------------------------------------------------------------

function ImportLog({
  result,
  media,
  droppedAtRules,
}: {
  result: ImportResult
  media: CategoryCount
  droppedAtRules: number
}) {
  const counts: string[] = [
    `${result.pages.length} ${plural(result.pages.length, 'page')} imported`,
    `${result.styleRules.length} style ${plural(result.styleRules.length, 'rule')} imported`,
    media.done < media.total
      ? `${media.done} of ${media.total} ${plural(media.total, 'asset')} uploaded`
      : `${result.assets.length} ${plural(result.assets.length, 'asset')} uploaded`,
  ]
  if (result.colors.length > 0) counts.push(`${result.colors.length} ${plural(result.colors.length, 'color')} added`)
  if (result.fonts.length > 0) counts.push(`${result.fonts.length} ${plural(result.fonts.length, 'font')} imported`)
  if (result.fontTokens.length > 0) {
    counts.push(`${result.fontTokens.length} font ${plural(result.fontTokens.length, 'token')} imported`)
  }
  if (result.scripts.length > 0) counts.push(`${result.scripts.length} ${plural(result.scripts.length, 'script')} imported`)
  if (droppedAtRules > 0) counts.push(`${droppedAtRules} @-${plural(droppedAtRules, 'rule')} dropped`)

  // Only the first 12 warnings are shown, and a stylesheet-heavy import can
  // produce dozens of cosmetic CSS notes — so the ones naming a specific file
  // the user has to go fetch lead, ahead of the ones that are FYI.
  const warnings = [...result.warnings].sort(
    (a, b) => rankWarning(a.kind) - rankWarning(b.kind),
  )

  return (
    <section className={styles.log} aria-label="Import log">
      <p className={styles.logHeading}>Import log</p>
      <ul className={styles.logList}>
        {counts.map((line) => (
          <li key={line} className={styles.logLine}>{line}</li>
        ))}
      </ul>
      {warnings.length > 0 && (
        <div className={styles.warnings}>
          <p className={styles.warningsHeading}>
            <WarningDiamondSolidIcon size={12} aria-hidden="true" />
            {warnings.length} {plural(warnings.length, 'warning')}
          </p>
          <ul className={styles.logList}>
            {warnings.slice(0, 12).map((w) => {
              const key = `${w.kind}:${w.path ?? ''}:${w.source ?? ''}:${w.message}`
              return (
                <li key={key} className={styles.warningItem}>
                  <span className={styles.warningKind}>{w.kind}</span>
                  <span className={styles.warningMsg}>{w.message}</span>
                </li>
              )
            })}
            {warnings.length > 12 && (
              <li className={styles.warningItem}>
                <span className={styles.warningMsg}>…and {warnings.length - 12} more</span>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  )
}

function CmsImportLog({ result }: { result: CmsImportResult }) {
  const counts = [
    `${result.rowsInserted} ${plural(result.rowsInserted, 'row')} added`,
    `${result.rowsReplaced} ${plural(result.rowsReplaced, 'row')} replaced`,
    `${result.rowsSkipped} ${plural(result.rowsSkipped, 'row')} skipped`,
    `${result.mediaImported} media ${plural(result.mediaImported, 'file')} imported`,
    `${result.mediaFoldersImported} ${plural(result.mediaFoldersImported, 'folder')} imported`,
    `${result.redirectsImported} ${plural(result.redirectsImported, 'redirect')} imported`,
  ]

  return (
    <section className={styles.log} aria-label="Import log">
      <p className={styles.logHeading}>Import log</p>
      <ul className={styles.logList}>
        {counts.map((line) => (
          <li key={line} className={styles.logLine}>{line}</li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summaryLine(result: ImportResult, media: CategoryCount): string {
  const parts = [
    `${result.pages.length} ${plural(result.pages.length, 'page')}`,
    `${result.styleRules.length} ${plural(result.styleRules.length, 'rule')}`,
    media.done < media.total ? `${media.done} of ${media.total} media` : `${result.assets.length} media`,
  ]
  if (result.colors.length > 0) parts.push(`${result.colors.length} ${plural(result.colors.length, 'token')}`)
  if (result.fontTokens.length > 0) {
    parts.push(`${result.fontTokens.length} font ${plural(result.fontTokens.length, 'token')}`)
  }
  return parts.join(' · ')
}

function cmsSummaryLine(result: CmsImportResult): string {
  const parts = [
    `${result.rowsInserted} ${plural(result.rowsInserted, 'row')} added`,
    `${result.rowsReplaced} ${plural(result.rowsReplaced, 'row')} replaced`,
    `${result.mediaImported} media`,
  ]
  if (result.rowsSkipped > 0) parts.push(`${result.rowsSkipped} ${plural(result.rowsSkipped, 'row')} skipped`)
  if (result.mediaFoldersImported > 0) parts.push(`${result.mediaFoldersImported} ${plural(result.mediaFoldersImported, 'folder')}`)
  if (result.redirectsImported > 0) parts.push(`${result.redirectsImported} ${plural(result.redirectsImported, 'redirect')}`)
  return parts.join(' · ')
}

function categoryCount(categories: RunProgress['categories'], id: ImportCategoryId): CategoryCount {
  return categories[id] ?? { done: 0, total: 0 }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
