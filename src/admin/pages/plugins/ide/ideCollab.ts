/**
 * Plugin IDE collab session — the IDE's own bridge onto the site collab
 * socket. Binds ONLY the site doc (`site:default`): plugin source files
 * live in the shell's granular `files` Y.Map (entry per file id, `content`
 * as Y.Text), so the IDE co-edits with the same machinery as the site
 * editor — server-seeded docs, character-level merges, presence over the
 * shared awareness — without loading pages, trees, or the editor store.
 *
 * File CRUD happens as direct Y transactions (IDE_ORIGIN); the relay
 * persists on its debounce and the site editor's projection picks changes
 * up live. Per-file Y.UndoManagers give each buffer its own local-only
 * undo (the yCollab binding registers its origin on them).
 */
import * as Y from 'yjs'
import {
  applyTextDiff,
  buildSiteFileEntry,
  buildSiteFilesMap,
  shellMap,
  siteFileContentText,
  MAIN_SITE_DOC_ID,
} from '@core/collab'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import type { SiteFile } from '@core/files/schemas'
import { sitePluginFolder } from '@core/site-plugins'
import { nanoid } from 'nanoid'
import {
  createCollabProvider,
  type CollabProvider,
} from '@site/collab/collabProvider'

/** Origin for IDE-local transactions — streamed by the provider (≠ remote). */
export const IDE_ORIGIN = Symbol('plugin-ide-local')

export interface IdeFileMeta {
  id: string
  path: string
  updatedAt: number
}

export interface IdeCollabSession {
  provider: CollabProvider
  doc: Y.Doc
  whenSynced: Promise<void>
  synced(): boolean
  /** Metadata of this plugin's files, path-sorted. Content stays in Y.Text. */
  pluginFiles(): IdeFileMeta[]
  onFilesChange(listener: () => void): () => void
  contentText(fileId: string): Y.Text | null
  /** Per-file undo manager (created on demand; local origins only). */
  undoManagerFor(fileId: string): Y.UndoManager | null
  createFile(path: string, content?: string): string
  renameFile(fileId: string, nextPath: string): void
  deleteFile(fileId: string): void
  /**
   * Whole-value content replace as a minimal Y.Text splice (AI agent write
   * path) — concurrent remote edits outside the changed span survive.
   */
  replaceFileContent(fileId: string, content: string): void
  destroy(): void
}

function projectFileMeta(id: string, entry: Y.Map<unknown>): IdeFileMeta {
  const path = entry.get('path')
  const updatedAt = entry.get('updatedAt')
  return {
    id,
    path: typeof path === 'string' ? path : '',
    updatedAt: typeof updatedAt === 'number' ? updatedAt : 0,
  }
}

