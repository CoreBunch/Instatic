/**
 * Render-time materialisation of a media asset for the browser.
 *
 *   • Runs the `media.url.transform` filter chain over every URL the asset
 *     exposes (the original `publicPath` and every `variants[*].path`).
 *     Transformer plugins (passive CDN, image-CDN with a URL template, …)
 *     register filters via the existing hook-bus and the renderer picks
 *     up their output here.
 *
 *   • Reused by the publisher (`mediaPrefetch.ts`), the editor preview
 *     iframe runtime (which calls `prefetchMediaAssets`), and the admin
 *     media library list endpoint. One place = the editor and the
 *     published page show identical URLs.
 *
 *   • Pure with respect to its inputs — does NOT mutate the asset row.
 *     Returns a shallow copy so the caller can stash it on a render-time
 *     map without worrying about the repo cache.
 *
 * The filter payload is `{ path, ctx }` with `ctx` carrying enough
 * metadata for image-CDN transformers to pick the right width/format
 * (`{ kind: 'original' | 'variant', width?, format?, originalMimeType }`).
 * The host chains filters via `hookBus.applyFilter` so multiple plugins
 * compose; a handler that returns the input unchanged is a no-op.
 */

import type { MediaUrlTransformContext } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'

interface TransformFilterPayload {
  path: string
  ctx: MediaUrlTransformContext
}

/**
 * Minimal shape the materialiser needs. Both the repo's `MediaAsset`
 * (server-side, with adapter pinning) and the client-facing
 * `CmsMediaAsset` (no storage fields) satisfy this via structural
 * typing, so the same helper applies in the publisher AND in the admin
 * media library list endpoint.
 */
interface TransformableAsset {
  publicPath: string
  mimeType: string
  variants: ReadonlyArray<TransformableVariant>
}

interface TransformableVariant {
  width: number
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  path: string
}

/**
 * Run one URL through the filter chain. Pass-through if no handler is
 * registered, or if every handler returns the value unchanged. Worker
 * errors are swallowed by `hookBus.applyFilter` and we keep the previous
 * value.
 */
async function applyTransform(payload: TransformFilterPayload): Promise<string> {
  const next = await hookBus.applyFilter<TransformFilterPayload>('media.url.transform', payload)
  return typeof next?.path === 'string' ? next.path : payload.path
}

/**
 * Apply the URL transform chain to every URL the asset exposes. Returns
 * a shallow copy with rewritten `publicPath` / `variants[*].path` when
 * any transformer touched the values; returns the original reference
 * untouched when nothing changed (cheap identity check downstream).
 */
async function materializeAssetForClient<A extends TransformableAsset>(
  asset: A,
): Promise<A> {
  // Short-circuit: if no plugin has registered a media URL transformer,
  // we don't bother touching the asset. This keeps the hot path free
  // when the feature isn't in use.
  if (!hookBus.hasFiltersFor('media.url.transform')) return asset

  const originalMimeType = asset.mimeType
  // Run the original-path transform and all variant transforms concurrently.
  const [publicPath, ...variantPaths] = await Promise.all([
    applyTransform({ path: asset.publicPath, ctx: { kind: 'original', originalMimeType } }),
    ...asset.variants.map(v => applyTransform({
      path: v.path,
      ctx: { kind: 'variant', width: v.width, format: v.format, originalMimeType },
    })),
  ])
  const variants = asset.variants.map((v, i) =>
    variantPaths[i] === v.path ? v : { ...v, path: variantPaths[i] }
  )
  if (publicPath === asset.publicPath && variants.every((v, i) => v === asset.variants[i])) {
    return asset
  }
  // Casts preserve the input type's full surface (the helper is generic
  // over A) while threading the rewritten URL fields. The transform only
  // touches `publicPath` / `variants[*].path`, so other fields (alt text,
  // storage adapter id, etc.) carry through unchanged.
  return { ...asset, publicPath, variants } as A
}

/**
 * Batch variant of `materializeAssetForClient` — applies the transform
 * chain to every asset in the map and returns a new map with the same
 * keys. Used by the publisher's pre-fetch path so render-time lookup
 * stays O(1) on the page-tree path (the KEY) while the VALUE reflects
 * any transformer rewrites.
 */
export async function materializeAssetMapForClient<K, A extends TransformableAsset>(
  assets: Map<K, A>,
): Promise<Map<K, A>> {
  if (!hookBus.hasFiltersFor('media.url.transform')) return assets
  const entries = [...assets]
  const materialized = await Promise.all(entries.map(([, asset]) => materializeAssetForClient(asset)))
  return new Map(entries.map(([key], i) => [key, materialized[i]]))
}

/**
 * Array variant — same semantics, list-shaped input. Used by the admin
 * media library list endpoint so the operator sees the same URLs as
 * the published page (no dev/prod skew).
 */
export async function materializeAssetListForClient<A extends TransformableAsset>(
  assets: ReadonlyArray<A>,
): Promise<A[]> {
  if (!hookBus.hasFiltersFor('media.url.transform')) return [...assets]
  return Promise.all(assets.map(asset => materializeAssetForClient(asset)))
}
