import {
  bagToReactStyle,
  collectBackgroundImagePaths,
  responsiveBackgroundImage,
  type RenderResolvedMedia,
} from '@core/publisher'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import { useCmsMediaAssetsByPath } from './useCmsMediaAssetByPath'

export interface ResponsiveEditorMediaAssets {
  mediaAssets: ReadonlyMap<string, RenderResolvedMedia>
  signature: string
}

function renderResolvedMediaFromCms(asset: CmsMediaAsset): RenderResolvedMedia {
  return {
    publicPath: asset.publicPath,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    altText: asset.altText,
    blurHash: asset.blurHash,
    variants: asset.variants,
    posterPath: asset.posterPath,
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
    mediaAssets.set(path, renderResolvedMediaFromCms(asset))
    if (asset.variants.length === 0) continue
    signatureParts.push(`${path}=${asset.variants.map((v) => `${v.width}:${v.path}`).join('|')}`)
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
