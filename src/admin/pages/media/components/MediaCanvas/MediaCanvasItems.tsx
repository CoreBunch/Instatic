import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from 'react'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { ArrowUpIcon } from 'pixel-art-icons/icons/arrow-up'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import type { CmsMediaAsset, CmsMediaFolder } from '@core/persistence/cmsMedia'
import type { FolderSelection } from '../../hooks/useMediaWorkspace'
import { bucketForMime } from '../../utils/filters'
import { blurHashToDataUrl, pickVariantUrl } from '../../utils/variants'
import { formatBytes } from '../../utils/formatBytes'
import styles from './MediaCanvas.module.css'

export interface ParentFolderEntry {
  label: string
  targetFolderId: string | null
  selection: FolderSelection
}

interface AssetItemProps {
  asset: CmsMediaAsset
  selected: boolean
  canDrag: boolean
  disabled?: boolean
  ariaLabel?: string
  actions?: ReactNode
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void
  onDragStart?: (asset: CmsMediaAsset, event: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: () => void
  onContextMenu?: (asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) => void
  onKeyboardMenu?: (asset: CmsMediaAsset, event: KeyboardEvent<HTMLButtonElement>) => void
}

// Target widths (CSS px) for the two view modes. Picked so a 1x display
// fetches the next-bigger variant (w320 for grid tiles, w64 for the list
// row's 24-px preview). DPR-aware picking happens inside pickVariantUrl.
const TILE_CSS_WIDTH = 140
const ROW_CSS_WIDTH = 24

export function AssetTile({
  asset,
  selected,
  canDrag,
  disabled = false,
  ariaLabel,
  actions,
  onSelect,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onKeyboardMenu,
}: AssetItemProps) {
  const bucket = bucketForMime(asset.mimeType)
  const thumbUrl = bucket === 'image' ? pickVariantUrl(asset, TILE_CSS_WIDTH) : null
  const blurUrl = bucket === 'image' ? blurHashToDataUrl(asset.blurHash) : null
  const previewStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as CSSProperties)
    : undefined
  return (
    <li className={styles.tileItem} data-has-actions={actions ? 'true' : undefined}>
      <Button
        variant="ghost"
        size="sm"
        pressed={selected}
        draggable={canDrag}
        disabled={disabled}
        aria-label={ariaLabel ?? `Open ${asset.filename}`}
        className={cn(styles.tile, selected && styles.tileSelected)}
        onClick={(event) => onSelect(event)}
        onDragStart={onDragStart ? (event) => onDragStart(asset, event) : undefined}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu ? (event) => onContextMenu(asset, event) : undefined}
        onKeyDown={onKeyboardMenu ? (event) => onKeyboardMenu(asset, event) : undefined}
      >
        <span className={styles.tilePreview} aria-hidden="true" style={previewStyle}>
          {bucket === 'image' && thumbUrl ? (
            <img src={thumbUrl} alt="" className={styles.tileImage} loading="lazy" decoding="async" draggable={false} />
          ) : bucket === 'video' ? (
            <video src={asset.publicPath} preload="metadata" muted className={styles.tileVideo} draggable={false} />
          ) : (
            <FolderGlyphIcon size={28} />
          )}
        </span>
        <span className={styles.tileBody}>
          <span className={styles.tileLabel}>{asset.filename}</span>
          <span className={styles.tileMeta}>{formatBytes(asset.sizeBytes)}</span>
        </span>
      </Button>
      {actions && <span className={styles.itemActions}>{actions}</span>}
    </li>
  )
}

export function AssetRow({
  asset,
  selected,
  canDrag,
  disabled = false,
  ariaLabel,
  actions,
  onSelect,
  onDragStart,
  onDragEnd,
  onContextMenu,
  onKeyboardMenu,
}: AssetItemProps) {
  const bucket = bucketForMime(asset.mimeType)
  const thumbUrl = bucket === 'image' ? pickVariantUrl(asset, ROW_CSS_WIDTH) : null
  const blurUrl = bucket === 'image' ? blurHashToDataUrl(asset.blurHash) : null
  const previewStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as CSSProperties)
    : undefined
  return (
    <li className={styles.rowItem} data-has-actions={actions ? 'true' : undefined}>
      <Button
        variant="ghost"
        size="sm"
        pressed={selected}
        draggable={canDrag}
        disabled={disabled}
        aria-label={ariaLabel ?? `Open ${asset.filename}`}
        className={cn(styles.row, selected && styles.rowSelected)}
        onClick={(event) => onSelect(event)}
        onDragStart={onDragStart ? (event) => onDragStart(asset, event) : undefined}
        onDragEnd={onDragEnd}
        onContextMenu={onContextMenu ? (event) => onContextMenu(asset, event) : undefined}
        onKeyDown={onKeyboardMenu ? (event) => onKeyboardMenu(asset, event) : undefined}
      >
        <span className={styles.rowPreview} aria-hidden="true" style={previewStyle}>
          {bucket === 'image' && thumbUrl ? (
            <img src={thumbUrl} alt="" className={styles.rowImage} loading="lazy" decoding="async" />
          ) : bucket === 'video' ? (
            <VideoSolidIcon size={13} />
          ) : (
            <Image2SolidIcon size={13} />
          )}
        </span>
        <span className={styles.rowLabel}>{asset.filename}</span>
        <span className={styles.rowMeta}>{formatBytes(asset.sizeBytes)}</span>
      </Button>
      {actions && <span className={styles.itemActions}>{actions}</span>}
    </li>
  )
}

