import {
  bagToReactStyle,
  collectBackgroundImagePaths,
  responsiveBackgroundImage,
  type RenderResolvedMedia,
} from '@core/publisher'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { useCmsMediaAssetsByPath } from './useCmsMediaAssetByPath'
import { versionedMediaUrl } from '../utils/variants'

export interface ResponsiveEditorMediaAssets {
  mediaAssets: ReadonlyMap<string, RenderResolvedMedia>
  signature: string
}

function renderResolvedMediaFromCms(asset: CmsMediaAsset): RenderResolvedMedia {
  return {
    // Replace rewrites bytes at the SAME urls, so the canvas CSS built from
    // them would be byte-identical and the browser would keep painting the
    // previous binary from cache. Stamping with `replacedAt` changes the CSS
    // exactly when the bytes change, which forces the refetch.
    publicPath: versionedMediaUrl(asset.publicPath, asset.replacedAt),
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    altText: asset.altText,
    blurHash: asset.blurHash,
    variants: asset.variants.map((variant) => ({
      ...variant,
      path: versionedMediaUrl(variant.path, asset.replacedAt),
    })),
    posterPath: asset.posterPath,
    // Carried through so the editor preview frames an image exactly like the
    // published page does — a focal point that only applied after publishing
    // would make the canvas lie.
    focus: asset.focus,
    crop: asset.crop,
  }
}

function uniqueBackgroundPathsFromBag(bag: Record<string, unknown> | undefined): string[] {
  return [...new Set(collectBackgroundImagePaths(bag?.backgroundImage))]
}

let lastResponsiveAssetsKey = ''
let lastResponsiveAssets: ResponsiveEditorMediaAssets | null = null

function responsiveMediaAssetsFromCms(
  paths: readonly string[],
  assets: ReadonlyMap<string, CmsMediaAsset>,
): ResponsiveEditorMediaAssets {
  const mediaAssets = new Map<string, RenderResolvedMedia>()
  const pathKey = [...paths].sort().join('\0')
  const signatureParts: string[] = []

  for (const path of [...paths].sort()) {
    const asset = assets.get(path)
    if (!asset) continue
    const resolved = renderResolvedMediaFromCms(asset)
    mediaAssets.set(path, resolved)
    // Signature is built from the RESOLVED (version-stamped) urls so a
    // replace — which keeps every raw path identical — still busts the memo.
    if (resolved.variants.length === 0) {
      signatureParts.push(`${path}=${resolved.publicPath}`)
      continue
    }
    signatureParts.push(`${path}=${resolved.variants.map((v) => `${v.width}:${v.path}`).join('|')}`)
  }

  const signature = signatureParts.join(';')
  const key = `${pathKey}\n${signature}`
  if (lastResponsiveAssets && lastResponsiveAssetsKey === key) return lastResponsiveAssets

  lastResponsiveAssetsKey = key
  lastResponsiveAssets = { mediaAssets, signature }
  return lastResponsiveAssets
}

export function responsiveBackgroundReactStyle(
  bag: Record<string, unknown> | undefined,
  mediaAssets: ReadonlyMap<string, RenderResolvedMedia>,
): Record<string, string | number> | undefined {
  if (!bag) return undefined
  if (typeof bag.backgroundImage !== 'string' || mediaAssets.size === 0) {
    return bagToReactStyle(bag)
  }

  const responsive = responsiveBackgroundImage(bag.backgroundImage, mediaAssets)
  return bagToReactStyle({
    ...bag,
    backgroundImage: responsive.imageSet ?? responsive.fallback,
  })
}

export function useResponsiveEditorMediaAssets(paths: readonly string[]): ResponsiveEditorMediaAssets {
  const uniquePaths = [...new Set(paths)]
  const assets = useCmsMediaAssetsByPath(uniquePaths)
  return responsiveMediaAssetsFromCms(uniquePaths, assets)
}

export function useResponsiveBackgroundStyle(
  bag: Record<string, unknown> | undefined,
): Record<string, string | number> | undefined {
  const paths = uniqueBackgroundPathsFromBag(bag)
  const { mediaAssets } = useResponsiveEditorMediaAssets(paths)
  return responsiveBackgroundReactStyle(bag, mediaAssets)
}
