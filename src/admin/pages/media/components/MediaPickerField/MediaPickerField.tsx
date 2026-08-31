/**
 * MediaPickerField — shared media-picker affordance.
 *
 * One reusable surface for "currently picked media + Change / Edit / Clear"
 * actions. Used by:
 *   - `MediaLibraryControl` (Image module's `src`, Video module's `poster`
 *     and `videoUrl`) — wraps below the Library/URL segmented control.
 *   - `ContentSettingsPanel` (post Featured media on the Content page).
 *
 * Visual contract: the empty state and the populated state have the **same**
 * shape (border-radius, border style, height, paddings) so the field never
 * shifts when the user picks/clears the asset. Previous design used a dashed
 * border for the empty state and a solid one when populated — inconsistent.
 *
 * The field deliberately carries only the two actions that CANNOT be reached
 * anywhere else: change the value, and clear it. Everything that acts on the
 * asset itself — crop, replace, copy URL — lives in the viewer, which the tile
 * opens on click. This tile is 44px tall and sits in a narrow property panel;
 * stacking per-asset actions on top of it crowded the filename and put an
 * image-editing control somewhere too small to show the image being edited.
 *
 * The component is pure UI: callers own the picker modal and (optional)
 * MediaViewerWindow state. The component only emits `onBrowse` / `onEdit` /
 * `onClear` events.
 */
import { Button } from '@ui/components/Button'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { blurHashToDataUrl, pickVariantUrl } from '@admin/pages/media/utils/variants'
import { formatBytes } from '@admin/lib/formatBytes'
import styles from './MediaPickerField.module.css'

type MediaPickerFieldKind = 'image' | 'video'

interface MediaPickerFieldProps {
  /** Currently resolved asset, or `null` when empty / not yet loaded. */
  asset: CmsMediaAsset | null
  /**
   * Whether the field carries a value even when no asset is resolved. Lets
   * the tile render a non-empty "Saved reference" state when the asset list
   * is still loading or the asset has been removed.
   */
  hasValue: boolean
  /**
   * Optional plain string fallback shown under the filename when there is a
   * value but no resolved asset (e.g. a saved publicPath or a media ID).
   */
  fallbackLabel?: string
  /**
   * Image URL to preview when there is a value but no resolved asset row.
   * The saved path IS the image, so showing it beats a grey placeholder —
   * an unresolved asset is usually just a list that has not loaded yet, and
   * the author still needs to see WHICH picture is bound.
   */
  fallbackPreviewUrl?: string
  /** Optional fallback secondary line, defaults to "Saved reference". */
  fallbackHint?: string
  /** Media kind — drives the empty-state icon and labels. */
  mediaKind: MediaPickerFieldKind
  /**
   * Human label for the subject of the picker. Used to construct button
   * labels and aria-labels: "Change {subjectLabel}", "Clear {subjectLabel}",
   * "No {subjectLabel} selected". Defaults to the mediaKind ("image" or
   * "video").
   */
  subjectLabel?: string
  /** Open the picker modal. Always shown. */
  onBrowse: () => void
  /** Open the viewer to edit alt / caption / tags / file. Omit to hide. */
  onEdit?: () => void
  /** Clear the picked value. Omit to hide. */
  onClear?: () => void
  disabled?: boolean
  /**
   * Override for the empty-state browse button label (both visible text and
   * `aria-label`). Defaults to a visible "Browse library…" with an
   * `aria-label` of "Browse {subject} library" so the screen-reader hint
   * carries the kind. Passing an explicit value uses it for both.
   */
  chooseLabel?: string
  /**
   * Override for the populated-state browse button label. Defaults to
   * "Change {subject}" for both visible text and `aria-label`.
   */
  changeLabel?: string
}

export function MediaPickerField({
  asset,
  hasValue,
  fallbackLabel,
  fallbackHint = 'Saved reference',
  fallbackPreviewUrl,
  mediaKind,
  subjectLabel,
  onBrowse,
  onEdit,
  onClear,
  disabled = false,
  chooseLabel,
  changeLabel,
}: MediaPickerFieldProps) {
  const subject = subjectLabel ?? mediaKind
  const populated = asset !== null || hasValue
  const showClear = populated && Boolean(onClear)

  // Visible text + aria-label for the browse button. When a label override
  // is provided, it's used for both. Otherwise: visible text keeps the
  // historical "Browse library…" copy for the empty state (it reads better
  // in a tight property panel) while the aria-label carries the kind, so
  // screen readers still announce "Browse image library" / "Browse video
  // library" / "Browse featured media library".
  const browseVisible = populated
    ? (changeLabel ?? `Change ${subject}`)
    : (chooseLabel ?? `Browse library…`)
  const browseAria = populated
    ? (changeLabel ?? `Change ${subject}`)
    : (chooseLabel ?? `Browse ${subject} library`)

  // Whole-tile click target. When populated and an `onEdit` is wired, the
  // tile opens the viewer (edit alt/caption/tags); otherwise — including
  // every empty/unresolved state — it opens the picker so the author can
  // pick a different (or first) asset without hunting for the action
  // button. The tile keeps a distinct accessible name from the action
  // button so screen-reader / test queries that target one don't
  // accidentally pick up the other.
  const onTileClick = asset && onEdit ? onEdit : onBrowse
  const tileAria = asset && onEdit
    ? `Edit ${asset.filename} in viewer`
    : `Open the ${subject} library`
  const tileTooltip = asset && onEdit
    ? 'Click to edit this asset (alt text, caption, tags…)'
    : `Open the media library to ${populated ? 'pick a different' : 'pick a'} ${subject}`

  return (
    <div className={styles.field}>
      <div className={showClear && onClear ? `${styles.tileRow} ${styles.tileRowClearable}` : styles.tileRow}>
        <PickedTile
          asset={asset}
          hasValue={hasValue}
          fallbackLabel={fallbackLabel}
          fallbackHint={fallbackHint}
          fallbackPreviewUrl={fallbackPreviewUrl}
          mediaKind={mediaKind}
          subjectLabel={subject}
          onClick={disabled ? null : onTileClick}
          ariaLabel={tileAria}
          tooltip={tileTooltip}
        />
        {/*
          Clearing sits ON the row rather than in the button strip below: it
          is the one action that applies even when the asset row never
          resolved, which is exactly when the strip is least useful.
        */}
        {showClear && onClear && (
          <Button
            variant="ghost"
            size="xs"
            className={styles.clearButton}
            disabled={disabled}
            onClick={onClear}
            aria-label={`Clear ${subject}`}
            tooltip={`Clear ${subject}`}
          >
            <CloseIcon size={13} />
          </Button>
        )}
      </div>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onBrowse}
          aria-label={browseAria}
        >
          <ImagesSolidIcon size={13} />
          <span>{browseVisible}</span>
        </Button>
      </div>
    </div>
  )
}

