/**
 * Runtime script bundles built for branch previews.
 *
 * A published page's scripts live on disk (the active slot) or in the
 * database; a branch preview builds its bundles on demand and keeps them
 * here, in memory, under `/_instatic/assets/preview/<build>/…`. The build id
 * is a hash of everything the bundle depends on, so repeated views of the
 * same branch state reuse one build, and a changed script mints a new one.
 * Bounded: the oldest builds are dropped past the cap.
 */
import type { BuiltRuntimeAssetFile } from './runtime/bundleScripts'

export const BRANCH_PREVIEW_ASSET_PREFIX = '/_instatic/assets/preview/'
const MAX_BUILDS = 32

interface PreviewAsset {
  contentType: string
  bytes: Uint8Array
}

/** Insertion-ordered: the first key is the oldest build. */
const builds = new Map<string, Map<string, PreviewAsset>>()

export function previewAssetBasePath(buildId: string): string {
  return `${BRANCH_PREVIEW_ASSET_PREFIX}${buildId}/`
}

export function hasPreviewBuild(buildId: string): boolean {
  return builds.has(buildId)
}

export function rememberPreviewBuild(buildId: string, files: readonly BuiltRuntimeAssetFile[]): void {
  const assets = new Map<string, PreviewAsset>()
  for (const file of files) assets.set(file.publicPath, { contentType: file.contentType, bytes: file.bytes })
  builds.delete(buildId)
  builds.set(buildId, assets)
  while (builds.size > MAX_BUILDS) {
    const oldest = builds.keys().next().value
    if (oldest === undefined) break
    builds.delete(oldest)
  }
}

/** A preview asset by its public path, or null when no live build serves it. */
export function readPreviewAsset(publicPath: string): PreviewAsset | null {
  if (!publicPath.startsWith(BRANCH_PREVIEW_ASSET_PREFIX)) return null
  const buildId = publicPath.slice(BRANCH_PREVIEW_ASSET_PREFIX.length).split('/')[0]
  return builds.get(buildId ?? '')?.get(publicPath) ?? null
}

/** Test seam. */
export function resetPreviewBuilds(): void {
  builds.clear()
}
