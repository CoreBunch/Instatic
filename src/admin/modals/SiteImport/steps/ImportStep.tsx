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
import { ImportStepper } from '../shared/ImportStepper'
import { withSiteImportCategoryTints } from '../shared/importCategoryAccent'
import type { CategoryCount, ImportCategoryId, RunProgress } from '../shared/importProgress'
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

type RowState = 'pending' | 'active' | 'done'

interface ImportStepProps {
  progress: RunProgress
  siteName: string
  result: ImportResult | null
  droppedAtRules: number
  /** When true, the complete state additionally reveals the import-log details. */
  logOpen: boolean
}

export function ImportStep({ progress, siteName, result, droppedAtRules, logOpen }: ImportStepProps) {
  const { phase, categories, currentItem } = progress
  const done = phase === 'done'
  const failed = phase === 'failed'

  const media = categories.media
  const uploadFrac = media.total > 0 ? media.done / media.total : 1
  // Reserve the final slice for the atomic commit so the bar doesn't sit at
  // 100% while pages/rules/tokens are still being written.
  const pct = done ? 100 : Math.min(99, Math.round(uploadFrac * 92))

  function rowState(id: ImportCategoryId, c: CategoryCount): RowState {
    if (done) return 'done'
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
      ? CATEGORIES.find((c) => c.id === 'media')!
      : CATEGORIES.find((c) => categories[c.id].total > 0) ?? CATEGORIES[0]
  const activeCount = categories[activeCfg.id]

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
            <span className={styles.doneMark}>
              <CheckIcon size={28} />
            </span>
            <h3 className={styles.doneTitle}>Imported into {siteName}</h3>
            {result && <p className={styles.doneSub}>{summaryLine(result)}</p>}
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
              {CATEGORIES.map((cfg) => {
                const c = categories[cfg.id]
                const state = rowState(cfg.id, c)
                const local = state === 'done' ? 1 : cfg.id === 'media' && c.total > 0 ? c.done / c.total : 0
                const countText =
                  state === 'done'
                    ? `${c.total} / ${c.total}`
                    : state === 'active' && cfg.id === 'media'
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

        {logOpen && done && result && (
          <ImportLog result={result} droppedAtRules={droppedAtRules} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import log — revealed on demand from the complete state
// ---------------------------------------------------------------------------

function ImportLog({ result, droppedAtRules }: { result: ImportResult; droppedAtRules: number }) {
  const counts: string[] = [
    `${result.pages.length} ${plural(result.pages.length, 'page')} imported`,
    `${result.styleRules.length} style ${plural(result.styleRules.length, 'rule')} imported`,
    `${result.assets.length} ${plural(result.assets.length, 'asset')} uploaded`,
  ]
  if (result.colors.length > 0) counts.push(`${result.colors.length} ${plural(result.colors.length, 'color')} added`)
  if (result.fonts.length > 0) counts.push(`${result.fonts.length} ${plural(result.fonts.length, 'font')} imported`)
  if (result.fontTokens.length > 0) {
    counts.push(`${result.fontTokens.length} font ${plural(result.fontTokens.length, 'token')} imported`)
  }
  if (result.scripts.length > 0) counts.push(`${result.scripts.length} ${plural(result.scripts.length, 'script')} imported`)
  if (droppedAtRules > 0) counts.push(`${droppedAtRules} @-${plural(droppedAtRules, 'rule')} dropped`)

  const warnings = result.warnings

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summaryLine(result: ImportResult): string {
  const parts = [
    `${result.pages.length} ${plural(result.pages.length, 'page')}`,
    `${result.styleRules.length} ${plural(result.styleRules.length, 'rule')}`,
    `${result.assets.length} media`,
  ]
  if (result.colors.length > 0) parts.push(`${result.colors.length} ${plural(result.colors.length, 'token')}`)
  if (result.fontTokens.length > 0) {
    parts.push(`${result.fontTokens.length} font ${plural(result.fontTokens.length, 'token')}`)
  }
  return parts.join(' · ')
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
