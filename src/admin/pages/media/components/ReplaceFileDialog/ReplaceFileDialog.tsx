/**
 * ReplaceFileDialog — confirm + upload UI for swapping an asset's binary.
 *
 * Opens with a clear warning that the public URL stays the same (so every
 * existing reference auto-updates), then lets the user pick a replacement
 * file via `<FileUpload>`. Submitting calls back into the workspace which
 * runs the multipart POST to /replace.
 */
import { useState, type ChangeEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { FileUpload } from '@ui/components/FileUpload'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { formatBytes } from '@admin/lib/formatBytes'
import styles from './ReplaceFileDialog.module.css'
import { getErrorMessage } from '@core/utils/errorMessage'

interface ReplaceFileDialogProps {
  asset: CmsMediaAsset
  open: boolean
  onClose: () => void
  onReplace: (file: File) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// Module-level helper (extracted so the React Compiler can compile the
// component body — try/finally inside an async function prevents compilation).
// ---------------------------------------------------------------------------

async function confirmReplace(
  picked: File,
  onReplace: (file: File) => Promise<unknown>,
  setPicked: (file: File | null) => void,
  onClose: () => void,
  setError: (msg: string | null) => void,
  setBusy: (v: boolean) => void,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await onReplace(picked)
    setPicked(null)
    onClose()
  } catch (err) {
    setError(getErrorMessage(err, 'Replace failed'))
  } finally {
    setBusy(false)
  }
}

export function ReplaceFileDialog({ asset, open, onClose, onReplace }: ReplaceFileDialogProps) {
  const [picked, setPicked] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handlePick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null
    event.target.value = ''
    setPicked(file)
    setError(null)
  }

  async function handleConfirm() {
    if (!picked) return
    await confirmReplace(picked, onReplace, setPicked, onClose, setError, setBusy)
  }

  function handleClose() {
    if (busy) return
    setPicked(null)
    setError(null)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Replace file"
      eyebrow="Media"
      size="md"
      footer={(
        <>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={!picked || busy}
          >
            {busy ? 'Replacing…' : 'Replace file'}
          </Button>
        </>
      )}
    >
      <p className={styles.body}>
        The new file inherits the same public URL — every page and content entry that
        already references this asset will switch to the new binary instantly. The
        previous file is removed from disk.
      </p>

      <dl className={styles.current}>
        <dt>Current file</dt>
        <dd>{asset.filename} · {formatBytes(asset.sizeBytes)} · {asset.mimeType}</dd>
      </dl>

      <div className={styles.picker}>
        <FileUpload
          onChange={handlePick}
          buttonProps={{
            variant: 'secondary',
            size: 'sm',
            'aria-label': 'Choose replacement file',
          }}
        >
          <UploadIcon size={13} />
          <span>{picked ? 'Choose different file' : 'Choose replacement…'}</span>
        </FileUpload>

        {picked && (
          <p className={styles.picked} role="status">
            New file: <strong>{picked.name}</strong> · {formatBytes(picked.size)}
          </p>
        )}
      </div>

      {error && (
        <p className={styles.error} role="alert">{error}</p>
      )}
    </Dialog>
  )
}
