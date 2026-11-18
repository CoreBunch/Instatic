/**
 * DropStep — the first step of the Super Import wizard.
 *
 * Accepts files via drag-and-drop, folder picker, or multi-file picker.
 * Handles directory entry walking for dropped folders. A single .zip file is
 * handed off as a File so the parent can route Instatic archives before static-
 * site ingestion; everything else is passed as a File array.
 *
 * A dropped plugin package is not imported: `pluginPackage` renders a notice
 * that says so and sends the owner to the Plugins page.
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
import { PackageSolidIcon } from 'pixel-art-icons/icons/package-solid'
import styles from './DropStep.module.css'

/** A plugin package (root `plugin.json`) the owner dropped into the importer. */
export interface DroppedPluginPackage {
  /** The dropped zip's file name; null for a dropped folder or loose files. */
  fileName: string | null
  /** The plugin's name from its manifest, when readable. */
  name: string | null
}

interface DropStepProps {
  /** True while the modal is ingesting + analyzing the dropped files. */
  busy: boolean
  /** Error message from the last ingest attempt, or null. Shown with role="alert". */
  errorMessage: string | null
  /** Set when the last drop was a plugin package rather than a site. */
  pluginPackage?: DroppedPluginPackage | null
  /** Whether the current user can install plugins (gates the Plugins button). */
  canInstallPlugins?: boolean
  /** Navigates to the Plugins page and closes the importer. */
  onOpenPlugins?: () => void
  /** Called when the user drops/picks loose files (non-zip). */
  onFilesReady: (files: File[]) => void
  /** Called when a single .zip was dropped or picked. */
  onZipReady: (zipFile: File) => void
}

export function DropStep({
  busy,
  errorMessage,
  pluginPackage = null,
  canInstallPlugins = false,
  onOpenPlugins,
  onFilesReady,
  onZipReady,
}: DropStepProps) {
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
      onZipReady(files[0])
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
        <p className={styles.dropHint}>HTML, CSS, images, fonts, and CMS bundles are supported</p>
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

      {pluginPackage && (
        <div className={styles.pluginNotice} role="status">
          <PackageSolidIcon size={18} aria-hidden="true" className={styles.pluginNoticeIcon} />
          <div className={styles.pluginNoticeText}>
            <p className={styles.pluginNoticeTitle}>
              {pluginPackage.name ?? pluginPackage.fileName ?? 'This folder'} is a plugin, not a site
            </p>
            <p className={styles.pluginNoticeBody}>
              {canInstallPlugins
                ? 'Nothing was imported. Plugins are installed from the Plugins page.'
                : 'Nothing was imported. Plugins are installed from the Plugins page, and your role can’t install them. Ask an administrator.'}
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={!canInstallPlugins}
            onClick={onOpenPlugins}
          >
            Go to Plugins
          </Button>
        </div>
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