export function createIdeCollabSession(localId: string): IdeCollabSession {
  const provider = createCollabProvider()
  const binding = provider.bind(MAIN_SITE_DOC_ID)
  const doc = binding.doc
  const folder = sitePluginFolder(localId)
  const filesListeners = new Set<() => void>()
  const undoManagers = new Map<string, Y.UndoManager>()
  let observedFilesMap: Y.Map<unknown> | null = null

  const notifyFiles = (): void => {
    for (const listener of filesListeners) listener()
  }

  const filesMap = (): Y.Map<unknown> | null => {
    const value = shellMap(doc).get('files')
    return value instanceof Y.Map ? value : null
  }

  /**
   * The granular files map, upgrading a legacy LWW-array layout in place —
   * from the EXISTING entries, never an empty map (an empty replacement
   * would project a shell that lost every other site file). Must run
   * inside a doc transaction.
   */
  const ensureFilesMap = (): Y.Map<unknown> => {
    const shell = shellMap(doc)
    const value = shell.get('files')
    if (value instanceof Y.Map) return value
    const map = Array.isArray(value)
      ? buildSiteFilesMap(value as SiteFile[])
      : new Y.Map<unknown>()
    shell.set('files', map)
    return map
  }

  // Observe the whole shell deeply — file metadata changes (path renames,
  // membership) re-notify; pure content keystrokes also fire but the hook
  // layer collapses them via a metadata signature, so React work stays
  // proportional to structural changes.
  const shellObserver = (): void => {
    const current = filesMap()
    if (current !== observedFilesMap) observedFilesMap = current
    notifyFiles()
  }
  shellMap(doc).observeDeep(shellObserver)

  /** id/path metas across BOTH layouts (granular map, legacy LWW array). */
  const allFileMetas = (): IdeFileMeta[] => {
    const map = filesMap()
    if (map) {
      const out: IdeFileMeta[] = []
      for (const [id, entry] of map.entries()) {
        if (entry instanceof Y.Map) out.push(projectFileMeta(id, entry))
      }
      return out
    }
    const value = shellMap(doc).get('files')
    if (!Array.isArray(value)) return []
    return (value as SiteFile[]).map((file) => ({
      id: file.id,
      path: file.path,
      updatedAt: file.updatedAt,
    }))
  }

  const pathTaken = (path: string, exceptFileId?: string): boolean =>
    allFileMetas().some((file) => file.id !== exceptFileId && file.path === path)

  const requireSafePluginPath = (rawPath: string): string => {
    const normalized = normalizePath(rawPath)
    if (!normalized || !isSafePath(normalized)) {
      throw new Error(`Invalid path: "${rawPath}"`)
    }
    if (!normalized.startsWith(folder)) {
      throw new Error(`Site plugin files must stay under ${folder}`)
    }
    return normalized
  }

  return {
    provider,
    doc,
    whenSynced: binding.whenSynced,
    synced: () => binding.synced,

    pluginFiles: () =>
      allFileMetas()
        .filter((file) => file.path.startsWith(folder))
        .sort((a, b) => a.path.localeCompare(b.path)),

    onFilesChange: (listener) => {
      filesListeners.add(listener)
      return () => {
        filesListeners.delete(listener)
      }
    },

    contentText: (fileId) => siteFileContentText(shellMap(doc), fileId),

    undoManagerFor: (fileId) => {
      const existing = undoManagers.get(fileId)
      if (existing) return existing
      const text = siteFileContentText(shellMap(doc), fileId)
      if (!text) return null
      // Tracks IDE transactions + whatever origins the yCollab binding
      // registers on it; remote peers' edits are never undone locally.
      const manager = new Y.UndoManager(text, {
        trackedOrigins: new Set([IDE_ORIGIN]),
        captureTimeout: 500,
      })
      undoManagers.set(fileId, manager)
      return manager
    },

    createFile: (rawPath, content = '') => {
      const path = requireSafePluginPath(rawPath)
      if (pathTaken(path)) throw new Error(`A file at "${path}" already exists`)
      const id = nanoid()
      const now = Date.now()
      const file: SiteFile = {
        id,
        path,
        type: 'plugin',
        content,
        createdAt: now,
        updatedAt: now,
      }
      doc.transact(() => {
        ensureFilesMap().set(id, buildSiteFileEntry(file))
      }, IDE_ORIGIN)
      return id
    },

    renameFile: (fileId, nextPath) => {
      const path = requireSafePluginPath(nextPath)
      if (pathTaken(path, fileId)) throw new Error(`A file at "${path}" already exists`)
      doc.transact(() => {
        const entry = ensureFilesMap().get(fileId)
        if (!(entry instanceof Y.Map)) return
        entry.set('path', path)
        entry.set('updatedAt', Date.now())
      }, IDE_ORIGIN)
    },

    deleteFile: (fileId) => {
      undoManagers.get(fileId)?.destroy()
      undoManagers.delete(fileId)
      doc.transact(() => {
        ensureFilesMap().delete(fileId)
      }, IDE_ORIGIN)
    },

    replaceFileContent: (fileId, content) => {
      doc.transact(() => {
        const entry = ensureFilesMap().get(fileId)
        if (!(entry instanceof Y.Map)) return
        const text = entry.get('content')
        if (!(text instanceof Y.Text)) return
        applyTextDiff(text, text.toString(), content)
        entry.set('updatedAt', Date.now())
      }, IDE_ORIGIN)
    },

    destroy: () => {
      shellMap(doc).unobserveDeep(shellObserver)
      for (const manager of undoManagers.values()) manager.destroy()
      undoManagers.clear()
      provider.destroy()
    },
  }
}
