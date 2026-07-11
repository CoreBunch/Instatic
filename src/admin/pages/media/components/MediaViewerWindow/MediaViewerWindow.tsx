/**
 * MediaViewerWindow — the asset viewer / editor window.
 *
 * Replaces the docked right-sidebar inspector + the previous "Detached
 * Inspector" toggle. There's no docking concept anymore: every asset opens
 * in this window, and the user closes it when done.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ header — filename + drag handle + close X                │
 *   ├────────────────────────────────────┬─────────────────────┤
 *   │                                    │ Compact sidebar:    │
 *   │                                    │ • Title             │
 *   │  Viewer body (image/video/...)     │ • Filename          │
 *   │                                    │ • Alt + Caption     │
 *   │                                    │ • Tags              │
 *   │                                    │ • Folders           │
 *   │                                    │ • Details           │
 *   │                                    │ • Actions           │
 *   └────────────────────────────────────┴─────────────────────┘
 *
 * The whole window is draggable via the header. Position + open state are
 * persisted by `useDraggablePanel` under the `mediaDetachedInspector`
 * panel id (we keep the existing storage key so saved positions migrate
 * across the rename).
 */
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { Input, Textarea } from '@ui/components/Input'
import { canDeleteMedia, canReplaceMedia, canWriteMedia } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { ExternalLinkSolidIcon } from 'pixel-art-icons/icons/external-link-solid'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { PanelHeader } from '@admin/shared/PanelHeader'
import { useDraggablePanel } from '@admin/shared/FloatingWindow'
import type { CmsMediaAsset, CmsMediaFolder, UpdateCmsMediaAssetInput } from '@core/persistence/cmsMedia'
import { bucketForMime } from '../../utils/filters'
import { useDebouncedSave } from '../../hooks/useDebouncedSave'
import { TagEditor } from '../TagEditor/TagEditor'
import { ReplaceFileDialog } from '../ReplaceFileDialog/ReplaceFileDialog'
import { ViewerBody } from '../viewers/ViewerBody'
import { formatBytes } from '../../utils/formatBytes'
import styles from './MediaViewerWindow.module.css'

/**
 * Minimal contract the viewer needs. Built once for the Media page (from
 * useMediaWorkspace) and once for the docked MediaExplorerPanel (from a
 * tiny single-asset adapter), so the same viewer renders in every place
 * the user can interact with an asset.
 */
export interface MediaAssetEditor {
  asset: CmsMediaAsset
  /** Existing tag palette across the library — feeds TagEditor autocomplete. */
  tagPalette: string[]
  /** Folder lookup so the viewer can label folder chips by name. */
  folderById: Map<string, CmsMediaFolder>
  updateAsset: (id: string, input: UpdateCmsMediaAssetInput) => Promise<CmsMediaAsset | null>
  renameAsset: (id: string, filename: string) => Promise<CmsMediaAsset | null>
  replaceAssetFile: (id: string, file: File) => Promise<CmsMediaAsset | null>
  restoreAsset: (id: string) => Promise<unknown>
  purgeAsset: (id: string) => Promise<void>
}

interface MediaViewerWindowProps {
  editor: MediaAssetEditor | null
  open: boolean
  onClose: () => void
}

export function MediaViewerWindow({ editor, open, onClose }: MediaViewerWindowProps) {
  if (!open || !editor) return null
  // Key by asset id so switching to a different asset remounts the inner
  // state (debounced-save hooks reset cleanly).
  return <ViewerForAsset key={editor.asset.id} editor={editor} onClose={onClose} />
}