interface PickedTileProps {
  asset: CmsMediaAsset | null
  hasValue: boolean
  fallbackLabel?: string
  fallbackHint: string
  fallbackPreviewUrl?: string
  mediaKind: MediaPickerFieldKind
  subjectLabel: string
  /**
   * Click handler — when set, the tile renders as a Button primitive. When
   * null, the tile is a non-interactive `<div>` (used when the field is
   * disabled).
   */
  onClick: (() => void) | null
  /** Accessible name for the tile button. */
  ariaLabel: string
  /** Hover tooltip text. */
  tooltip: string
}

function PickedTile({
  asset,
  hasValue,
  fallbackLabel,
  fallbackHint,
  fallbackPreviewUrl,
  mediaKind,
  subjectLabel,
  onClick,
  ariaLabel,
  tooltip,
}: PickedTileProps) {
  // Build the tile's inner content for the current state. The empty,
  // fallback, and populated branches all produce the same outer shell
  // (thumb + meta column) — only the inner text and the thumb contents
  // differ. The shell is then rendered as either a Button primitive
  // (clickable) or a `<div>` (disabled), keeping a single source of truth
  // for the layout.
  let body: React.ReactNode
  if (!asset && !hasValue) {
    // Empty.
    body = (
      <>
        <span className={styles.thumb} aria-hidden="true">
          {mediaKind === 'image' ? <ImagesSolidIcon size={18} /> : <VideoSolidIcon size={18} />}
        </span>
        <span className={styles.meta}>
          <span className={styles.empty}>No {subjectLabel} selected</span>
        </span>
      </>
    )
  } else if (!asset) {
    // Fallback: value saved but asset not yet resolved (loading or deleted).
    // The saved path is still a usable image URL, so prefer it over the
    // generic glyph — a broken path degrades to the browser's own missing-
    // image state, which is itself the useful signal.
    const showFallbackImage = mediaKind === 'image' && Boolean(fallbackPreviewUrl)
    body = (
      <>
        <span className={styles.thumb} aria-hidden="true">
          {showFallbackImage
            ? <img src={fallbackPreviewUrl} alt="" loading="lazy" decoding="async" />
            : mediaKind === 'image' ? <ImagesSolidIcon size={18} /> : <VideoSolidIcon size={18} />}
        </span>
        <span className={styles.meta}>
          <span className={styles.name}>{fallbackLabel ?? `Unresolved ${subjectLabel}`}</span>
          <span className={styles.sub}>{fallbackHint}</span>
        </span>
      </>
    )
  } else {
    // Populated.
    const thumbUrl = mediaKind === 'image' || asset.mimeType.startsWith('image/')
      ? pickVariantUrl(asset, 48)
      : null
    const blurUrl = thumbUrl ? blurHashToDataUrl(asset.blurHash) : null
    const thumbStyle = blurUrl
      ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as React.CSSProperties)
      : undefined
    const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : null
    const sizeLabel = asset.sizeBytes > 0 ? formatBytes(asset.sizeBytes) : null
    const subParts = [asset.mimeType, sizeLabel, dimensions]
      .filter(Boolean)
      .join(' · ')
    body = (
      <>
        <span className={styles.thumb} aria-hidden="true" style={thumbStyle}>
          {thumbUrl ? (
            <img src={thumbUrl} alt="" loading="lazy" decoding="async" />
          ) : (
            <VideoSolidIcon size={18} />
          )}
        </span>
        <span className={styles.meta}>
          <span className={styles.name}>{asset.filename}</span>
          {subParts && <span className={styles.sub}>{subParts}</span>}
        </span>
      </>
    )
  }

  if (onClick) {
    return (
      <Button
        variant="ghost"
        size="sm"
        shape="flush"
        align="start"
        className={styles.tileClickable}
        onClick={onClick}
        aria-label={ariaLabel}
        tooltip={tooltip}
      >
        {body}
      </Button>
    )
  }

  return <div className={styles.tile}>{body}</div>
}

