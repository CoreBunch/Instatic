/**
 * base.image editor preview component.
 *
 * Mirrors what the publisher emits so the canvas WYSIWYG reflects what's
 * actually shipped:
 *   - smaller variant (by render size + DPR) instead of the original
 *   - srcset + sizes so the browser can pick the right rung
 *   - intrinsic width / height to prevent CLS in the canvas
 *   - BlurHash data-URL backdrop while the variant streams in
 *   - alt text comes from the library asset (single source of truth — edit
 *     via the Media viewer; there is no per-instance override)
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import {
  blurHashToDataUrl,
  buildVariantSrcset,
  pickVariantUrl,
} from '@admin/pages/media/utils/variants'
import { useCmsMediaAssetByPath } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { htmlAttributesForReact } from '@modules/base/shared/htmlAttributes'
import type { ImageStoredProps } from './props'
import { shouldUseBlurPlaceholder } from './placeholder'

// Best-guess CSS width for the canvas preview tile. Triggers DPR-aware
// variant pick: 1× → w320, 2× → w640. The browser still uses srcset to
// pick the actual variant when the layout is known; this is just the
// initial `src`.
const CANVAS_CSS_WIDTH = 320

export const ImageEditor: React.FC<ModuleComponentProps<ImageStoredProps>> = ({ props, mcClassName, nodeWrapperProps }) => {
  // Resolve the asset row server-side metadata is cached in a module-
  // level map, so dozens of image modules on one page share a single
  // round trip. `null` until the cache is populated — render shows the
  // raw src in the meantime so there's no flash of "No image selected".
  const asset = useCmsMediaAssetByPath(props.src || null)

  const responsive = !asset
    ? null
    : {
        src: pickVariantUrl(asset, CANVAS_CSS_WIDTH),
        srcset: buildVariantSrcset(asset),
        blurUrl: shouldUseBlurPlaceholder(asset.blurHash, asset.mimeType)
          ? blurHashToDataUrl(asset.blurHash)
          : null,
        width: asset.width,
        height: asset.height,
        libraryAlt: asset.altText,
      }

  if (!props.src) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<ImageSolidIcon size={32} />}
        label="No image selected"
        layout="row"
      />
    )
  }

  // Alt text: library asset is the single source of truth. Matches the
  // published-render behaviour so the canvas preview never disagrees
  // with the published HTML. Edit alt via the Media viewer.
  const alt = responsive?.libraryAlt ?? ''
  const htmlAttrs = htmlAttributesForReact(props.htmlAttributes)

  // No resolved asset yet (cache loading, external URL, or row missing).
  // Render the raw src so the user never sees a flash of blank.
  if (!responsive) {
    return (
      <img
        {...nodeWrapperProps}
        {...htmlAttrs}
        src={props.src}
        alt={alt}
        className={mcClassName}
        loading={props.loading}
        decoding="async"
      />
    )
  }

  // Merge the BlurHash backdrop with the node's inline styles carried by
  // nodeWrapperProps.style — an explicit `style` prop after the spread would
  // otherwise clobber them (even `style={undefined}` wins over the spread),
  // making the canvas ignore inline styles the published render honours.
  const style = responsive.blurUrl
    ? ({
        ...nodeWrapperProps?.style,
        backgroundImage: `url(${responsive.blurUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      } as React.CSSProperties)
    : nodeWrapperProps?.style

  return (
    <img
      {...nodeWrapperProps}
      {...htmlAttrs}
      src={responsive.src}
      srcSet={responsive.srcset ?? undefined}
      sizes={responsive.srcset ? '100vw' : undefined}
      alt={alt}
      width={responsive.width ?? undefined}
      height={responsive.height ?? undefined}
      className={mcClassName}
      loading={props.loading}
      decoding="async"
      style={style}
    />
  )
}
