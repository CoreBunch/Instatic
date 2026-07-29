import { useState, type ReactElement } from 'react'
import { nanoid } from 'nanoid'
import { Button } from '@ui/components/Button'
import { ArrowDownIcon } from 'pixel-art-icons/icons/arrow-down'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { ImageXSolidIcon } from 'pixel-art-icons/icons/image-x-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import type { CmsMediaAsset } from '@core/persistence'
import type {
  DataField,
  RepeaterItem,
  RepeaterItemField,
} from '@core/data/schemas'
import { MediaPickerModal } from '@admin/pages/media/components/MediaPickerModal/MediaPickerModal'
import {
  AssetRow,
  AssetTile,
} from '@admin/pages/media/components/MediaCanvas/MediaCanvasItems'
import mediaCanvasStyles from '@admin/pages/media/components/MediaCanvas/MediaCanvas.module.css'
import {
  readStoredMediaViewMode,
  writeStoredMediaViewMode,
  type MediaViewMode,
} from '@admin/pages/media/utils/viewMode'
import { useMediaAssetMap } from '@admin/pages/data/hooks/useMediaAssetMap'
import { useConfirmDelete } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import styles from './cells.module.css'

type RepeaterField = Extract<DataField, { type: 'repeater' }>
type RepeaterMediaField = Extract<RepeaterItemField, { type: 'media' }>

interface MediaRepeaterGalleryProps {
  field: RepeaterField
  mediaField: RepeaterMediaField
  items: RepeaterItem[]
  readOnly?: boolean
  onChange: (items: RepeaterItem[]) => void
  onCommit?: () => void
}

type PickerState =
  | { mode: 'add' }
  | { mode: 'replace'; itemId: string }
  | null

function mediaIdForItem(item: RepeaterItem, mediaField: RepeaterMediaField): string | null {
  const value = item.cells[mediaField.id]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function pickerKind(field: RepeaterMediaField): 'image' | 'video' | 'any' {
  if (field.mediaKind === 'image') return 'image'
  if (field.mediaKind === 'video') return 'video'
  return 'any'
}

function GalleryItemActions({
  index,
  count,
  label,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  label: string
  onMove: (offset: -1 | 1) => void
  onRemove: () => void
}): ReactElement {
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        type="button"
        aria-label={`Move ${label} up`}
        tooltip="Move up"
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUpIcon size={11} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        type="button"
        aria-label={`Move ${label} down`}
        tooltip="Move down"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDownIcon size={11} aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="xs"
        iconOnly
        tone="danger"
        type="button"
        aria-label={`Remove ${label}`}
        tooltip="Remove from gallery"
        onClick={onRemove}
      >
        <TrashSolidIcon size={11} aria-hidden="true" />
      </Button>
    </>
  )
}

function EmptyGalleryItem({
  index,
  count,
  viewMode,
  state,
  readOnly,
  onChoose,
  onMove,
  onRemove,
}: {
  index: number
  count: number
  viewMode: MediaViewMode
  state: 'empty' | 'loading' | 'missing'
  readOnly: boolean
  onChoose: () => void
  onMove: (offset: -1 | 1) => void
  onRemove: () => void
}): ReactElement {
  const label = state === 'loading'
    ? 'Loading image…'
    : state === 'missing'
      ? 'Missing media'
      : 'Choose media'
  const Icon = state === 'missing' ? ImageXSolidIcon : ImageSolidIcon
  const grid = viewMode === 'grid'
  const itemLabel = `gallery item ${index + 1}`

  return (
    <li
      className={grid ? mediaCanvasStyles.tileItem : mediaCanvasStyles.rowItem}
      data-has-actions={!readOnly ? 'true' : undefined}
    >
      <Button
        variant="ghost"
        size="sm"
        disabled={readOnly || state === 'loading'}
        aria-label={`${label} for ${itemLabel}`}
        className={grid ? mediaCanvasStyles.tile : mediaCanvasStyles.row}
        onClick={onChoose}
      >
        <span
          className={grid ? mediaCanvasStyles.tilePreview : mediaCanvasStyles.rowPreview}
          aria-hidden="true"
        >
          <Icon size={grid ? 28 : 13} />
        </span>
        {grid ? (
          <span className={mediaCanvasStyles.tileBody}>
            <span className={mediaCanvasStyles.tileLabel}>{label}</span>
            <span className={mediaCanvasStyles.tileMeta}>Item {index + 1}</span>
          </span>
        ) : (
          <>
            <span className={mediaCanvasStyles.rowLabel}>{label}</span>
            <span className={mediaCanvasStyles.rowMeta}>Item {index + 1}</span>
          </>
        )}
      </Button>
      {!readOnly && (
        <span className={mediaCanvasStyles.itemActions}>
          <GalleryItemActions
            index={index}
            count={count}
            label={itemLabel}
            onMove={onMove}
            onRemove={onRemove}
          />
        </span>
      )}
    </li>
  )
}

