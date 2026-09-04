/**
 * filesSlice — Files Data Layer store slice.
 *
 * Architecture source: Contribution #595 §6 (amended in msg #1844)
 *
 * Manages site.files[] CRUD.  State lives in site.files (owned by
 * siteSlice); this slice owns only the action methods — same pattern as
 * classSlice (site.styleRules).
 *
 * Every write boundary:
 *  - Calls normalizePath() to collapse dot-segments.
 *  - Calls isSafePath() and throws on invalid input (CWE-22).
 *  - Enforces path uniqueness and throws on collision (not silent overwrite).
 *
 * Dependency direction: MUST NOT import from editor/ or page-tree/mutations.
 * This is a pure data-layer slice.
 */

import { nanoid } from 'nanoid'
import type { EditorStoreSliceCreator } from '@site/store/types'
import type { SiteFile, SiteFileType } from '@core/files/schemas'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import { reconcileSiteExplorerInPlace } from '@core/page-tree'
import { pageScriptPath, pageScriptRuntimeConfig } from '@core/site-runtime'
import { buildSiteHelpers } from './site/helpers'
import { siteRuntimeWithoutFile, writeSiteRuntimeDraft } from './site/siteRuntimeDraft'

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

interface FilesSlice {
  /**
   * Create a new file at the given path with the given type.
   * Returns the new file's id.
   *
   * Throws if:
   * - No site is loaded.
   * - `path` fails isSafePath() (after normalization).
   * - A file at the normalized path already exists (CWE-22 / uniqueness).
   */
  createFile(path: string, type: SiteFileType, content?: string): string

  /**
   * Create a page's script asset — `scripts/pages/<slug>.js` with a runtime
   * scope of exactly that page — in ONE undo step (file + runtime config).
   * The God Mode JS panel calls this lazily on the first edit; resolve an
   * existing one with `findPageScript` first. Returns the new file's id.
   *
   * Throws if no site is loaded or the page does not exist.
   */
  createPageScript(pageId: string, content: string): string

  /**
   * Delete the file with the given id.
   * No-op if the id does not exist.
   */
  deleteFile(id: string): void

  /**
   * Rename (move) a file to newPath.
   *
   * Throws if:
   * - No site is loaded.
   * - `newPath` fails isSafePath() (after normalization).
   * - Another file already occupies the normalized newPath.
   */
  renameFile(id: string, newPath: string): void

  /**
   * Update the text content of a file.
   * No-op if the id does not exist.
   * For 'asset' files use updateFileBlob() instead.
   */
  updateFileContent(id: string, content: string): void

  /**
   * Update the binary blob of an asset file.
   * No-op if the id does not exist.
   */
  updateFileBlob(id: string, blob: { mimeType: string; base64: string }): void
}

// ---------------------------------------------------------------------------
// Slice implementation
// ---------------------------------------------------------------------------

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends FilesSlice {}
}

/**
 * Every action routes through `mutateSiteState` rather than a raw `set`.
 * Site persistence is the collab relay: only mutations that produce site
 * patches are translated into Y operations, so a direct `set` updates this
 * tab's store and reaches neither the relay nor the database — the file looks
 * written, survives a readback, and is gone on reload.
 */
export const createFilesSlice: EditorStoreSliceCreator<FilesSlice> = (set, get) => {
  const { mutateSiteState } = buildSiteHelpers(set, get)

  return {
  createFile(path, type, content) {
    const { site } = get()
    if (!site) throw new Error('[filesSlice] Site document is not initialized')

    const normalized = normalizePath(path)
    if (!isSafePath(normalized)) {
      throw new Error(`[filesSlice] Invalid path: "${path}"`)
    }

    // Uniqueness — throw on collision (msg #1844 amendment)
    if (site.files.some((f) => f.path === normalized)) {
      throw new Error(`[filesSlice] A file at path "${normalized}" already exists`)
    }

    const now = Date.now()
    const id = nanoid()

    mutateSiteState((state, siteDraft) => {
      const newFile: SiteFile = {
        id,
        path: normalized,
        type,
        // For non-asset types, initialize content to provided value or empty string
        content: type !== 'asset' ? (content ?? '') : undefined,
        createdAt: now,
        updatedAt: now,
      }
      siteDraft.files.push(newFile)
      reconcileSiteExplorerInPlace(siteDraft)
      siteDraft.updatedAt = now
      void state
      return true
    })

    return id
  },

  createPageScript(pageId, content) {
    const { site } = get()
    if (!site) throw new Error('[filesSlice] Site document is not initialized')
    const page = site.pages.find((p) => p.id === pageId)
    if (!page) throw new Error(`[filesSlice] Page "${pageId}" not found`)

    const path = pageScriptPath(site.files, page)
    const now = Date.now()
    const id = nanoid()
    const config = pageScriptRuntimeConfig(pageId)

    mutateSiteState((state, siteDraft) => {
      siteDraft.files.push({ id, path, type: 'script', content, createdAt: now, updatedAt: now })
      reconcileSiteExplorerInPlace(siteDraft)
      writeSiteRuntimeDraft(state, siteDraft, {
        ...state.siteRuntime,
        scripts: { ...state.siteRuntime.scripts, [id]: config },
      })
      siteDraft.updatedAt = now
      return true
    })

    return id
  },

  deleteFile(id) {
    mutateSiteState((state, siteDraft) => {
      const idx = siteDraft.files.findIndex((f) => f.id === id)
      if (idx === -1) return false
      siteDraft.files.splice(idx, 1)
      writeSiteRuntimeDraft(state, siteDraft, siteRuntimeWithoutFile(state.siteRuntime, id))
      if (state.activeEditorFileId === id) state.activeEditorFileId = null
      reconcileSiteExplorerInPlace(siteDraft)
      siteDraft.updatedAt = Date.now()
      return true
    })
  },

  renameFile(id, newPath) {
    const { site } = get()
    if (!site) throw new Error('[filesSlice] Site document is not initialized')

    const normalized = normalizePath(newPath)
    if (!isSafePath(normalized)) {
      throw new Error(`[filesSlice] Invalid path: "${newPath}"`)
    }

    // Collision check — allow renaming to same path (no-op), reject if occupied by another file
    const occupant = site.files.find((f) => f.path === normalized)
    if (occupant && occupant.id !== id) {
      throw new Error(`[filesSlice] A file at path "${normalized}" already exists`)
    }

    mutateSiteState((state, siteDraft) => {
      const file = siteDraft.files.find((f) => f.id === id)
      if (!file) return false
      file.path = normalized
      file.updatedAt = Date.now()
      siteDraft.updatedAt = Date.now()
      void state
      return true
    })
  },

  updateFileContent(id, content) {
    mutateSiteState((state, siteDraft) => {
      const file = siteDraft.files.find((f) => f.id === id)
      if (!file) return false
      file.content = content
      if (file.generated) file.ejected = true
      file.updatedAt = Date.now()
      siteDraft.updatedAt = Date.now()
      void state
      return true
    })
  },

  updateFileBlob(id, blob) {
    mutateSiteState((state, siteDraft) => {
      const file = siteDraft.files.find((f) => f.id === id)
      if (!file) return false
      file.blob = blob
      if (file.generated) file.ejected = true
      file.updatedAt = Date.now()
      siteDraft.updatedAt = Date.now()
      void state
      return true
    })
  },
  }
}
