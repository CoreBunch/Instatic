/**
 * Paste / drop file handlers for the body editor.
 *
 * Returns the `editorProps` ProseMirror handlers and an extension cancel
 * callback in a stable shape that `TiptapBodyEditor` plugs into Tiptap's
 * `useEditor` config. The hook owns the per-upload abort controllers and
 * placeholder-tracking state.
 *
 * Flow per dropped/pasted file:
 *   1. ProseMirror sees a `dragover` / `paste` event carrying image/video files.
 *   2. We synthesise a `mediaUploadPlaceholder` node at the drop position (or
 *      at the caret for paste) with a stable `uploadId` and a local object-URL
 *      preview.
 *   3. We kick off `uploadMediaInline` against `/admin/api/cms/media` with an
 *      AbortController, updating the placeholder's `progress` attr as bytes
 *      stream.
 *   4. On success: walk the doc to find the placeholder by `uploadId` and
 *      replace it with a real `media` node. Revoke the preview URL.
 *   5. On failure: flip the placeholder to `status: 'failed'` and set its
 *      `error` attr — the user can click the X to remove it.
 *   6. On cancel: abort the XHR and delete the placeholder from the doc.
 */

import { useEffect, useRef } from 'react'
import { nanoid } from 'nanoid'
import type { Editor } from '@tiptap/core'
import { MEDIA_UPLOAD_PLACEHOLDER_NAME, type MediaUploadKind } from '../nodes/MediaUploadPlaceholder'
import { mediaKindOf, uploadMediaInline } from './uploadMediaInline'
import { getErrorMessage } from '@core/utils/errorMessage'

interface PendingUpload {
  controller: AbortController
  previewUrl: string | null
}

interface UseEditorMediaDropResult {
  /** Spread into `useEditor({ editorProps })` to bind paste/drop. */
  editorProps: {
    handlePaste: (view: EditorViewLike, event: ClipboardEvent) => boolean
    handleDrop: (view: EditorViewLike, event: DragEvent, _slice: unknown, moved: boolean) => boolean
  }
  /** Pass to `MediaUploadPlaceholder.configure({ onCancel })` so the X button works. */
  onCancel: (uploadId: string) => void
}

// Narrow shape we need from `EditorView`; importing the type from
// `@tiptap/pm/view` would force its full transitive deps onto the
// public typescript surface here.
interface EditorViewLike {
  state: {
    tr: {
      replaceSelectionWith: (node: ProseMirrorNode) => unknown
      insert: (pos: number, node: ProseMirrorNode) => unknown
      scrollIntoView: () => unknown
    }
    schema: {
      nodes: Record<string, NodeTypeLike>
    }
  }
  dispatch: (tr: unknown) => void
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null
}

interface NodeTypeLike {
  create: (attrs: Record<string, unknown>) => ProseMirrorNode
}

interface ProseMirrorNode {
  type: { name: string }
  attrs: Record<string, unknown>
}