export function MediaRepeaterGallery({
  field,
  mediaField,
  items,
  readOnly = false,
  onChange,
  onCommit,
}: MediaRepeaterGalleryProps): ReactElement {
  const confirmDelete = useConfirmDelete()
  const [viewMode, setViewModeState] = useState<MediaViewMode>(readStoredMediaViewMode)
  const [picker, setPicker] = useState<PickerState>(null)
  const mediaIds = items
    .map((item) => mediaIdForItem(item, mediaField))
    .filter((id): id is string => id !== null)
  const assetMap = useMediaAssetMap(mediaIds)

  function setViewMode(mode: MediaViewMode) {
    setViewModeState(mode)
    writeStoredMediaViewMode(mode)
  }

  function commit(nextItems: RepeaterItem[]) {
    onChange(nextItems)
    onCommit?.()
  }

  function moveItem(index: number, offset: -1 | 1) {
    const target = index + offset
    if (target < 0 || target >= items.length) return
    const next = [...items]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    commit(next)
  }

  function requestRemove(item: RepeaterItem, index: number, asset: CmsMediaAsset | null | undefined) {
    const label = asset?.filename ?? `gallery item ${index + 1}`
    confirmDelete({
      title: `Remove "${label}" from gallery?`,
      description: 'The media file stays in the library.',
      alwaysConfirm: true,
      commit: () => commit(items.filter((candidate) => candidate.id !== item.id)),
    })
  }

  function addAssets(assets: CmsMediaAsset[]) {
    const existingIds = new Set(mediaIds)
    const additions = assets.filter((asset) => !existingIds.has(asset.id))
    if (additions.length === 0) return

    const remaining = [...additions]
    const next = items.map((item) => {
      if (mediaIdForItem(item, mediaField) || remaining.length === 0) return item
      const asset = remaining.shift()
      if (!asset) return item
      return {
        ...item,
        cells: { ...item.cells, [mediaField.id]: asset.id },
      }
    })
    for (const asset of remaining) {
      next.push({
        id: nanoid(),
        cells: { [mediaField.id]: asset.id },
      })
    }
    commit(next)
  }

  function replaceAsset(itemId: string, asset: CmsMediaAsset) {
    commit(items.map((item) => item.id === itemId
      ? { ...item, cells: { ...item.cells, [mediaField.id]: asset.id } }
      : item,
    ))
  }

  const grid = viewMode === 'grid'
  const Asset = grid ? AssetTile : AssetRow

  return (
    <div className={styles.mediaRepeater}>
      <div className={styles.mediaRepeaterHeader}>
        <span className={styles.repeaterHeading}>
          <span className={styles.repeaterLabel}>{field.label}</span>
          <span className={styles.repeaterCount}>
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        </span>
        <span className={styles.mediaRepeaterControls}>
          <span
            role="group"
            aria-label={`${field.label} view`}
            className={mediaCanvasStyles.viewGroup}
          >
            <Button
              variant={viewMode === 'list' ? 'secondary' : 'ghost'}
              size="xs"
              iconOnly
              pressed={viewMode === 'list'}
              tooltip="List view"
              aria-label="List view"
              onClick={() => setViewMode('list')}
            >
              <BulletlistSolidIcon size={13} aria-hidden="true" />
            </Button>
            <Button
              variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
              size="xs"
              iconOnly
              pressed={viewMode === 'grid'}
              tooltip="Grid view"
              aria-label="Grid view"
              onClick={() => setViewMode('grid')}
            >
              <Grid2x22SolidIcon size={13} aria-hidden="true" />
            </Button>
          </span>
          {!readOnly && (
            <Button
              variant="secondary"
              size="xs"
              type="button"
              onClick={() => setPicker({ mode: 'add' })}
            >
              <PlusIcon size={11} aria-hidden="true" />
              Add media
            </Button>
          )}
        </span>
      </div>

      {field.description && (
        <span className={styles.repeaterDescription}>{field.description}</span>
      )}

      {items.length === 0 ? (
        <div className={styles.mediaRepeaterEmpty}>
          <ImageSolidIcon size={22} aria-hidden="true" />
          <span className={styles.mediaRepeaterEmptyTitle}>No media yet</span>
          <span>Select one or several files from the library.</span>
          {!readOnly && (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => setPicker({ mode: 'add' })}
            >
              <PlusIcon size={12} aria-hidden="true" />
              Add media
            </Button>
          )}
        </div>
      ) : (
        <ul className={grid ? mediaCanvasStyles.grid : mediaCanvasStyles.list}>
          {items.map((item, index) => {
            const mediaId = mediaIdForItem(item, mediaField)
            const asset = mediaId ? assetMap.get(mediaId) : null
            const actions = !readOnly ? (
              <GalleryItemActions
                index={index}
                count={items.length}
                label={asset?.filename ?? `gallery item ${index + 1}`}
                onMove={(offset) => moveItem(index, offset)}
                onRemove={() => requestRemove(item, index, asset)}
              />
            ) : undefined

            if (!mediaId || asset === null || asset === undefined) {
              return (
                <EmptyGalleryItem
                  key={item.id}
                  index={index}
                  count={items.length}
                  viewMode={viewMode}
                  state={!mediaId ? 'empty' : asset === undefined ? 'loading' : 'missing'}
                  readOnly={readOnly}
                  onChoose={() => setPicker({ mode: 'replace', itemId: item.id })}
                  onMove={(offset) => moveItem(index, offset)}
                  onRemove={() => requestRemove(item, index, asset)}
                />
              )
            }

            return (
              <Asset
                key={item.id}
                asset={asset}
                selected={false}
                canDrag={false}
                disabled={readOnly}
                ariaLabel={`Replace ${asset.filename}`}
                actions={actions}
                onSelect={() => setPicker({ mode: 'replace', itemId: item.id })}
              />
            )
          })}
        </ul>
      )}

      <MediaPickerModal
        open={picker !== null}
        onClose={() => setPicker(null)}
        mediaKind={pickerKind(mediaField)}
        allowMultiple={picker?.mode === 'add'}
        currentValue={picker?.mode === 'replace'
          ? mediaIdForItem(
              items.find((item) => item.id === picker.itemId) ?? { id: '', cells: {} },
              mediaField,
            )
          : null}
        currentValues={picker?.mode === 'add' ? [] : undefined}
        onPick={(asset) => {
          if (picker?.mode === 'replace') replaceAsset(picker.itemId, asset)
          else addAssets([asset])
          setPicker(null)
        }}
        onPickMultiple={(assets) => {
          addAssets(assets)
          setPicker(null)
        }}
      />
    </div>
  )
}
