/**
 * BulkEditWindow — floating panel shown when 2+ assets are selected. Lets
 * the user batch-apply alt text, tag additions/removals, folder
 * additions/removals, and bulk trash/restore actions without losing the
 * canvas selection state.
 *
 * Each mutation is applied per-asset client-side via the existing single-
 * asset endpoints. The window keeps a local "operations" pending state so
 * the user composes a batch, hits "Apply", and we run them in series with
 * a small progress badge.
 */
import { useState } from 'react'
import { Button } from '@ui/components/Button'
import { Input, Textarea } from '@ui/components/Input'
import { canDeleteMedia, canWriteMedia } from '@admin/access'
import { useCurrentAdminUser } from '@admin/sessionContext'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ReloadIcon } from 'pixel-art-icons/icons/reload'
import type { CmsMediaFolder } from '@core/persistence/cmsMedia'
import { FloatingWindow } from '@admin/shared/FloatingWindow'
import { TagEditor } from '../TagEditor/TagEditor'
import type { UseMediaWorkspaceResult } from '../../hooks/useMediaWorkspace'
import styles from './BulkEditWindow.module.css'

interface BulkEditWindowProps {
  workspace: UseMediaWorkspaceResult
  open: boolean
  onClose: () => void
}

interface BatchPlan {
  altText: string | null
  addTags: string[]
  removeTags: string[]
  addFolders: string[]
  removeFolders: string[]
}

const EMPTY_PLAN: BatchPlan = {
  altText: null,
  addTags: [],
  removeTags: [],
  addFolders: [],
  removeFolders: [],
}

function planHasChanges(plan: BatchPlan): boolean {
  return (
    plan.altText !== null ||
    plan.addTags.length > 0 ||
    plan.removeTags.length > 0 ||
    plan.addFolders.length > 0 ||
    plan.removeFolders.length > 0
  )
}

// Module-level helpers — extracted so the React Compiler can compile the
// component body (it bails on try/finally inside component/hook bodies).

async function runApplyPlan(
  plan: BatchPlan,
  assets: UseMediaWorkspaceResult['selectedAssets'],
  workspace: UseMediaWorkspaceResult,
  setBusy: (v: boolean) => void,
  setProgress: (v: { done: number; total: number } | null) => void,
  resetPlan: () => void,
): Promise<void> {
  const count = assets.length
  try {
    let done = 0
    for (const asset of assets) {
      const patch: Parameters<typeof workspace.updateAsset>[1] = {}
      if (plan.altText !== null && asset.mimeType.startsWith('image/')) {
        patch.altText = plan.altText
      }
      if (plan.addTags.length > 0 || plan.removeTags.length > 0) {
        const nextTags = Array.from(new Set([
          ...asset.tags.filter((tag) => !plan.removeTags.includes(tag)),
          ...plan.addTags,
        ])).sort()
        patch.tags = nextTags
      }
      if (Object.keys(patch).length > 0) {
        await workspace.updateAsset(asset.id, patch)
      }
      if (plan.addFolders.length > 0 || plan.removeFolders.length > 0) {
        await workspace.setAssetFolders(asset.id, {
          add: plan.addFolders.length > 0 ? plan.addFolders : undefined,
          remove: plan.removeFolders.length > 0 ? plan.removeFolders : undefined,
        })
      }
      done += 1
      setProgress({ done, total: count })
    }
    resetPlan()
  } finally {
    setBusy(false)
    // Hold the progress badge for a beat so the user sees the completion.
    setTimeout(() => setProgress(null), 800)
  }
}

async function runTrashAll(
  assets: UseMediaWorkspaceResult['selectedAssets'],
  workspace: UseMediaWorkspaceResult,
  setBusy: (v: boolean) => void,
  setProgress: (v: { done: number; total: number } | null) => void,
): Promise<void> {
  const count = assets.length
  try {
    let done = 0
    for (const asset of assets) {
      await workspace.trashAsset(asset.id)
      done += 1
      setProgress({ done, total: count })
    }
  } finally {
    setBusy(false)
    setTimeout(() => setProgress(null), 800)
  }
}

async function runRestoreAll(
  assets: UseMediaWorkspaceResult['selectedAssets'],
  workspace: UseMediaWorkspaceResult,
  setBusy: (v: boolean) => void,
  setProgress: (v: { done: number; total: number } | null) => void,
): Promise<void> {
  const count = assets.length
  try {
    let done = 0
    for (const asset of assets) {
      await workspace.restoreAsset(asset.id)
      done += 1
      setProgress({ done, total: count })
    }
  } finally {
    setBusy(false)
    setTimeout(() => setProgress(null), 800)
  }
}