interface FolderItemProps {
  folder: CmsMediaFolder
  meta: string
  dropActive: boolean
  canDrag: boolean
  onOpen: () => void
  onDragStart: (folder: CmsMediaFolder, event: DragEvent<HTMLButtonElement>) => void
  onDragOver: (event: DragEvent<HTMLButtonElement>, targetFolderId: string | null) => void
  onDragLeave: (event: DragEvent<HTMLButtonElement>) => void
  onDrop: (event: DragEvent<HTMLButtonElement>) => void
}

export function FolderTile({
  folder,
  meta,
  dropActive,
  canDrag,
  onOpen,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderItemProps) {
  return (
    <li className={styles.tileItem}>
      <Button
        variant="ghost"
        size="sm"
        draggable={canDrag}
        aria-label={`Open folder ${folder.name}`}
        className={cn(styles.tile, styles.folderTile, dropActive && styles.folderDropActive)}
        onClick={onOpen}
        onDragStart={(event) => onDragStart(folder, event)}
        onDragEnd={onDragLeave}
        onDragOver={(event) => onDragOver(event, folder.id)}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className={styles.folderPreview} aria-hidden="true">
          <FolderGlyphIcon size={36} />
        </span>
        <span className={styles.tileBody}>
          <span className={styles.tileLabel}>{folder.name}</span>
          <span className={styles.tileMeta}>{meta}</span>
        </span>
      </Button>
    </li>
  )
}

export function FolderRow({
  folder,
  meta,
  dropActive,
  canDrag,
  onOpen,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
}: FolderItemProps) {
  return (
    <li className={styles.rowItem}>
      <Button
        variant="ghost"
        size="sm"
        draggable={canDrag}
        aria-label={`Open folder ${folder.name}`}
        className={cn(styles.row, styles.folderRow, dropActive && styles.folderDropActive)}
        onClick={onOpen}
        onDragStart={(event) => onDragStart(folder, event)}
        onDragEnd={onDragLeave}
        onDragOver={(event) => onDragOver(event, folder.id)}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className={styles.rowPreview} aria-hidden="true">
          <FolderGlyphIcon size={15} />
        </span>
        <span className={styles.rowLabel}>{folder.name}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </Button>
    </li>
  )
}

interface ParentFolderItemProps {
  entry: ParentFolderEntry
  dropActive: boolean
  onOpen: () => void
  onDragOver: (event: DragEvent<HTMLButtonElement>, targetFolderId: string | null) => void
  onDragLeave: (event: DragEvent<HTMLButtonElement>) => void
  onDrop: (event: DragEvent<HTMLButtonElement>) => void
}

export function ParentFolderTile({
  entry,
  dropActive,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: ParentFolderItemProps) {
  return (
    <li className={styles.tileItem}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Back to ${entry.label}`}
        className={cn(styles.tile, styles.folderTile, styles.parentFolderTile, dropActive && styles.folderDropActive)}
        onClick={onOpen}
        onDragOver={(event) => onDragOver(event, entry.targetFolderId)}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className={styles.folderPreview} aria-hidden="true">
          <span className={styles.parentFolderIcon}>
            <FolderGlyphIcon size={38} />
            <ArrowUpIcon size={16} className={styles.parentFolderArrow} />
          </span>
        </span>
        <span className={styles.tileBody}>
          <span className={styles.tileLabel}>{entry.label}</span>
          <span className={styles.tileMeta}>Parent folder</span>
        </span>
      </Button>
    </li>
  )
}

export function ParentFolderRow({
  entry,
  dropActive,
  onOpen,
  onDragOver,
  onDragLeave,
  onDrop,
}: ParentFolderItemProps) {
  return (
    <li className={styles.rowItem}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Back to ${entry.label}`}
        className={cn(styles.row, styles.folderRow, styles.parentFolderRow, dropActive && styles.folderDropActive)}
        onClick={onOpen}
        onDragOver={(event) => onDragOver(event, entry.targetFolderId)}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className={styles.rowPreview} aria-hidden="true">
          <span className={styles.parentFolderIcon}>
            <FolderGlyphIcon size={16} />
            <ArrowUpIcon size={9} className={styles.parentFolderArrow} />
          </span>
        </span>
        <span className={styles.rowLabel}>{entry.label}</span>
        <span className={styles.rowMeta}>Parent folder</span>
      </Button>
    </li>
  )
}
