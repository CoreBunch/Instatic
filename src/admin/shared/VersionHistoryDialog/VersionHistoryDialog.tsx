/**
 * VersionHistoryDialog — every published version of a row, newest first,
 * with "Restore" copying a version's content back into the draft on the
 * active branch. Restoring never publishes: the draft still goes live
 * through Publish (main) or a merge (branch).
 */
import { useEffect, useState } from 'react'
import { ArchiveRestoreSolidIcon } from 'pixel-art-icons/icons/archive-restore-solid'
import type { DataRow, DataRowVersionSummary } from '@core/data/schemas'
import { isAbortError } from '@core/http'
import { listCmsDataRowVersions, restoreCmsDataRowVersion } from '@core/persistence'
import { getErrorMessage } from '@core/utils/errorMessage'
import { formatRelativeTime } from '@core/utils/relativeTime'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Skeleton } from '@ui/components/Skeleton'
import { TagPill } from '@ui/components/TagPill'
import { pushToast } from '@ui/components/Toast'
import { cn } from '@ui/cn'
import styles from './VersionHistoryDialog.module.css'

interface VersionHistoryDialogProps {
  rowId: string
  /** "page", "post", … — used in copy. */
  entityLabel: string
  /** The row's current title, for the dialog eyebrow. */
  title?: string | null
  onClose: () => void
  /** Fires with the restored draft row. */
  onRestored?: (row: DataRow) => void
}

function publishedLabel(version: DataRowVersionSummary): string {
  const when = new Date(version.publishedAt)
  const relative = formatRelativeTime(when.getTime())
  const absolute = Number.isNaN(when.getTime()) ? '' : when.toLocaleString()
  const by = version.publishedByName ? ` by ${version.publishedByName}` : ''
  // formatRelativeTime returns "now", "5m" / "3h" / "2d", or a plain date
  // once older than a week — only the middle form takes "ago".
  const when2 = relative === 'now' ? 'just now' : /^\d+[mhd]$/.test(relative) ? `${relative} ago` : relative
  return `Published ${when2}${by}${absolute ? ` · ${absolute}` : ''}`
}

export function VersionHistoryDialog({ rowId, entityLabel, title, onClose, onRestored }: VersionHistoryDialogProps) {
  const [versions, setVersions] = useState<DataRowVersionSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    listCmsDataRowVersions(rowId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setVersions(next)
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || controller.signal.aborted) return
        console.error('[versions] failed to load version history:', err)
        setLoadError(getErrorMessage(err, 'Could not load version history'))
      })
    return () => controller.abort()
  }, [rowId])

  async function restore(version: DataRowVersionSummary): Promise<void> {
    if (restoring) return
    setRestoring(version.id)
    try {
      const row = await restoreCmsDataRowVersion(rowId, version.id)
      onRestored?.(row)
      onClose()
      pushToast({
        kind: 'success',
        title: `Restored version ${version.versionNumber}`,
        body: `The ${entityLabel} draft now matches version ${version.versionNumber}. Publish or merge when you're ready.`,
      })
    } catch (err) {
      console.error('[versions] restore failed:', err)
      pushToast({ kind: 'error', title: 'Could not restore the version', body: getErrorMessage(err, 'Unknown version error') })
    } finally {
      setRestoring(null)
      setConfirming(null)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Version history"
      eyebrow={title ?? undefined}
      size="md"
      footer={(
        <Button variant="primary" size="sm" type="button" onClick={onClose}>
          Done
        </Button>
      )}
    >
      {loadError ? (
        <p className={styles.error} role="alert">{loadError}</p>
      ) : !versions ? (
        <div className={styles.loading} aria-busy="true" aria-label="Loading versions">
          <Skeleton width="70%" height={14} radius={999} />
          <Skeleton width="55%" height={14} radius={999} />
        </div>
      ) : versions.length === 0 ? (
        <p className={styles.empty} data-testid="version-history-empty">
          This {entityLabel} has not been published yet, so there is nothing to restore.
        </p>
      ) : (
        <ul className={styles.list} aria-label="Published versions" data-testid="version-history-list">
          {versions.map((version, index) => {
            const isLatest = index === 0
            const isConfirming = confirming === version.id
            return (
              <li key={version.id} className={cn(styles.row, isConfirming && styles.rowConfirm)} data-testid={`version-row-${version.versionNumber}`}>
                <span className={styles.icon} aria-hidden="true"><ArchiveRestoreSolidIcon size={12} /></span>
                <span className={styles.main}>
                  <span className={styles.label}>
                    Version {version.versionNumber}
                    {isLatest && <TagPill label="Latest" size="xs" className={styles.pill} />}
                  </span>
                  <span className={styles.meta}>
                    {isConfirming
                      ? `Replace the current draft with version ${version.versionNumber}? Unpublished edits on the draft are lost.`
                      : publishedLabel(version)}
                  </span>
                </span>
                {isConfirming ? (
                  <span className={styles.actions}>
                    <Button variant="ghost" size="xs" type="button" onClick={() => setConfirming(null)} disabled={restoring !== null}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="xs"
                      type="button"
                      busy={restoring === version.id}
                      data-testid={`version-restore-confirm-${version.versionNumber}`}
                      onClick={() => { void restore(version) }}
                    >
                      Restore
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="xs"
                    type="button"
                    data-testid={`version-restore-${version.versionNumber}`}
                    onClick={() => setConfirming(version.id)}
                  >
                    Restore
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}
