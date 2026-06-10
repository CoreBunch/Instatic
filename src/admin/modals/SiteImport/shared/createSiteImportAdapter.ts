/**
 * createSiteImportAdapter — wires the Super Import pipeline to the editor
 * store and the CMS media upload endpoint.
 *
 * Upload: POST /admin/api/cms/media (same endpoint as the media workspace).
 * Commit: calls useEditorStore.getState().mutateAllPagesAndSite in one
 *         atomic Immer producer → single Cmd+Z undo step.
 */

import { Type, type Static } from '@sinclair/typebox'
import type { SiteImportAdapter, SiteImportTransaction } from '@core/siteImport'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { responseErrorMessage } from '@core/http'
import { installCmsGoogleFont } from '@core/persistence/cmsFonts'
import { useEditorStore } from '@site/store/store'

// Minimal TypeBox schema for the upload response — both `id` and `publicPath`
// are needed: id to assign the asset to its destination folder, publicPath to
// stitch back into the imported HTML/CSS so references resolve.
const MediaUploadResponseSchema = Type.Object(
  {
    asset: Type.Object(
      { id: Type.String(), publicPath: Type.String() },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

// Subset of the folder list response — name / parentId let us match against an
// existing folder tree so a re-run of the wizard re-uses the same folders
// instead of accumulating `assets-2`, `assets-3` next to the originals.
const MediaFolderListResponseSchema = Type.Object(
  {
    folders: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          name: Type.String(),
          parentId: Type.Union([Type.String(), Type.Null()]),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
)

const MediaFolderCreateResponseSchema = Type.Object(
  {
    folder: Type.Object(
      { id: Type.String() },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

export interface AdapterCallbacks {
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

interface FolderIndexEntry {
  id: string
  parentId: string | null
  name: string
}

/**
 * In-memory cache of folder ids keyed by their full slash-delimited path
 * (`'assets'`, `'assets/img'`, …). Folders the user already has from
 * previous imports / manual uploads are matched against this index so a
 * second wizard run doesn't duplicate the tree.
 */
function buildFolderIndex(folders: ReadonlyArray<FolderIndexEntry>): Map<string, string> {
  const byId = new Map<string, FolderIndexEntry>()
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
        const res = await fetch('/admin/api/cms/media/folders', { method: 'GET' })
        if (!res.ok) {
          throw new Error(
            `[siteImportAdapter] Could not load folder index: ${await responseErrorMessage(res, 'Folder list failed')}`,
          )
        }
        const payload = await parseJsonResponse(res, MediaFolderListResponseSchema)
        const idx = buildFolderIndex(payload.folders)
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
      // Explicit annotations break a TS inference cycle: `parentId` is
      // reassigned from `payload.folder.id`, and without the annotation the
      // compiler tries to resolve `payload`'s (and `res`'s) types through the
      // captured `parentId` recursively (TS7022).
      const res: Response = await fetch('/admin/api/cms/media/folders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: segment, parentId }),
      })
      if (!res.ok) {
        throw new Error(
          `[siteImportAdapter] Folder create failed for "${cumulative}": ${await responseErrorMessage(res, 'Create folder failed')}`,
        )
      }
      const payload: Static<typeof MediaFolderCreateResponseSchema> =
        await parseJsonResponse(res, MediaFolderCreateResponseSchema)
      index.set(cumulative, payload.folder.id)
      parentId = payload.folder.id
    }
    return parentId
  }

  async function assignAssetToFolder(assetId: string, folderId: string): Promise<void> {
    const res = await fetch(`/admin/api/cms/media/${assetId}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: [folderId] }),
    })
    if (!res.ok) {
      // Surface as a non-fatal log: the asset uploaded fine, only the
      // folder placement failed. The user can drag it to the right folder
      // by hand afterwards.
      console.warn(
        `[siteImportAdapter] Asset ${assetId} placed at the media root; folder assign returned ${res.status}.`,
      )
    }
  }

  return {
    installGoogleFont(font) {
      return installCmsGoogleFont(font)
    },

    async uploadAsset({ path, bytes, mimeType }) {
      opts.onUploadStart?.({ path })
      const form = new FormData()
      // bytes comes from fflate/File APIs — always backed by a plain ArrayBuffer.
      // TypeScript's BlobPart constraint excludes SharedArrayBuffer; the cast is safe.
      const blobData: ArrayBuffer = bytes.slice().buffer as ArrayBuffer
      form.append('file', new Blob([blobData], { type: mimeType }), basename(path))
      const res = await fetch('/admin/api/cms/media', { method: 'POST', body: form })
      if (!res.ok) {
        const errMsg = await responseErrorMessage(res, 'Upload failed')
        throw new Error(`[siteImportAdapter] Upload failed for ${path}: ${errMsg}`)
      }
      const payload = await parseJsonResponse(res, MediaUploadResponseSchema)

      // Place the asset under a folder that mirrors its source bundle path.
      // Folder creation happens lazily here so a flat bundle (every asset at
      // the root) makes zero folder API calls. Failures inside
      // `ensureFolderPath` propagate up — the surrounding `commitImportPlan`
      // catches them per-asset and continues, so a folder API blip never
      // strands later uploads.
      const segments = dirSegments(path)
      if (segments.length > 0) {
        const folderId = await ensureFolderPath(segments)
        if (folderId) await assignAssetToFolder(payload.asset.id, folderId)
      }

      opts.onUploadComplete?.({ path, url: payload.asset.publicPath })
      return payload.asset.publicPath
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
