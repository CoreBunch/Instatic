/**
 * React node-view for the `mediaUploadPlaceholder` Tiptap node.
 *
 * Renders a thumbnail (or video poster) of the in-flight upload with a
 * progress bar and a cancel button. Reads attrs from `node.attrs`; the
 * paste/drop handler updates those attrs while bytes stream, which
 * triggers a re-render via Tiptap's standard node-view refresh.
 *
 * Cancel deletes the placeholder node and aborts the in-flight upload via
 * the host-provided cancel callback (wired through `extensions: [...]`'s
 * options).
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import styles from './MediaUploadPlaceholderView.module.css'
import type { MediaUploadPlaceholderAttributes } from './MediaUploadPlaceholder'

interface MediaUploadCancelHandler {
  (uploadId: string): void
}

interface MediaUploadPlaceholderViewProps extends NodeViewProps {
  /** Extension options bag — Tiptap forwards `extension.options` here. */
  extension: NodeViewProps['extension'] & {
    options: { onCancel?: MediaUploadCancelHandler }
  }
}

export function MediaUploadPlaceholderView(props: MediaUploadPlaceholderViewProps) {
  const attrs = props.node.attrs as MediaUploadPlaceholderAttributes
  const progressPct = Math.round(Math.max(0, Math.min(1, attrs.progress)) * 100)
  const isFailed = attrs.status === 'failed'
  const onCancel = props.extension.options.onCancel

  return (
    <NodeViewWrapper
      as="figure"
      className={styles.frame}
      data-instatic-upload-placeholder=""
      data-instatic-upload-status={attrs.status}
      role="status"
      aria-live="polite"
      aria-busy={attrs.status === 'uploading'}
    >
      <div className={styles.preview}>
        {attrs.previewUrl
          ? attrs.kind === 'video'
            ? <video src={attrs.previewUrl} muted className={styles.thumb} />
            : <img src={attrs.previewUrl} alt="" className={styles.thumb} />
          : (
            <div className={styles.thumbEmpty} aria-hidden="true">
              {attrs.kind === 'video' ? 'Video' : 'Image'}
            </div>
          )}
      </div>
      <div className={styles.bar}>
        <div className={styles.label}>
          <span className={styles.filename}>{attrs.filename}</span>
          <span className={styles.status}>
            {isFailed
              ? (attrs.error ?? 'Upload failed')
              : `Uploading… ${progressPct}%`}
          </span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label={isFailed ? 'Remove failed upload' : 'Cancel upload'}
          tooltip={isFailed ? 'Remove' : 'Cancel'}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onCancel?.(attrs.uploadId)
          }}
          className={styles.cancelButton}
        >
          <CloseIcon size={14} aria-hidden="true" />
        </Button>
      </div>
      <div
        className={styles.progressTrack}
        data-state={attrs.status}
        aria-hidden="true"
      >
        <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
      </div>
    </NodeViewWrapper>
  )
}
