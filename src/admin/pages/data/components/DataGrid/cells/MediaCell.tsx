import { useState, type ReactElement } from 'react'
import { Button } from '@ui/components/Button'
import { Image } from '@ui/components/Image'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { ImageXSolidIcon } from 'pixel-art-icons/icons/image-x-solid'
import { readStringArrayCell } from '@core/data/cells'
import type { CmsMediaAsset } from '@core/persistence'
import { MediaPickerModal } from '@admin/pages/media/components/MediaPickerModal/MediaPickerModal'
import { useMediaAssetMap } from '@admin/pages/data/hooks/useMediaAssetMap'
import type { CellEditorProps } from '@admin/pages/data/types'
import type { DataField } from '@core/data/schemas'
import styles from './cells.module.css'

type MediaField = Extract<DataField, { type: 'media' }>

/** Resolve the picker kind, now including 'any' for fields with no kind constraint. */
function resolvePickerKind(field: MediaField): 'image' | 'video' | 'any' {
  if (field.mediaKind === 'video') return 'video'
  if (field.mediaKind === 'image') return 'image'
  return 'any'
}

/**
 * Filename to show for a single asset:
 *   - loading (undefined) → asset id as temporary label
 *   - missing (null)      → asset id as fallback
 *   - found               → asset.filename
 */
function resolveDisplayFilename(id: string, asset: CmsMediaAsset | null | undefined): string {
  return asset?.filename ?? id
}

// ---------------------------------------------------------------------------
// Thumbnail sub-component
// ---------------------------------------------------------------------------

interface MediaThumbProps {
  id: string
  asset: CmsMediaAsset | null | undefined
}

function MediaThumb({ id: _id, asset }: MediaThumbProps): ReactElement {
  if (asset === undefined) {
    // Still loading — dim placeholder square
    return <span className={styles.mediaThumb} aria-hidden="true" data-state="loading" />
  }
  if (asset === null) {
    // Confirmed missing
    return (
      <span className={styles.mediaThumb} aria-hidden="true" data-state="missing">
        <ImageXSolidIcon size={14} />
      </span>
    )
  }
  const isVideo = asset.mimeType.startsWith('video/')
  const isImage = asset.mimeType.startsWith('image/')
  if (isImage) {
    return (
      <span className={styles.mediaThumb} aria-hidden="true" data-state="image">
        {/* 28×28 thumb — `sizes="28px"` keeps the browser on the
            smallest variant from the asset's srcset ladder. */}
        <Image
          asset={asset}
          alt={asset.altText || asset.filename}
          sizes="28px"
          className={styles.mediaThumbImg}
        />
      </span>
    )
  }
  if (isVideo) {
    if (asset.posterPath) {
      return (
        <span className={styles.mediaThumb} aria-hidden="true" data-state="video">
          {/* Video poster ships only as `posterPath` — no variant
              ladder — so degrade to a plain <Image src=…>. */}
          <Image
            src={asset.posterPath}
            alt={asset.filename}
            sizes="28px"
            className={styles.mediaThumbImg}
          />
        </span>
      )
    }
    return (
      <span className={styles.mediaThumb} aria-hidden="true" data-state="video">
        <VideoSolidIcon size={14} />
      </span>
    )
  }
  // Generic file type
  return (
    <span className={styles.mediaThumb} aria-hidden="true" data-state="file">
      <ImageSolidIcon size={14} />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Multi-value preview — shows up to 2 thumbnails + overflow count
// Used only when field.allowMultiple === true.
// ---------------------------------------------------------------------------

function MediaPreviewMulti({
  ids,
  assetMap,
}: {
  ids: string[]
  assetMap: Map<string, CmsMediaAsset | null>
}): ReactElement {
  const maxVisible = 2
  const visible = ids.slice(0, maxVisible)
  const overflow = ids.length - maxVisible

  return (
    <span className={styles.mediaPreviews}>
      {visible.map((id) => (
        <MediaThumb key={id} id={id} asset={assetMap.get(id)} />
      ))}
      {overflow > 0 && (
        <span className={styles.mediaOverflow}>+{overflow}</span>
      )}
      <span className={styles.mediaCount}>{ids.length} selected</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// MediaCell
// ---------------------------------------------------------------------------

export function MediaCell({
  field,
  value,
  onChange,
  onCommit,
  readOnly,
  ariaLabel,
}: CellEditorProps<MediaField>): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false)

  const isMulti = field.allowMultiple === true

  const currentIds: string[] = isMulti
    ? readStringArrayCell({ [field.id]: value }, field.id)
    : typeof value === 'string'
      ? [value]
      : []

  const assetMap = useMediaAssetMap(currentIds)

  function handlePick(asset: CmsMediaAsset) {
    if (isMulti) {
      const next = currentIds.includes(asset.id)
        ? currentIds
        : [...currentIds, asset.id]
      onChange(next)
    } else {
      onChange(asset.id)
    }
    setPickerOpen(false)
    onCommit?.()
  }

  function handlePickMultiple(assets: CmsMediaAsset[]) {
    onChange(assets.map((asset) => asset.id))
    setPickerOpen(false)
    onCommit?.()
  }

  function handleClear() {
    onChange(isMulti ? [] : null)
    onCommit?.()
  }

  const hasValue = currentIds.length > 0
  const firstId = currentIds[0]
  // undefined = still loading, null = confirmed missing, CmsMediaAsset = resolved
  const firstAsset = firstId !== undefined ? assetMap.get(firstId) : undefined

  const ariaValueLabel = hasValue
    ? `${currentIds.length} file${currentIds.length === 1 ? '' : 's'}`
    : 'No media'
  const triggerAriaLabel = ariaLabel ?? `${field.label}: ${ariaValueLabel}`

  return (
    <>
      {/*
       * Layout: single non-wrapping flex row.
       *   [trigger button: grows]  [× dismiss: hidden until hover]
       *
       * The trigger button shows:
       *   - single mode + value:  [thumb] [filename]
       *   - multi mode + value:   [thumb] [thumb] [+N]
       *   - empty:                [icon]  [Add media…]
       */}
      <div className={styles.mediaCell}>
        <Button
          variant="ghost"
          size="sm"
          align="start"
          disabled={readOnly}
          aria-label={triggerAriaLabel}
          onClick={() => setPickerOpen(true)}
          className={styles.mediaTrigger}
        >
          {hasValue ? (
            isMulti ? (
              <MediaPreviewMulti ids={currentIds} assetMap={assetMap} />
            ) : (
              <>
                <MediaThumb id={firstId!} asset={firstAsset} />
                <span className={styles.mediaFilename}>
                  {resolveDisplayFilename(firstId!, firstAsset)}
                </span>
              </>
            )
          ) : (
            <>
              <ImageSolidIcon size={14} aria-hidden="true" />
              <span className={styles.mediaEmpty}>Add media…</span>
            </>
          )}
        </Button>

        {hasValue && !readOnly && (
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label="Clear media"
            tooltip="Clear media"
            onClick={handleClear}
            className={styles.mediaClearBtn}
          >
            <CloseIcon size={12} />
          </Button>
        )}
      </div>

      <MediaPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mediaKind={resolvePickerKind(field)}
        currentValue={!isMulti && firstId ? firstId : null}
        currentValues={isMulti ? currentIds : undefined}
        allowMultiple={isMulti}
        onPick={handlePick}
        onPickMultiple={handlePickMultiple}
      />
    </>
  )
}