export function BulkEditWindow({ workspace, open, onClose }: BulkEditWindowProps) {
  const currentUser = useCurrentAdminUser()
  const [plan, setPlan] = useState<BatchPlan>(EMPTY_PLAN)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const assets = workspace.selectedAssets
  const count = assets.length
  const allImages = assets.every((a) => a.mimeType.startsWith('image/'))
  const canWrite = canWriteMedia(currentUser)
  const canDelete = canDeleteMedia(currentUser)

  function resetPlan() {
    setPlan(EMPTY_PLAN)
  }

  async function applyPlan() {
    if (!canWrite || !planHasChanges(plan) || busy) return
    setBusy(true)
    setProgress({ done: 0, total: count })
    await runApplyPlan(plan, assets, workspace, setBusy, setProgress, resetPlan)
  }

  async function trashAll() {
    if (!canDelete || busy) return
    setBusy(true)
    setProgress({ done: 0, total: count })
    await runTrashAll(assets, workspace, setBusy, setProgress)
  }

  async function restoreAll() {
    if (!canWrite || busy) return
    setBusy(true)
    setProgress({ done: 0, total: count })
    await runRestoreAll(assets, workspace, setBusy, setProgress)
  }

  const anyTrashed = assets.some((a) => a.deletedAt !== null)
  const anyActive = assets.some((a) => a.deletedAt === null)

  return (
    <FloatingWindow
      panelId="mediaBulkEdit"
      open={open}
      onClose={onClose}
      title={`Bulk edit · ${count} selected`}
      defaultPosition={{ x: 24, y: 120 }}
      width={360}
      maxHeight={560}
      ariaLabel="Bulk edit selected media"
      testId="media-bulk-edit"
    >
      <p className={styles.help}>
        Edits apply to all <strong>{count}</strong> selected items. Tag changes are union/diff
        — adds merge with each asset's existing tags, removes only drop matching tags.
      </p>

      {!canWrite && (
        <p className={styles.notice} role="status">
          Media metadata and folder edits are read-only for your role.
        </p>
      )}

      {canWrite && !allImages && (
        <p className={styles.notice} role="status">
          Alt text is only applied to image assets in the selection.
        </p>
      )}

      {canWrite && (
        <>
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Alt text</h3>
            <Textarea
              value={plan.altText ?? ''}
              onChange={(e) => setPlan((prev) => ({ ...prev, altText: e.target.value || null }))}
              placeholder={plan.altText === null ? 'Leave existing alt text untouched' : ''}
              rows={2}
              aria-label="Bulk alt text"
            />
            {plan.altText !== null && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setPlan((prev) => ({ ...prev, altText: null }))}
              >
                Don't change
              </Button>
            )}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Add tags</h3>
            <TagEditor
              value={plan.addTags}
              onChange={(next) => setPlan((prev) => ({ ...prev, addTags: next }))}
              palette={workspace.tagPalette}
              placeholder="Tags to add"
            />
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Remove tags</h3>
            <TagEditor
              value={plan.removeTags}
              onChange={(next) => setPlan((prev) => ({ ...prev, removeTags: next }))}
              palette={workspace.tagPalette}
              placeholder="Tags to remove"
            />
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Folders</h3>
            <FolderPicker
              label="Add to folders"
              selected={plan.addFolders}
              onChange={(next) => setPlan((prev) => ({ ...prev, addFolders: next }))}
              folders={workspace.folders}
            />
            <FolderPicker
              label="Remove from folders"
              selected={plan.removeFolders}
              onChange={(next) => setPlan((prev) => ({ ...prev, removeFolders: next }))}
              folders={workspace.folders}
            />
          </section>

          <div className={styles.applyRow}>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetPlan}
              disabled={busy || !planHasChanges(plan)}
            >
              Reset
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void applyPlan()}
              disabled={busy || !planHasChanges(plan)}
            >
              {busy && progress ? `Applying ${progress.done}/${progress.total}…` : (
                <>
                  <CheckIcon size={13} />
                  <span>Apply to {count}</span>
                </>
              )}
            </Button>
          </div>
        </>
      )}

      {(canDelete || canWrite) && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Actions</h3>
          <div className={styles.actionsRow}>
            {canDelete && anyActive && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void trashAll()}
                disabled={busy}
              >
                <TrashSolidIcon size={13} />
                <span>Move to Trash</span>
              </Button>
            )}
            {canWrite && anyTrashed && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void restoreAll()}
                disabled={busy}
              >
                <ReloadIcon size={13} />
                <span>Restore</span>
              </Button>
            )}
          </div>
        </section>
      )}
    </FloatingWindow>
  )
}

interface FolderPickerProps {
  label: string
  selected: string[]
  onChange: (next: string[]) => void
  folders: CmsMediaFolder[]
}

function FolderPicker({ label, selected, onChange, folders }: FolderPickerProps) {
  const [draft, setDraft] = useState('')
  const needle = draft.trim().toLowerCase()
  const matches = folders
    .filter((folder) => !selected.includes(folder.id))
    .filter((folder) => !needle || folder.name.toLowerCase().includes(needle))
    .slice(0, 6)

  function pick(folder: CmsMediaFolder) {
    onChange([...selected, folder.id])
    setDraft('')
  }

  function remove(folderId: string) {
    onChange(selected.filter((id) => id !== folderId))
  }

  return (
    <div className={styles.folderPicker}>
      <span className={styles.folderPickerLabel}>{label}</span>
      <ul className={styles.folderChips} aria-label={label}>
        {selected.map((id) => {
          const folder = folders.find((f) => f.id === id)
          if (!folder) return null
          return (
            <li key={id} className={styles.folderChip}>
              <FolderGlyphIcon size={11} />
              <span>{folder.name}</span>
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label={`Remove ${folder.name}`}
                onClick={() => remove(id)}
              >
                <CloseIcon size={10} />
              </Button>
            </li>
          )
        })}
      </ul>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search folders…"
        aria-label={`Add ${label.toLowerCase()}`}
      />
      {matches.length > 0 && (
        <ul className={styles.suggestions} aria-label="Matching folders">
          {matches.map((folder) => (
            <li key={folder.id}>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => pick(folder)}
                className={styles.suggestion}
              >
                <FolderGlyphIcon size={11} />
                <span>{folder.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