interface ViewerForAssetProps {
  editor: MediaAssetEditor
  onClose: () => void
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function ViewerForAsset({ editor, onClose }: ViewerForAssetProps) {
  const currentUser = useCurrentAdminUser()
  const { asset } = editor
  const [replaceOpen, setReplaceOpen] = useState(false)
  const bucket = bucketForMime(asset.mimeType)
  const canWrite = canWriteMedia(currentUser)
  const canReplace = canReplaceMedia(currentUser)
  const canDelete = canDeleteMedia(currentUser)

  // Persistent window position — same key the old detached inspector used,
  // so saved positions carry over for users who already moved it.
  const { setPanelRef, headerDragProps, panelPositionStyle } = useDraggablePanel(
    'mediaDetachedInspector',
    () => ({ x: window.innerWidth - 880, y: 80 }),
  )

  // ── Save callbacks ────────────────────────────────────────────────────────
  const saveTitle = async (next: string) => {
    if (!canWrite) return
    await editor.updateAsset(asset.id, { title: next })
  }
  const saveFilename = async (next: string) => {
    if (!canWrite) return
    if (!next.trim()) return
    await editor.renameAsset(asset.id, next.trim())
  }
  const saveAltText = async (next: string) => {
    if (!canWrite) return
    await editor.updateAsset(asset.id, { altText: next })
  }
  const saveCaption = async (next: string) => {
    if (!canWrite) return
    await editor.updateAsset(asset.id, { caption: next })
  }
  const saveTags = async (next: string[]) => {
    if (!canWrite) return
    await editor.updateAsset(asset.id, { tags: next })
  }

  const titleField = useDebouncedSave({ value: asset.title, save: saveTitle })
  const filenameField = useDebouncedSave({ value: asset.filename, save: saveFilename })
  const altField = useDebouncedSave({ value: asset.altText, save: saveAltText })
  const captionField = useDebouncedSave({ value: asset.caption, save: saveCaption })
  const tagsField = useDebouncedSave({
    value: asset.tags,
    save: saveTags,
    equals: arraysEqual,
    delay: 200,
  })

  const copyUrl = async () => {
    if (!navigator.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(asset.publicPath)
    } catch (err) {
      console.error('[MediaViewerWindow] copy URL failed:', err)
    }
  }

  const folderNames = asset.folderIds
    .map((id) => editor.folderById.get(id)?.name ?? null)
    .filter((name): name is string => name !== null)

  return createPortal(
    <aside
      ref={setPanelRef}
      className={styles.window}
      role="dialog"
      aria-label={`Viewer: ${asset.filename}`}
      data-testid="media-viewer-window"
      style={panelPositionStyle}
      onClick={(event) => event.stopPropagation()}
    >
      <PanelHeader
        panelId="mediaDetachedInspector"
        title={asset.filename}
        onClose={onClose}
        dragHandleProps={headerDragProps}
      />

      <div className={styles.body}>
        <div className={styles.viewer}>
          <ViewerBody asset={asset} />
        </div>

        <aside className={styles.sidebar} aria-label="Asset metadata">
          <Section>
            <Field label="Title">
              <Input
                value={titleField.local}
                onChange={(e) => titleField.setLocal(e.target.value)}
                onBlur={() => void titleField.flush()}
                placeholder="Untitled"
                aria-label="Title"
                disabled={!canWrite}
              />
            </Field>
            <Field label="Filename">
              <Input
                value={filenameField.local}
                onChange={(e) => filenameField.setLocal(e.target.value)}
                onBlur={() => void filenameField.flush()}
                aria-label="Filename"
                disabled={!canWrite}
              />
            </Field>
          </Section>

          <Section>
            <div className={styles.actionsRow}>
              <Button
                variant="ghost"
                size="xs"
                aria-label="Copy public URL"
                onClick={() => void copyUrl()}
              >
                <Copy2SolidIcon size={13} />
                <span>Copy URL</span>
              </Button>
              <Button
                variant="ghost"
                size="xs"
                aria-label="Open in new tab"
                onClick={() => window.open(asset.publicPath, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLinkSolidIcon size={13} />
                <span>Open</span>
              </Button>
              {canReplace && (
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label="Replace file"
                  onClick={() => setReplaceOpen(true)}
                  disabled={asset.deletedAt !== null}
                >
                  <ReloadIcon size={13} />
                  <span>Replace</span>
                </Button>
              )}
            </div>
          </Section>

          {bucket === 'image' && (
            <Section title="Accessibility">
              <Field label="Alt text">
                <Textarea
                  value={altField.local}
                  onChange={(e) => altField.setLocal(e.target.value)}
                  onBlur={() => void altField.flush()}
                  placeholder="Describe the image for screen readers"
                  aria-label="Alt text"
                  rows={2}
                  disabled={!canWrite}
                />
              </Field>
              <Field label="Caption">
                <Textarea
                  value={captionField.local}
                  onChange={(e) => captionField.setLocal(e.target.value)}
                  onBlur={() => void captionField.flush()}
                  placeholder="Optional caption"
                  aria-label="Caption"
                  rows={2}
                  disabled={!canWrite}
                />
              </Field>
            </Section>
          )}

          <Section title="Tags">
            <TagEditor
              value={tagsField.local}
              onChange={(next) => tagsField.setLocal(next)}
              palette={editor.tagPalette}
              disabled={!canWrite}
            />
          </Section>

          <Section title="Details">
            <dl className={styles.detailList}>
              <Detail
                label="Type"
                value={asset.mimeType}
                icon={bucket === 'video' ? <VideoSolidIcon size={12} /> : null}
              />
              <Detail label="Size" value={formatBytes(asset.sizeBytes)} />
              {asset.width !== null && asset.height !== null && (
                <Detail label="Dimensions" value={`${asset.width} × ${asset.height}`} />
              )}
              {asset.durationMs !== null && (
                <Detail label="Duration" value={`${(asset.durationMs / 1000).toFixed(1)}s`} />
              )}
              <Detail label="Uploaded" value={formatDate(asset.createdAt)} />
              {asset.replacedAt && (
                <Detail label="Replaced" value={formatDate(asset.replacedAt)} />
              )}
            </dl>
          </Section>

          <Section title="Folders">
            {folderNames.length === 0 ? (
              <p className={styles.placeholder}>Uncategorized</p>
            ) : (
              <ul className={styles.folderList} aria-label="Asset folders">
                {folderNames.map((name) => (
                  <li key={name} className={styles.folderChip}>{name}</li>
                ))}
              </ul>
            )}
          </Section>

          {asset.deletedAt && (
            <Section>
              <p className={styles.warning} role="status">
                In Trash since {formatDate(asset.deletedAt)}
              </p>
              <div className={styles.actionsRow}>
                {canWrite && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void editor.restoreAsset(asset.id)}
                  >
                    Restore
                  </Button>
                )}
                {canDelete && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void editor.purgeAsset(asset.id)}
                  >
                    <TrashSolidIcon size={13} />
                    <span>Delete permanently</span>
                  </Button>
                )}
              </div>
            </Section>
          )}
        </aside>
      </div>

      {canReplace && (
        <ReplaceFileDialog
          asset={asset}
          open={replaceOpen}
          onClose={() => setReplaceOpen(false)}
          onReplace={(file) => editor.replaceAssetFile(asset.id, file)}
        />
      )}
    </aside>,
    document.body,
  )
}

interface SectionProps {
  title?: string
  children: ReactNode
}

function Section({ title, children }: SectionProps) {
  return (
    <section className={styles.section}>
      {title && <h3 className={styles.sectionTitle}>{title}</h3>}
      {children}
    </section>
  )
}

interface FieldProps {
  label: string
  children: ReactNode
}

function Field({ label, children }: FieldProps) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  )
}

interface DetailProps {
  label: string
  value: string
  icon?: ReactNode
}

function Detail({ label, value, icon }: DetailProps) {
  return (
    <div className={styles.detailRow}>
      <dt className={styles.detailLabel}>{label}</dt>
      <dd className={styles.detailValue}>
        {icon}
        <span>{value}</span>
      </dd>
    </div>
  )
}