export function useEditorMediaDrop(editorRef: { current: Editor | null }): UseEditorMediaDropResult {
  const pendingRef = useRef(new Map<string, PendingUpload>())

  // Abort + clean up all in-flight uploads if the editor unmounts (e.g.
  // user navigates away mid-upload). Otherwise the AbortControllers leak
  // and the XHRs keep running.
  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      for (const [, upload] of pending) {
        upload.controller.abort()
        if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl)
      }
      pending.clear()
    }
  }, [])

  // Defined before `startUpload` because `startUpload` references it
  // inside the upload's settle path. The reverse order would trip the
  // react-hooks immutability lint (and require a ref to dodge a TDZ
  // false-positive). Plain top-down declaration is clearer.
  const finalisePending = (uploadId: string) => {
    const entry = pendingRef.current.get(uploadId)
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl)
    pendingRef.current.delete(uploadId)
  }

  const startUpload = (editor: Editor, file: File, insertPos: number | null) => {
    const kind = mediaKindOf(file)
    if (!kind) return false

    const uploadId = `upload_${nanoid(8)}`
    const previewUrl = URL.createObjectURL(file)
    const controller = new AbortController()
    pendingRef.current.set(uploadId, { controller, previewUrl })

    const attrs = {
      uploadId,
      filename: file.name || 'untitled',
      kind,
      progress: 0,
      status: 'uploading',
      error: null,
      previewUrl,
    }

    // Insert the placeholder at the drop position (or current selection
    // for paste). We use `chain().insertContentAt(...)` for an explicit
    // position when we know one; otherwise `insertContent` falls back to
    // the selection.
    const chain = editor.chain().focus()
    if (insertPos !== null) {
      chain.insertContentAt(insertPos, {
        type: MEDIA_UPLOAD_PLACEHOLDER_NAME,
        attrs,
      })
    } else {
      chain.insertContent({
        type: MEDIA_UPLOAD_PLACEHOLDER_NAME,
        attrs,
      })
    }
    chain.run()

    void uploadMediaInline({
      file,
      signal: controller.signal,
      onProgress: (progress) => {
        updatePlaceholder(editor, uploadId, { progress })
      },
    })
      .then((asset) => {
        replacePlaceholderWithMedia(editor, uploadId, {
          mediaType: kind,
          src: asset.publicPath,
          alt: kind === 'image' ? (asset.filename ?? '') : '',
        })
        finalisePending(uploadId)
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // Cancellation already removed the placeholder; nothing else to do.
          finalisePending(uploadId)
          return
        }
        const message = getErrorMessage(err, 'Upload failed')
        updatePlaceholder(editor, uploadId, { status: 'failed', error: message, progress: 1 })
        // Keep the preview URL alive so the failed-state thumbnail still
        // renders. The user clicks the X to dismiss → that path revokes.
      })

    return true
  }

  const onCancel = (uploadId: string) => {
    const entry = pendingRef.current.get(uploadId)
    entry?.controller.abort()
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl)
    pendingRef.current.delete(uploadId)
    const editor = editorRef.current
    if (editor) removePlaceholder(editor, uploadId)
  }

  const editorProps = {
    handlePaste(_view: EditorViewLike, event: ClipboardEvent): boolean {
      const editor = editorRef.current
      if (!editor) return false
      const files = collectFiles(event.clipboardData)
      if (files.length === 0) return false
      event.preventDefault()
      let consumed = false
      for (const file of files) {
        if (startUpload(editor, file, null)) consumed = true
      }
      return consumed
    },
    handleDrop(view: EditorViewLike, event: DragEvent, _slice: unknown, moved: boolean): boolean {
      // Internal drag (block reorder, etc.) — let ProseMirror handle it.
      if (moved) return false
      const editor = editorRef.current
      if (!editor) return false
      const files = collectFiles(event.dataTransfer)
      if (files.length === 0) return false
      event.preventDefault()

      const coords = { left: event.clientX, top: event.clientY }
      const pos = view.posAtCoords(coords)?.pos ?? null

      let consumed = false
      for (const file of files) {
        if (startUpload(editor, file, pos)) consumed = true
      }
      return consumed
    },
  }

  return { editorProps, onCancel }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files: File[] = []
  for (let i = 0; i < transfer.files.length; i++) {
    const file = transfer.files.item(i)
    if (file && mediaKindOf(file)) files.push(file)
  }
  return files
}

/**
 * Find the position of the `mediaUploadPlaceholder` node whose
 * `uploadId` matches and apply `mutator(pos, node)` to it inside a
 * single transaction. Returns true if the placeholder was found.
 */
function withPlaceholder(
  editor: Editor,
  uploadId: string,
  mutator: (pos: number, node: { nodeSize: number }) => unknown,
): boolean {
  let found = false
  editor.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === MEDIA_UPLOAD_PLACEHOLDER_NAME && node.attrs.uploadId === uploadId) {
      mutator(pos, node as unknown as { nodeSize: number })
      found = true
      return false
    }
    return true
  })
  return found
}

function updatePlaceholder(
  editor: Editor,
  uploadId: string,
  patch: Partial<{
    progress: number
    status: 'uploading' | 'failed'
    error: string | null
  }>,
): void {
  withPlaceholder(editor, uploadId, (pos) => {
    editor
      .chain()
      .command(({ tr, state }) => {
        const node = state.doc.nodeAt(pos)
        if (!node) return false
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
        return true
      })
      .run()
  })
}

function replacePlaceholderWithMedia(
  editor: Editor,
  uploadId: string,
  attrs: { mediaType: MediaUploadKind; src: string; alt: string },
): void {
  withPlaceholder(editor, uploadId, (pos, node) => {
    editor
      .chain()
      .command(({ tr, state }) => {
        const mediaType = state.schema.nodes['media']
        if (!mediaType) return false
        tr.replaceWith(pos, pos + node.nodeSize, mediaType.create(attrs))
        return true
      })
      .run()
  })
}

function removePlaceholder(editor: Editor, uploadId: string): void {
  withPlaceholder(editor, uploadId, (pos, node) => {
    editor
      .chain()
      .command(({ tr }) => {
        tr.delete(pos, pos + node.nodeSize)
        return true
      })
      .run()
  })
}
