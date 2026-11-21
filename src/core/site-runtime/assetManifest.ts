import type {
  PublishedPageRuntimeAssets,
  PublishedRuntimeScriptAsset,
  SiteScriptPlacement,
} from './schemas'
import { normalizeResourceOrigins } from './resourceOrigins'

/** Only scripts that actually emit a tag may grant resource origins. */
export function publishedRuntimeResourceOrigins(runtimeAssets: PublishedPageRuntimeAssets | undefined) {
  return (['head', 'body-end'] as const).flatMap((placement) =>
    runtimeScriptsForPlacement(runtimeAssets, placement).flatMap((asset) => {
      const origins = normalizeResourceOrigins(asset.resourceOrigins)
      return origins ? [origins] : []
    }))
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function isSelfHostedRuntimeAssetUrl(src: string): boolean {
  const trimmed = src.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('//')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false
  if (trimmed.includes('\\')) return false

  const pathOnly = trimmed.split(/[?#]/, 1)[0]
  return pathOnly.split('/').every((segment) => segment !== '..')
}

function runtimeScriptsForPlacement(
  runtimeAssets: PublishedPageRuntimeAssets | undefined,
  placement: SiteScriptPlacement,
): PublishedRuntimeScriptAsset[] {
  return [...(runtimeAssets?.scripts ?? [])]
    .filter((asset) => asset.placement === placement)
    .filter((asset) => isSelfHostedRuntimeAssetUrl(asset.src))
    .sort((a, b) => a.priority - b.priority || a.src.localeCompare(b.src))
}

export function hasPublishedRuntimeScripts(runtimeAssets: PublishedPageRuntimeAssets | undefined): boolean {
  return (runtimeAssets?.scripts ?? []).some((asset) => isSelfHostedRuntimeAssetUrl(asset.src))
}

export function scriptTagsForRuntimeAssets(
  runtimeAssets: PublishedPageRuntimeAssets | undefined,
  placement: SiteScriptPlacement,
): string {
  return runtimeScriptsForPlacement(runtimeAssets, placement)
    .map((asset) => {
      const integrity = asset.integrity
        ? ` integrity="${escapeAttribute(asset.integrity)}" crossorigin="anonymous"`
        : ''
      const type = asset.format === 'classic' ? '' : ' type="module"'
      return `  <script${type} src="${escapeAttribute(asset.src.trim())}" data-instatic-runtime-script="${escapeAttribute(asset.fileId)}"${integrity}></script>`
    })
    .join('\n')
}
