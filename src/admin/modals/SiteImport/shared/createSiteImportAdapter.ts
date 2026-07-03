/**
 * createSiteImportAdapter — wires the Super Import pipeline to the editor
 * store and the CMS media upload endpoint.
 *
 * Upload: POST /admin/api/cms/media (same endpoint as the media workspace).
 * Commit: calls useEditorStore.getState().mutateAllPagesAndSite in one
 *         atomic Mutative recipe → single Cmd+Z undo step.
 */

import type { SiteImportAdapter, SiteImportTransaction } from '@core/siteImport'
import { installCmsGoogleFont } from '@core/persistence/cmsFonts'
import {
  createCmsMediaFolder,
  listCmsMediaFolders,
  setCmsMediaAssetFolders,
  uploadCmsMediaAsset,
  type CmsMediaFolder,
} from '@core/persistence/cmsMedia'
import { getErrorMessage } from '@core/utils/errorMessage'
import { useEditorStore } from '@site/store/store'

interface AdapterCallbacks {
  /** Stable id for the upload session (for logging). */
  sessionId: string
  /** Called before each asset upload begins. */
  onUploadStart?(asset: { path: string }): void
  /** Called after each asset upload completes. */
  onUploadComplete?(asset: { path: string; url: string }): void
  /** Called before the atomic store commit. */
  onCommitStart?(): void
  /** Called after the atomic store commit succeeds. */
  onCommitComplete?(): void
}

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function dirSegments(path: string): string[] {
  // Drop the filename and any trailing/leading slashes; return an ordered list
  // of folder names from root → leaf. Empty for files at the bundle root.
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  if (!dir) return []
  return dir.split('/').filter((s) => s.length > 0)
}

/**
 * In-memory cache of folder ids keyed by their full slash-delimited path
 * (`'assets'`, `'assets/img'`, …). Folders the user already has from
 * previous imports / manual uploads are matched against this index so a
 * second wizard run doesn't duplicate the tree.
 */
function buildFolderIndex(folders: ReadonlyArray<CmsMediaFolder>): Map<string, string> {
  const byId = new Map<string, CmsMediaFolder>()
  for (const f of folders) byId.set(f.id, f)

  // Resolve each folder's full path by walking parents.
  const cache = new Map<string, string>()
  function fullPath(id: string): string {
    const seen = new Set<string>()
    const parts: string[] = []
    let current: string | null = id
    while (current && !seen.has(current)) {
      seen.add(current)
      const entry = byId.get(current)
      if (!entry) break
      parts.unshift(entry.name)
      current = entry.parentId
    }
    return parts.join('/')
  }

  for (const f of folders) cache.set(fullPath(f.id), f.id)
  return cache
}

export function createSiteImportAdapter(opts: AdapterCallbacks): SiteImportAdapter {
  // Folder index is loaded lazily on the first `uploadAsset` that needs a
  // non-root folder, so a session that uploads only root-level files (or one
  // file) makes zero folder API calls.
  let folderIndex: Map<string, string> | null = null
  let folderIndexPromise: Promise<Map<string, string>> | null = null

  async function ensureFolderIndex(): Promise<Map<string, string>> {
    if (folderIndex) return folderIndex
    if (!folderIndexPromise) {
      folderIndexPromise = (async () => {
        const idx = buildFolderIndex(await listCmsMediaFolders())
        folderIndex = idx
        return idx
      })()
    }
    return folderIndexPromise
  }

  /**
   * Ensure every folder segment of `segments` exists, creating them
   * parent-first when missing. Returns the leaf folder id (or null when
   * `segments` is empty, meaning the asset lives at the media root).
   *
   * Mutates the folder index cache so subsequent calls for the same path
   * are O(1).
   */
  async function ensureFolderPath(segments: string[]): Promise<string | null> {
    if (segments.length === 0) return null
    const index = await ensureFolderIndex()

    let parentId: string | null = null
    let cumulative = ''
    for (const segment of segments) {
      cumulative = cumulative ? `${cumulative}/${segment}` : segment
      const cached = index.get(cumulative)
      if (cached) {
        parentId = cached
        continue
      }
      const folder = await createCmsMediaFolder({ name: segment, parentId })
      index.set(cumulative, folder.id)
      parentId = folder.id
    }
    return parentId
  }

  async function assignAssetToFolder(assetId: string, folderId: string): Promise<void> {
    try {
      await setCmsMediaAssetFolders(assetId, { add: [folderId] })
    } catch (err) {
      // Surface as a non-fatal log: the asset uploaded fine, only the
      // folder placement failed. The user can drag it to the right folder
      // by hand afterwards.
      console.warn(
        `[siteImportAdapter] Asset ${assetId} placed at the media root; ${getErrorMessage(err, 'folder assignment failed')}.`,
      )
    }
  }

  return {
    installGoogleFont(font) {
      return installCmsGoogleFont(font)
    },

    async uploadAsset({ path, bytes, mimeType }) {
      opts.onUploadStart?.({ path })
      // bytes comes from fflate/File APIs — always backed by a plain ArrayBuffer.
      // TypeScript's BlobPart constraint excludes SharedArrayBuffer; the cast is safe.
      const blobData: ArrayBuffer = bytes.slice().buffer as ArrayBuffer
      const file = new File([blobData], basename(path), { type: mimeType })
      const asset = await uploadCmsMediaAsset(file)

      // Place the asset under a folder that mirrors its source bundle path.
      // Folder creation happens lazily here so a flat bundle (every asset at
      // the root) makes zero folder API calls. Failures inside
      // `ensureFolderPath` propagate up — the surrounding `commitImportPlan`
      // catches them per-asset and continues, so a folder API blip never
      // strands later uploads.
      const segments = dirSegments(path)
      if (segments.length > 0) {
        const folderId = await ensureFolderPath(segments)
        if (folderId) await assignAssetToFolder(asset.id, folderId)
      }

      opts.onUploadComplete?.({ path, url: asset.publicPath })
      return asset.publicPath
    },

    async commit(recipe) {
      opts.onCommitStart?.()
      const ok = useEditorStore.getState().mutateAllPagesAndSite((_site, helpers) => {
        const tx: SiteImportTransaction = {
          addPage: (input) => helpers.addPage(input),
          addStyleRule: (rule) => helpers.addStyleRule(rule),
          overwritePage: (id, input) => helpers.overwritePage(id, input),
          overwriteStyleRule: (id, rule) => helpers.overwriteStyleRule(id, rule),
          addConditions: (conditions) => helpers.addConditions(conditions),
          addFonts: (fonts) => helpers.addFonts(fonts),
          addInstalledFonts: (fonts) => helpers.addInstalledFonts(fonts),
          addFontTokens: (tokens) => helpers.addFontTokens(tokens),
          overwriteFontTokens: (items) => helpers.overwriteFontTokens(items),
          addColorTokens: (colors) => helpers.addColorTokens(colors),
          overwriteColorTokens: (items) => helpers.overwriteColorTokens(items),
          addScripts: (scripts) => helpers.addScripts(scripts),
          addStylesheets: (stylesheets) => helpers.addStylesheets(stylesheets),
        }
        recipe(tx)
        return true
      })
      if (!ok) {
        throw new Error('[siteImportAdapter] Commit failed: editor store rejected the mutation')
      }
      opts.onCommitComplete?.()
    },
  }
}
