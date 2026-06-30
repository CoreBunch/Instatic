import type { KeyboardEvent, MouseEvent } from 'react'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { Button } from '@ui/components/Button'
import { Image } from '@ui/components/Image'
import { cn } from '@ui/cn'
import type { IconComponent } from 'pixel-art-icons/types'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import type { MediaBucket, MediaViewMode } from './mediaExplorerModel'
import { mediaMetaLabel } from './mediaExplorerUtils'
import styles from '../SiteExplorerPanel/SiteExplorerPanel.module.css'

// Shared shape for MediaExplorerRow (list view) and MediaExplorerTile (grid
// view) — they accept the same props and only differ in how they render the
// preview. `previewAsset` is the full `CmsMediaAsset` so the `<Image>`
// primitive can build `srcset` from `asset.variants` and let the browser pick
// the smallest-variant-that-fits — the 28×28 list thumb hits the tiny w64
// variant instead of the multi-MB original.
interface MediaExplorerItemProps {
  icon: IconComponent
  label: string
  meta?: string
  ariaLabel: string
  previewKind: MediaBucket
  previewAsset?: CmsMediaAsset
  onClick: () => void
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
}

function MediaExplorerRow({
  icon,
  label,
  meta,
  ariaLabel,
  previewKind,
  previewAsset,
  onClick,
  onContextMenu,
  onKeyDown,
}: MediaExplorerItemProps) {
  const RowIcon = icon
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(styles.row, styles.mediaRow)}
      aria-label={ariaLabel}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <span className={styles.mediaRowPreview} aria-hidden="true">
        {previewKind === 'images' && previewAsset ? (
          // 28-px preview slot — tell the browser the rendered size so it
          // picks the smallest variant from the srcset ladder instead of
          // downloading the full-size original.
          <Image
            asset={previewAsset}
            alt=""
            sizes="28px"
            className={styles.mediaRowImage}
          />
        ) : previewKind === 'videos' && previewAsset ? (
          <video className={styles.mediaRowVideo} src={previewAsset.publicPath} muted preload="metadata" />
        ) : (
          <RowIcon size={13} />
        )}
      </span>
      <span className={styles.rowLabel}>{label}</span>
      {meta && <span className={styles.rowMeta}>{meta}</span>}
    </Button>
  )
}

function MediaExplorerTile({
  icon,
  label,
  meta,
  ariaLabel,
  previewKind,
  previewAsset,
  onClick,
  onContextMenu,
  onKeyDown,
}: MediaExplorerItemProps) {
  const TileIcon = icon
  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.mediaTile}
      aria-label={ariaLabel}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <span className={styles.mediaTilePreview} aria-hidden="true">
        {previewKind === 'images' && previewAsset ? (
          // Grid tile preview — the panel is narrow (two-up grid in a
          // ~280-px panel), so a 160-px sizes hint keeps the browser on
          // the w320 variant on 1× screens and w640 on 2× displays.
          <Image
            asset={previewAsset}
            alt=""
            sizes="160px"
            className={styles.mediaTileImage}
          />
        ) : previewKind === 'videos' && previewAsset ? (
          <video className={styles.mediaTileVideo} src={previewAsset.publicPath} muted preload="metadata" />
        ) : (
          <TileIcon size={22} />
        )}
      </span>
      <span className={styles.mediaTileBody}>
        <span className={styles.mediaTileLabel}>{label}</span>
        {meta && <span className={styles.mediaTileMeta}>{meta}</span>}
      </span>
    </Button>
  )
}

export function MediaExplorerItemList({
  assets,
  bucket,
  viewMode,
  onOpen,
  onContextMenu,
  onKeyDown,
}: {
  assets: CmsMediaAsset[]
  bucket: MediaBucket
  viewMode: MediaViewMode
  onOpen: (asset: CmsMediaAsset) => void
  onContextMenu: (asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) => void
  onKeyDown: (asset: CmsMediaAsset, event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  // The two view modes pass identical props to either MediaExplorerTile (grid)
  // or MediaExplorerRow (list). Build the props once per asset and pick the
  // renderer based on viewMode rather than duplicating the entire JSX block.
  const Renderer = viewMode === 'grid' ? MediaExplorerTile : MediaExplorerRow
  return assets.map((asset) => (
    <Renderer
      key={asset.id}
      icon={bucket === 'videos' ? VideoSolidIcon : Image2SolidIcon}
      label={asset.filename}
      meta={mediaMetaLabel(asset)}
      ariaLabel={`Open media ${asset.filename}`}
      previewKind={bucket}
      previewAsset={asset}
      onClick={() => onOpen(asset)}
      onContextMenu={(event) => onContextMenu(asset, event)}
      onKeyDown={(event) => onKeyDown(asset, event)}
    />
  ))
}
