/**
 * Transient Tiptap node used while a pasted / dropped file is uploading.
 *
 * The editor inserts one of these at the drop position the instant a file
 * lands on the canvas, then the paste / drop handler races the upload in
 * the background. On success the placeholder is replaced with a real
 * `media` node (`MediaNode`); on failure it's replaced with an error
 * indicator the author can dismiss.
 *
 * Crucial property: this node **never serialises** to markdown. The
 * `proseMirrorDocToMarkdown` walker only knows about `paragraph`,
 * `heading`, `bulletList`, …, `media`, etc. — `mediaUploadPlaceholder`
 * isn't in the list so a save mid-upload simply drops the placeholder.
 * That's the intended behaviour: there's nothing meaningful to persist
 * until the upload finishes.
 *
 * The placeholder is intentionally not selectable as a Tiptap selection
 * target — it doesn't accept the caret, can't be wrapped in marks, can't
 * be cut/copied. It's a UI shell.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { MediaUploadPlaceholderView } from './MediaUploadPlaceholderView'

export type MediaUploadKind = 'image' | 'video'
type MediaUploadStatus = 'uploading' | 'failed'

interface MediaUploadPlaceholderOptions {
  /**
   * Called when the user clicks the cancel/dismiss button on the
   * placeholder. The host aborts the in-flight upload (via the
   * `AbortSignal` it passed to `uploadMediaInline`) and removes the
   * placeholder node from the doc. The node itself doesn't know how to
   * remove itself cleanly — finding the right position requires
   * walking the doc, which the host already does for the success-path
   * replacement.
   */
  onCancel: (uploadId: string) => void
}

export interface MediaUploadPlaceholderAttributes {
  /** Stable identifier the host uses to find this placeholder for replacement. */
  uploadId: string
  filename: string
  kind: MediaUploadKind
  /** 0..1 — driven by XHR upload-progress events. */
  progress: number
  status: MediaUploadStatus
  /** Optional error message when `status === 'failed'`. */
  error: string | null
  /** Object URL of the source File so we can show a thumbnail. Caller revokes on swap. */
  previewUrl: string | null
}

export const MEDIA_UPLOAD_PLACEHOLDER_NAME = 'mediaUploadPlaceholder'

export const MediaUploadPlaceholder = Node.create<MediaUploadPlaceholderOptions>({
  name: MEDIA_UPLOAD_PLACEHOLDER_NAME,
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,

  addOptions() {
    return {
      onCancel: () => undefined,
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(MediaUploadPlaceholderView)
  },

  addAttributes() {
    return {
      uploadId: { default: '' },
      filename: { default: '' },
      kind: { default: 'image' as MediaUploadKind },
      progress: { default: 0 },
      status: { default: 'uploading' as MediaUploadStatus },
      error: { default: null as string | null },
      previewUrl: { default: null as string | null },
    }
  },

  // The placeholder is editor-only — it never appears in saved markdown
  // and never appears in published HTML. We still implement parseHTML +
  // renderHTML for completeness; ProseMirror requires `renderHTML` on
  // every node and won't accept a node-view-only render path here.
  parseHTML() {
    return [{ tag: 'div[data-instatic-upload-placeholder]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as MediaUploadPlaceholderAttributes
    const progressPct = Math.round(Math.max(0, Math.min(1, attrs.progress)) * 100)
    const stateText = attrs.status === 'failed'
      ? `Upload failed: ${attrs.error ?? 'unknown error'}`
      : `Uploading ${attrs.filename}… ${progressPct}%`
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-instatic-upload-placeholder': '',
        'data-instatic-upload-id': attrs.uploadId,
        'data-instatic-upload-status': attrs.status,
        'data-instatic-upload-progress': String(progressPct),
        role: 'status',
        'aria-live': 'polite',
      }),
      stateText,
    ]
  },
})
