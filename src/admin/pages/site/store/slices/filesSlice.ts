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

export const createFilesSlice: EditorStoreSliceCreator<FilesSlice> = (set, get) => ({
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

    set((state) => {
        if (!state.site) return
        const newFile: SiteFile = {
          id,
          path: normalized,
          type,
          // For non-asset types, initialize content to provided value or empty string
          content: type !== 'asset' ? (content ?? '') : undefined,
          createdAt: now,
          updatedAt: now,
        }
        state.site.files.push(newFile)
        reconcileSiteExplorerInPlace(state.site)
        state.site.updatedAt = now
      })

    return id
  },

  deleteFile(id) {
    set((state) => {
        if (!state.site) return
        const idx = state.site.files.findIndex((f) => f.id === id)
        if (idx === -1) return
        state.site.files.splice(idx, 1)
        if (state.site.runtime?.scripts) delete state.site.runtime.scripts[id]
        if (state.site.runtime?.styles) delete state.site.runtime.styles[id]
        delete state.siteRuntime.scripts[id]
        delete state.siteRuntime.styles[id]
        if (state.activeEditorFileId === id) state.activeEditorFileId = null
        reconcileSiteExplorerInPlace(state.site)
        state.site.updatedAt = Date.now()
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

    set((state) => {
        if (!state.site) return
        const file = state.site.files.find((f) => f.id === id)
        if (!file) return
        file.path = normalized
        file.updatedAt = Date.now()
        state.site.updatedAt = Date.now()
      })
  },

  updateFileContent(id, content) {
    set((state) => {
        if (!state.site) return
        const file = state.site.files.find((f) => f.id === id)
        if (!file) return
        file.content = content
        if (file.generated) file.ejected = true
        file.updatedAt = Date.now()
        state.site.updatedAt = Date.now()
      })
  },

  updateFileBlob(id, blob) {
    set((state) => {
        if (!state.site) return
        const file = state.site.files.find((f) => f.id === id)
        if (!file) return
        file.blob = blob
        if (file.generated) file.ejected = true
        file.updatedAt = Date.now()
        state.site.updatedAt = Date.now()
      })
  },
})
