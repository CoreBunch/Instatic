/**
 * The count on a Site Explorer row whose file failed to build, with the
 * messages on hover. Without it a developer has to open every script to find
 * which one the publish gate is complaining about.
 */
import { Tooltip } from '@ui/components/Tooltip'
import type { FileRuntimeDiagnostics } from '@core/site-runtime'
import { FileDiagnosticsList } from './RuntimeDiagnosticsList'
import { describeCounts } from './describeCounts'
import styles from './ProblemBadge.module.css'

export function ProblemBadge({ file }: { file: FileRuntimeDiagnostics }) {
  const tone = file.errors > 0 ? 'error' : 'warning'
  return (
    <Tooltip content={<FileDiagnosticsList file={file} />} size="wide">
      <span
        className={styles.badge}
        data-tone={tone}
        role="img"
        aria-label={`${describeCounts(file.errors, file.warnings)} in this file`}
      >
        {file.errors > 0 ? file.errors : file.warnings}
      </span>
    </Tooltip>
  )
}
