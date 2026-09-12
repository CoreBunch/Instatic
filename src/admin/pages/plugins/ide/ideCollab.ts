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
 *
 * Two lifecycle rules keep the session honest:
 *   - Nothing writes before the server's initial sync. An unsynced doc has
 *     no `files` map yet; creating one client-side would win the merge
 *     (the server seeds with client id 1) and replace EVERY site file with
 *     the one just created. Every mutating method throws
 *     `IdeNotSyncedError` until `synced()` is true.
 *   - A relay reset (`FRAME_RESET` — an out-of-relay shell write such as a
 *     scaffold, a delete, a settings save, or an import reseeded the doc)
 *     destroys the bound Y.Doc. The session rebinds immediately, bumps its
 *     `generation`, and drops the undo managers that referenced the dead
 *     Y.Text; editors key their mounts on the generation so the buffer
 *     remounts onto the fresh text instead of typing into a destroyed one.
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
  type BoundCollabDoc,
  type CollabProvider,
} from '@site/collab/collabProvider'

/** Origin for IDE-local transactions — streamed by the provider (≠ remote). */
export const IDE_ORIGIN = Symbol('plugin-ide-local')

/** Thrown by every mutating session method before the initial sync lands. */
export class IdeNotSyncedError extends Error {
  constructor() {
    super('The live draft is still connecting — try again in a moment.')
    this.name = 'IdeNotSyncedError'
  }
}

export interface IdeFileMeta {
  id: string
  path: string
  updatedAt: number
}

export interface IdeCollabSession {
  provider: CollabProvider
  /**
   * True once the server's initial sync landed for the CURRENT binding —
   * false again during a relay reset until the reseeded doc arrives.
   */
  synced(): boolean
  /** Fires on every sync transition, including the rebind after a reset. */
  onSyncChange(listener: () => void): () => void
  /**
   * Increments on every rebind. Editors key their mounts on it so a reset
   * remounts the buffer onto the fresh Y.Text.
   */
  generation(): number
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

function notify(listeners: ReadonlySet<() => void>): void {
  for (const listener of listeners) listener()
}

export function createIdeCollabSession(localId: string): IdeCollabSession {
  const provider = createCollabProvider()
  const folder = sitePluginFolder(localId)
  const filesListeners = new Set<() => void>()
  const syncListeners = new Set<() => void>()
  const undoManagers = new Map<string, Y.UndoManager>()
  let binding: BoundCollabDoc
  let generation = 0
  let destroyed = false
  let filesCache: { signature: string; files: IdeFileMeta[] } = { signature: '', files: [] }

  const shell = (): Y.Map<unknown> => shellMap(binding.doc)

  // Observe the whole shell deeply — file metadata changes (path renames,
  // membership) re-notify; pure content keystrokes also fire but the hook
  // layer collapses them via a metadata signature, so React work stays
  // proportional to structural changes.
  const shellObserver = (): void => notify(filesListeners)

  const attach = (): void => {
    binding = provider.bind(MAIN_SITE_DOC_ID)
    shell().observeDeep(shellObserver)
    const bound = binding
    void bound.whenSynced.then(() => {
      // A binding unbound by a reset resolves its promise too — only the
      // current binding's sync is news.
      if (destroyed || binding !== bound) return
      notify(syncListeners)
      notify(filesListeners)
    })
  }
  attach()

  const detachReset = provider.onReset((docId) => {
    if (docId !== MAIN_SITE_DOC_ID || destroyed) return
    // The provider already destroyed the old doc; the undo managers hold
    // its Y.Text instances and must not outlive it.
    for (const manager of undoManagers.values()) manager.destroy()
    undoManagers.clear()
    generation += 1
    attach()
    notify(syncListeners)
    notify(filesListeners)
  })

  const filesMap = (): Y.Map<unknown> | null => {
    const value = shell().get('files')
    return value instanceof Y.Map ? value : null
  }

  /**
   * The granular files map, upgrading a legacy LWW-array layout in place —
   * from the EXISTING entries, never an empty map (an empty replacement
   * would project a shell that lost every other site file). Must run
   * inside a doc transaction, after sync.
   */
  const ensureFilesMap = (): Y.Map<unknown> => {
    const current = shell()
    const value = current.get('files')
    if (value instanceof Y.Map) return value
    if (Array.isArray(value)) {
      const map = buildSiteFilesMap(value as SiteFile[])
      current.set('files', map)
      return map
    }
    // Absent after sync means the server seed is broken. Never paper over
    // it with an empty map — that map would win the merge and erase every
    // other site file.
    throw new Error('The live draft has no files map — refusing to write')
  }

  const assertWritable = (): void => {
    if (destroyed) throw new Error('The Plugin IDE session is closed')
    if (!binding.synced) throw new IdeNotSyncedError()
  }

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
    const value = shell().get('files')
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
    synced: () => binding.synced,
    onSyncChange: (listener) => {
      syncListeners.add(listener)
      return () => {
        syncListeners.delete(listener)
      }
    },
    generation: () => generation,

    pluginFiles: () => {
      const next = allFileMetas()
        .filter((file) => file.path.startsWith(folder))
        .sort((a, b) => a.path.localeCompare(b.path))
      // Same array back while ids and paths are unchanged, so a keystroke
      // (which fires the same observer) is not a structural change to
      // whoever renders the list.
      const signature = next.map((file) => `${file.id}:${file.path}`).join('|')
      if (signature !== filesCache.signature) filesCache = { signature, files: next }
      return filesCache.files
    },

    onFilesChange: (listener) => {
      filesListeners.add(listener)
      return () => {
        filesListeners.delete(listener)
      }
    },

    contentText: (fileId) => siteFileContentText(shell(), fileId),

    undoManagerFor: (fileId) => {
      const existing = undoManagers.get(fileId)
      if (existing) return existing
      const text = siteFileContentText(shell(), fileId)
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
      assertWritable()
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
      binding.doc.transact(() => {
        ensureFilesMap().set(id, buildSiteFileEntry(file))
      }, IDE_ORIGIN)
      return id
    },

    renameFile: (fileId, nextPath) => {
      assertWritable()
      const path = requireSafePluginPath(nextPath)
      if (pathTaken(path, fileId)) throw new Error(`A file at "${path}" already exists`)
      binding.doc.transact(() => {
        const entry = ensureFilesMap().get(fileId)
        if (!(entry instanceof Y.Map)) return
        entry.set('path', path)
        entry.set('updatedAt', Date.now())
      }, IDE_ORIGIN)
    },

    deleteFile: (fileId) => {
      assertWritable()
      undoManagers.get(fileId)?.destroy()
      undoManagers.delete(fileId)
      binding.doc.transact(() => {
        ensureFilesMap().delete(fileId)
      }, IDE_ORIGIN)
    },

    replaceFileContent: (fileId, content) => {
      assertWritable()
      binding.doc.transact(() => {
        const entry = ensureFilesMap().get(fileId)
        if (!(entry instanceof Y.Map)) return
        const text = entry.get('content')
        if (!(text instanceof Y.Text)) return
        applyTextDiff(text, text.toString(), content)
        entry.set('updatedAt', Date.now())
      }, IDE_ORIGIN)
    },

    destroy: () => {
      destroyed = true
      detachReset()
      for (const manager of undoManagers.values()) manager.destroy()
      undoManagers.clear()
      provider.destroy()
    },
  }
}
