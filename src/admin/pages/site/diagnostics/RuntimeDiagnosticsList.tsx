/**
 * The readable form of a runtime-script build failure, shown wherever the
 * editor reports one: inside the publish gate's tooltip and on an Explorer
 * row's problem badge.
 *
 * A count on its own ("11 code errors") tells a developer nothing actionable,
 * so every entry carries the file, the position, and the compiler's message.
 */
import type { FileRuntimeDiagnostics, SiteRuntimeDiagnostic } from '@core/site-runtime'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import { CircleAlertSolidIcon } from 'pixel-art-icons/icons/circle-alert-solid'
import { describeCounts } from './describeCounts'
import styles from './RuntimeDiagnosticsList.module.css'

/** Long compiler messages are truncated: the tooltip is a pointer, the editor has the full text. */
const MAX_MESSAGE = 160
/** Beyond this the tooltip stops being scannable and says how many more there are. */
const MAX_ROWS = 6

function position(diagnostic: SiteRuntimeDiagnostic): string | null {
  if (diagnostic.line === undefined) return null
  return diagnostic.column === undefined ? `${diagnostic.line}` : `${diagnostic.line}:${diagnostic.column}`
}

function DiagnosticRow({ diagnostic, showFile }: { diagnostic: SiteRuntimeDiagnostic; showFile: boolean }) {
  const at = position(diagnostic)
  const message = diagnostic.message.length > MAX_MESSAGE
    ? `${diagnostic.message.slice(0, MAX_MESSAGE)}…`
    : diagnostic.message
  return (
    <li className={styles.row} data-severity={diagnostic.severity}>
      {diagnostic.severity === 'error'
        ? <WarningDiamondSolidIcon size={10} aria-hidden="true" className={styles.icon} />
        : <CircleAlertSolidIcon size={10} aria-hidden="true" className={styles.icon} />}
      <span className={styles.body}>
        {(showFile || at) && (
          <span className={styles.where}>
            {showFile && diagnostic.path && <span className={styles.file}>{diagnostic.path}</span>}
            {at && <span className={styles.at}>{at}</span>}
          </span>
        )}
        <span className={styles.message}>{message}</span>
      </span>
    </li>
  )
}

/** Every diagnostic for one file — the Explorer badge's tooltip. */
export function FileDiagnosticsList({ file }: { file: FileRuntimeDiagnostics }) {
  const shown = file.diagnostics.slice(0, MAX_ROWS)
  return (
    <div className={styles.wrap}>
      <p className={styles.title}>{describeCounts(file.errors, file.warnings)}</p>
      <ul className={styles.list}>
        {shown.map((diagnostic, index) => (
          <DiagnosticRow key={`${diagnostic.code}:${diagnostic.line ?? index}`} diagnostic={diagnostic} showFile={false} />
        ))}
      </ul>
      {file.diagnostics.length > shown.length && (
        <p className={styles.more}>{file.diagnostics.length - shown.length} more in this file.</p>
      )}
    </div>
  )
}

interface SiteDiagnosticsListProps {
  files: FileRuntimeDiagnostics[]
  siteWide: SiteRuntimeDiagnostic[]
  errors: number
  warnings: number
}

/** The whole site's build failures — the publish gate's tooltip. */
export function SiteDiagnosticsList({ files, siteWide, errors, warnings }: SiteDiagnosticsListProps) {
  const flat = [...siteWide, ...files.flatMap((file) => file.diagnostics)]
  const shown = flat.slice(0, MAX_ROWS)
  return (
    <div className={styles.wrap}>
      <p className={styles.title}>{describeCounts(errors, warnings)}</p>
      <ul className={styles.list}>
        {shown.map((diagnostic, index) => (
          <DiagnosticRow key={`${diagnostic.fileId ?? 'site'}:${diagnostic.code}:${index}`} diagnostic={diagnostic} showFile />
        ))}
      </ul>
      {flat.length > shown.length && <p className={styles.more}>{flat.length - shown.length} more.</p>}
      <p className={styles.hint}>Open the file in the Code tab to fix them.</p>
    </div>
  )
}
