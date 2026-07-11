/**
 * UploadQueueWindow — floating queue panel showing in-flight + finished
 * uploads with progress, retry, and "Show in folder" affordances. Lives
 * outside the Media page's main canvas so it persists across folder
 * navigation.
 */
import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { LoaderIcon } from 'pixel-art-icons/icons/loader'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { FloatingWindow } from '@admin/shared/FloatingWindow'
import type { UploadItem, UseUploadQueueResult } from '../../hooks/useUploadQueue'
import { formatBytes } from '../../utils/formatBytes'
import styles from './UploadQueueWindow.module.css'

interface UploadQueueWindowProps {
  queue: UseUploadQueueResult
  open: boolean
  onClose: () => void
  /**
   * Called when the user clicks "Show in folder" on a finished upload.
   * Lets the parent route into the asset's first folder (or "All files"
   * when unfiled).
   */
  onRevealAsset?: (uploadId: string) => void
}

export function UploadQueueWindow({ queue, open, onClose, onRevealAsset }: UploadQueueWindowProps) {
  const total = queue.items.length
  const succeeded = queue.items.filter((item) => item.status === 'succeeded').length
  const failed = queue.items.filter((item) => item.status === 'failed').length
  const inFlight = queue.items.filter((item) =>
    item.status === 'queued' || item.status === 'uploading',
  ).length

  const finishedExists = queue.items.some((item) =>
    item.status === 'succeeded' || item.status === 'failed' || item.status === 'cancelled',
  )

  const handleClear = () => queue.clearFinished()

  return (
    <FloatingWindow
      panelId="mediaUploadQueue"
      open={open}
      onClose={onClose}
      title={`Uploads (${succeeded}/${total})`}
      defaultPosition={{ x: 16, y: 80 }}
      width={360}
      maxHeight={420}
      ariaLabel="Upload queue"
      testId="media-upload-queue"
      headerActions={(
        <Button
          variant="ghost"
          size="xs"
          aria-label="Clear finished uploads"
          disabled={!finishedExists}
          onClick={handleClear}
        >
          Clear
        </Button>
      )}
    >
      <div className={styles.summary} role="status" aria-live="polite">
        {total === 0
          ? 'No uploads yet'
          : `${inFlight} in flight · ${succeeded} done${failed > 0 ? ` · ${failed} failed` : ''}`}
      </div>

      {total === 0 ? (
        <EmptyState
          compact
          plain
          icon={<UploadIcon size={22} />}
          title="Nothing here yet"
          description="Drop files onto the media canvas to upload them."
        />
      ) : (
        <ul className={styles.list} role="list">
          {queue.items.map((item) => (
            <UploadRow
              key={item.id}
              item={item}
              onRetry={() => queue.retry(item.id)}
              onRemove={() => queue.remove(item.id)}
              onReveal={onRevealAsset ? () => onRevealAsset(item.id) : undefined}
            />
          ))}
        </ul>
      )}
    </FloatingWindow>
  )
}

interface UploadRowProps {
  item: UploadItem
  onRetry: () => void
  onRemove: () => void
  onReveal?: () => void
}

function UploadRow({ item, onRetry, onRemove, onReveal }: UploadRowProps) {
  // Mint the preview blob URL once via a lazy initializer — NOT in the render
  // body, which re-runs on every progress tick (patchItem replaces the item
  // object) and would leak a fresh URL each render. A row's item.file is fixed
  // for its mounted lifetime (patchItem spreads ...item, never reassigning
  // file), so one URL per row is correct; the effect revokes it on unmount.
  const [previewUrl] = useState<string | null>(() =>
    item.file.type.startsWith('image/') ? URL.createObjectURL(item.file) : null,
  )
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const pct = item.status === 'uploading'
    ? Math.round(item.progress * 100)
    : item.status === 'succeeded'
      ? 100
      : 0

  return (
    <li className={styles.row} data-status={item.status}>
      <span className={styles.preview} aria-hidden="true">
        {previewUrl ? (
          <img src={previewUrl} alt="" className={styles.previewImage} />
        ) : (
          <UploadIcon size={16} />
        )}
      </span>
      <span className={styles.body}>
        <span className={styles.name} title={item.file.name}>{item.file.name}</span>
        <span className={styles.meta}>
          <StatusBadge status={item.status} />
          <span>{formatBytes(item.file.size)}</span>
          {item.status === 'uploading' && <span>{pct}%</span>}
        </span>
        {item.error && (
          <span className={styles.error} role="alert">{item.error}</span>
        )}
        <span className={styles.progressBar} aria-hidden="true">
          <span
            className={styles.progressFill}
            data-status={item.status}
            style={{ width: `${pct}%` }}
          />
        </span>
      </span>
      <span className={styles.actions}>
        {item.status === 'failed' && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Retry upload"
            tooltip="Retry"
            onClick={onRetry}
          >
            <ReloadIcon size={12} />
          </Button>
        )}
        {item.status === 'succeeded' && onReveal && (
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Show ${item.file.name} in folder`}
            onClick={onReveal}
          >
            Show
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={item.status === 'uploading' ? 'Cancel upload' : 'Remove from queue'}
          tooltip={item.status === 'uploading' ? 'Cancel' : 'Remove'}
          onClick={onRemove}
        >
          <CloseIcon size={12} />
        </Button>
      </span>
    </li>
  )
}

function StatusBadge({ status }: { status: UploadItem['status'] }) {
  if (status === 'uploading' || status === 'queued') {
    return (
      <span className={styles.badgeBusy}>
        <LoaderIcon size={11} />
        {status === 'queued' ? 'Queued' : 'Uploading'}
      </span>
    )
  }
  if (status === 'succeeded') {
    return (
      <span className={styles.badgeSuccess}>
        <CheckIcon size={11} />
        Done
      </span>
    )
  }
  if (status === 'failed') {
    return <span className={styles.badgeError}>Failed</span>
  }
  return <span className={styles.badgeMuted}>Cancelled</span>
}
