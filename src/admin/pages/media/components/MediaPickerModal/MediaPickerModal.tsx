/**
 * MediaPickerModal — WordPress-style fullscreen picker.
 *
 * Replaces the cramped 280-px property-panel media picker. Hosts the same
 * folder tree + canvas grid + asset summary the Media page uses, but inside
 * a Dialog with a clear "Use selected" / "Cancel" footer.
 *
 * Constraints vs the standalone Media page:
 *   - Selection can be single or multi, but bulk-edit actions stay out.
 *   - Filtered to one media kind (`image` or `video`) so the user can't
 *     accidentally pick a video for an image slot.
 *   - No floating windows mount here (no viewer, no upload queue, no bulk
 *     edit) — the modal is the surface.
 *   - The workspace hook is mounted internally so each picker session has
 *     its own folder selection / scroll position / filter state without
 *     leaking into the Media page if it's open elsewhere.
 */
import { useEffect, useEffectEvent, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { MediaSidebar, type MediaSidebarPanelId } from '../MediaSidebar/MediaSidebar'
import { MediaCanvas } from '../MediaCanvas/MediaCanvas'
import { useMediaWorkspace } from '../../hooks/useMediaWorkspace'
import { bucketForMime, isSvgMime } from '../../utils/filters'

/** Modal heading / aria-label for the requested media kind. */
function pickerTitle(kind: 'image' | 'video' | 'svg' | 'any'): string {
  switch (kind) {
    case 'image': return 'Select an image'
    case 'video': return 'Select a video'
    case 'svg': return 'Select an SVG'
    default: return 'Select media'
  }
}
import { blurHashToDataUrl, pickVariantUrl } from '../../utils/variants'
import styles from './MediaPickerModal.module.css'

interface MediaPickerModalProps {
  open: boolean
  onClose: () => void
  /**
   * Constrain the picker to a single media kind, or pass `'any'` to show
   * all asset types without filtering. `'svg'` narrows to SVG files only
   * (used by the inline-SVG module's "From library").
   */
  mediaKind: 'image' | 'video' | 'svg' | 'any'
  /**
   * Public path of the currently-picked asset, if any. Used to seed the
   * picker's selection so re-opening the picker for an already-picked
   * field highlights the right tile immediately.
   */
  currentValue?: string | null
  /** Existing ids or public paths for a multi-value field. */
  currentValues?: string[]
  /** Plain click toggles assets and the footer commits the whole selection. */
  allowMultiple?: boolean
  /** Called when the user clicks "Use selected" with a valid pick. */
  onPick: (asset: CmsMediaAsset) => void
  onPickMultiple?: (assets: CmsMediaAsset[]) => void
}

export function MediaPickerModal({
  open,
  onClose,
  mediaKind,
  currentValue,
  currentValues,
  allowMultiple = false,
  onPick,
  onPickMultiple,
}: MediaPickerModalProps) {
  // The picker mounts/unmounts; the workspace hook lives only while open.
  // That avoids loading folders + assets at startup of every editor session.
  if (!open) return null
  return (
    <MediaPickerModalBody
      onClose={onClose}
      mediaKind={mediaKind}
      currentValue={currentValue}
      currentValues={currentValues}
      allowMultiple={allowMultiple}
      onPick={onPick}
      onPickMultiple={onPickMultiple}
    />
  )
}

function MediaPickerModalBody({
  onClose,
  mediaKind,
  currentValue,
  currentValues,
  allowMultiple = false,
  onPick,
  onPickMultiple,
}: Omit<MediaPickerModalProps, 'open'>) {
  const workspace = useMediaWorkspace()
  const [activePanel, setActivePanel] = useState<MediaSidebarPanelId | null>('folders')

  // Constrain the canvas to the requested media kind so an image control
  // can't accidentally pick a video. useEffectEvent reads the latest
  // workspace.setFilterType without putting `workspace` in the dep array
  // (which would re-fire on every workspace state change).
  const applyMediaKind = useEffectEvent((kind: 'image' | 'video' | 'svg' | 'any') => {
    workspace.setFilterType(kind === 'any' ? 'all' : kind)
  })
  useEffect(() => {
    applyMediaKind(mediaKind)
  }, [mediaKind])

  // Seed the picker selection from the field's current value (matches by
  // publicPath since that's what the module prop stores). useEffectEvent
  // reads latest workspace.assets + setter without adding workspace to deps.
  const currentSelectionKey = allowMultiple
    ? JSON.stringify(currentValues ?? [])
    : JSON.stringify(currentValue ? [currentValue] : [])
  const seedCurrentSelection = useEffectEvent(() => {
    const values = allowMultiple ? (currentValues ?? []) : currentValue ? [currentValue] : []
    const matches = values
      .map((value) => workspace.assets.find(
        (asset) => asset.id === value || asset.publicPath === value,
      )?.id)
      .filter((id): id is string => id !== undefined)
    if (matches.length === 0) return
    if (allowMultiple) workspace.addToSelection(matches)
    else workspace.setSelectedAssetId(matches[0] ?? null)
  })
  useEffect(() => {
    if (currentSelectionKey === '[]') return
    seedCurrentSelection()
  }, [currentSelectionKey, workspace.assets])

  // Close on Escape — matches Dialog primitive behavior. We don't use the
  // Dialog primitive itself because we need a much larger surface than
  // its `xl` cap (640px).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const picked = workspace.selectedAsset
  const pickedMatchesKind = picked
    ? mediaKind === 'any' ||
      (mediaKind === 'svg'
        ? isSvgMime(picked.mimeType)
        : bucketForMime(picked.mimeType) === mediaKind)
    : false
  const canCommit = picked !== null && pickedMatchesKind
  const pickedMany = workspace.selectedAssets.filter((asset) =>
    mediaKind === 'any' ||
    (mediaKind === 'svg'
      ? isSvgMime(asset.mimeType)
      : bucketForMime(asset.mimeType) === mediaKind),
  )
  const canCommitMany = allowMultiple && pickedMany.length > 0

  function commit() {
    if (allowMultiple) {
      if (!canCommitMany) return
      onPickMultiple?.(pickedMany)
      onClose()
      return
    }
    if (!picked || !pickedMatchesKind) return
    onPick(picked)
    onClose()
  }

  return createPortal(
    <div
      className={styles.backdrop}
      role="presentation"
      onClick={(event) => {
        // Click outside the dialog body closes — matches every other modal
        // in the editor.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={pickerTitle(mediaKind)}
        data-testid="media-picker-modal"
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{pickerTitle(mediaKind)}</h2>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Close picker"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </Button>
        </header>

        <div className={styles.body}>
          <MediaSidebar
            workspace={workspace}
            activePanel={activePanel}
            onActivePanelChange={setActivePanel}
          />
          <div className={styles.canvasArea}>
            <MediaCanvas workspace={workspace} selectionMode={allowMultiple ? 'multiple' : 'standard'} />
          </div>
        </div>

        <footer className={styles.footer}>
          <PickedSummary
            asset={allowMultiple ? (pickedMany.at(-1) ?? null) : picked}
            matchesKind={allowMultiple ? pickedMany.length > 0 : pickedMatchesKind}
            mediaKind={mediaKind}
            selectionCount={allowMultiple ? pickedMany.length : picked ? 1 : 0}
          />
          <div className={styles.footerActions}>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={allowMultiple ? !canCommitMany : !canCommit}
              onClick={commit}
            >
              {allowMultiple && pickedMany.length > 0
                ? `Use ${pickedMany.length} selected`
                : 'Use selected'}
            </Button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

interface PickedSummaryProps {
  asset: CmsMediaAsset | null
  matchesKind: boolean
  mediaKind: 'image' | 'video' | 'svg' | 'any'
  selectionCount: number
}

/**
 * Bottom-left summary of the currently-picked asset. Loud preview + filename
 * so the user has zero doubt about what "Use selected" will commit to — the
 * exact gap the cramped sidebar picker had ("not clear which media is
 * picked").
 */
function PickedSummary({ asset, matchesKind, mediaKind, selectionCount }: PickedSummaryProps) {
  const summary = asset
    ? {
        bucket: bucketForMime(asset.mimeType),
        thumbUrl: bucketForMime(asset.mimeType) === 'image' ? pickVariantUrl(asset, 56) : null,
        blurUrl: bucketForMime(asset.mimeType) === 'image' ? blurHashToDataUrl(asset.blurHash) : null,
      }
    : null

  if (!asset) {
    const kindLabel = mediaKind === 'image' ? 'image' : mediaKind === 'video' ? 'video' : mediaKind === 'svg' ? 'SVG' : 'asset'
    return (
      <p className={styles.pickedEmpty}>
        No {kindLabel} selected — pick {selectionCount === 0 ? 'one' : 'from the grid'}.
      </p>
    )
  }

  return (
    <div className={styles.picked}>
      <span
        className={styles.pickedPreview}
        aria-hidden="true"
        style={summary?.blurUrl ? {
          backgroundImage: `url(${summary.blurUrl})`,
          backgroundSize: 'cover',
        } : undefined}
      >
        {summary?.bucket === 'image' && summary.thumbUrl ? (
          <img src={summary.thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : summary?.bucket === 'video' ? (
          <video src={asset.publicPath} preload="metadata" muted />
        ) : null}
      </span>
      <span className={styles.pickedMeta}>
        <span className={styles.pickedName}>{asset.filename}</span>
        {selectionCount > 1 && (
          <span className={styles.pickedCount}>{selectionCount} assets selected</span>
        )}
        {!matchesKind && mediaKind !== 'any' && (
          <span className={styles.pickedWrongKind} role="alert">
            This is not {mediaKind === 'image' ? 'an image' : mediaKind === 'video' ? 'a video' : mediaKind === 'svg' ? 'an SVG' : 'a matching'} asset.
          </span>
        )}
      </span>
    </div>
  )
}
