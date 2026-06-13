/**
 * DropStep — the first step of the Super Import wizard.
 *
 * Accepts files via drag-and-drop, folder picker, or multi-file picker.
 * Handles directory entry walking for dropped folders. A single .zip file
 * is handed off as raw bytes; everything else is passed as a File array.
 * The parent detects CMS-exported .json bundles before static-site ingestion.
 *
 * Validation errors (oversized, zip-bomb, traversal) are shown via the
 * `errorMessage` prop — the MODAL catches them from ingestInput() and passes
 * them back here so the drop zone can display them inline.
 */
import { useRef, useState, type DragEvent, type ChangeEvent } from 'react'
import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { FilePlusSolidIcon } from 'pixel-art-icons/icons/file-plus-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import styles from './DropStep.module.css'

interface DropStepProps {
  /** True while the modal is ingesting + analyzing the dropped files. */
  busy: boolean
  /** Error message from the last ingest attempt, or null. Shown with role="alert". */
  errorMessage: string | null
  /** Called when the user drops/picks loose files (non-zip). */
  onFilesReady: (files: File[]) => void
  /** Called when a single .zip was dropped or picked — bytes ready for ingestInput. */
  onZipReady: (zipBytes: Uint8Array) => void
}

export function DropStep({ busy, errorMessage, onFilesReady, onZipReady }: DropStepProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  async function dispatchFiles(files: File[]) {
    if (files.length === 0) return
    if (
      files.length === 1 &&
      (files[0].name.toLowerCase().endsWith('.zip') ||
        files[0].type === 'application/zip' ||
        files[0].type === 'application/x-zip-compressed')
    ) {
      const buf = await files[0].arrayBuffer()
      onZipReady(new Uint8Array(buf))
      return
    }
    onFilesReady(files)
  }

  async function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    if (busy) return

    const items = e.dataTransfer.items
    if (items && items.length > 0) {
      const entries: FileSystemEntry[] = []
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.()
        if (entry) entries.push(entry)
      }

      if (entries.some((en) => en.isDirectory)) {
        const collected: File[] = []
        for (const entry of entries) {
          await collectEntry(entry, '', collected)
        }
        void dispatchFiles(collected)
        return
      }
    }

    const files = Array.from(e.dataTransfer.files)
    void dispatchFiles(files)
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    void dispatchFiles(files)
  }

  return (
    <div className={styles.wrapper}>
      <div
        className={styles.dropZone}
        data-dragging={dragging ? 'true' : undefined}
        data-disabled={busy ? 'true' : undefined}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true) }}
        onDragEnter={(e) => { e.preventDefault(); if (!busy) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { void handleDrop(e) }}
        aria-label="Drop site files, a folder, a CMS bundle, or a .zip archive here"
      >
        <UploadIcon size={28} aria-hidden="true" className={styles.dropIcon} />
        <p className={styles.dropTitle}>Drop a site folder, CMS bundle, or .zip here</p>
        <p className={styles.dropHint}>HTML, CSS, images, fonts, and CMS .json bundles are supported</p>
        <div className={styles.dropActions}>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            <FilePlusSolidIcon size={13} aria-hidden="true" />
            Choose files
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderGlyphIcon size={13} aria-hidden="true" />
            Choose folder
          </Button>
        </div>
      </div>

      {busy && (
        <p className={styles.status} aria-live="polite">
          Ingesting files and analyzing…
        </p>
      )}

      {errorMessage && (
        <p className={styles.error} role="alert">
          {errorMessage}
        </p>
      )}

      {/* Hidden file inputs — not interactive UI controls, purely mechanism. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleFileChange}
      />
      {/* webkitdirectory is not in standard TS lib but is valid in all browsers. */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className={styles.hiddenInput}
        aria-hidden="true"
        tabIndex={-1}
        onChange={handleFileChange}
        // @ts-expect-error webkitdirectory is not in HTMLInputElement typedefs
        webkitdirectory=""
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Directory entry walker — used when a folder is drag-and-dropped
// ---------------------------------------------------------------------------

async function collectEntry(
  entry: FileSystemEntry,
  prefix: string,
  collected: File[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    await new Promise<void>((resolve, reject) => {
      fileEntry.file((file) => {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        // webkitRelativePath is read-only by spec, so we must use defineProperty.
        Object.defineProperty(file, 'webkitRelativePath', {
          value: relativePath,
          configurable: true,
        })
        collected.push(file)
        resolve()
      }, reject)
    })
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry
    const reader = dirEntry.createReader()
    const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    // readEntries only returns up to 100 entries per call on some browsers;
    // loop until an empty batch signals end of directory.
    let hasMore = true
    while (hasMore) {
      const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject)
      })
      hasMore = entries.length > 0
      for (const child of entries) {
        await collectEntry(child, childPrefix, collected)
      }
    }
  }
}
