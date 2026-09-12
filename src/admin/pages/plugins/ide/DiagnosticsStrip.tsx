/**
 * DiagnosticsStrip — the bottom strip under the code editor. Shows the
 * automatic validation's bundle / manifest / sandbox / containment
 * diagnostics as they land (debounced on save-less live edits), plus the
 * active revision's runtime error when the plugin is parked in
 * `runtime-error` — the one problem validation cannot see.
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import styles from './DiagnosticsStrip.module.css'

interface DiagnosticsStripProps {
  diagnostics: string[]
  /** `lastError` of the active revision while its state is runtime-error. */
  runtimeError: string | null
  validating: boolean
  synced: boolean
}

export function DiagnosticsStrip({
  diagnostics,
  runtimeError,
  validating,
  synced,
}: DiagnosticsStripProps) {
  const problems = runtimeError
    ? [`Runtime error in the active revision: ${runtimeError}`, ...diagnostics]
    : diagnostics
  const status = !synced
    ? 'connecting…'
    : validating
      ? 'validating…'
      : problems.length === 0
        ? 'clean'
        : `${problems.length} problem${problems.length === 1 ? '' : 's'}`

  return (
    <section className={styles.strip} aria-label="Diagnostics" data-testid="ide-diagnostics">
      <header className={styles.header}>
        <span className={styles.title}>Diagnostics</span>
        <span className={styles.status} role="status">
          {status}
        </span>
      </header>
      {problems.length === 0 ? (
        <p className={styles.empty}>
          <CheckIcon size={12} aria-hidden="true" className={styles.okIcon} />
          No diagnostics — the draft builds cleanly.
        </p>
      ) : (
        <ul className={styles.list}>
          {problems.map((problem, index) => (
            <li key={index} className={styles.item}>
              <WarningDiamondSolidIcon size={12} aria-hidden="true" className={styles.errorIcon} />
              <span className={styles.message}>{problem}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
