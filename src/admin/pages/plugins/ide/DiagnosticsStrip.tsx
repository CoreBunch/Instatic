/**
 * DiagnosticsStrip — the bottom strip under the code editor. Shows the
 * automatic validation's bundle / manifest / sandbox / containment
 * diagnostics as they land (debounced on save-less live edits).
 */
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import styles from './DiagnosticsStrip.module.css'

interface DiagnosticsStripProps {
  diagnostics: string[]
  validating: boolean
  synced: boolean
}

export function DiagnosticsStrip({ diagnostics, validating, synced }: DiagnosticsStripProps) {
  return (
    <section className={styles.strip} aria-label="Diagnostics" data-testid="ide-diagnostics">
      <header className={styles.header}>
        <span className={styles.title}>Diagnostics</span>
        <span className={styles.status} role="status">
          {!synced ? 'connecting…' : validating ? 'validating…' : diagnostics.length === 0 ? 'clean' : `${diagnostics.length} problem${diagnostics.length === 1 ? '' : 's'}`}
        </span>
      </header>
      {diagnostics.length === 0 ? (
        <p className={styles.empty}>
          <CheckIcon size={12} aria-hidden="true" className={styles.okIcon} />
          No diagnostics — the draft builds cleanly.
        </p>
      ) : (
        <ul className={styles.list}>
          {diagnostics.map((diagnostic, index) => (
            <li key={index} className={styles.item}>
              <WarningDiamondSolidIcon size={12} aria-hidden="true" className={styles.errorIcon} />
              <span className={styles.message}>{diagnostic}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
