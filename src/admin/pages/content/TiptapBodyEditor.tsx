/**
 * Tiptap-based body editor for the content workspace.
 *
 * A single ProseMirror document — not a list of independent blocks. The
 * editor owns its own state (a Tiptap `Editor` instance); we lift only
 * the markdown projection out via `onChange`, and accept inbound markdown
 * via the `markdown` prop / `editorRef.setMarkdown`. The parent never
 * holds the doc tree.
 *
 * The editor exposes an imperative handle through `editorRef` for actions
 * that originate outside the canvas (the title-Enter focus jump; the
 * notch's "Add" / "Media" / "Heading" / "Text" / "Bind" buttons; the
 * media-picker confirmation, which has to splice an asset into the
 * document at the caret).
 */

import {
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
} from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import { TextAlign } from '@tiptap/extension-text-align'
import {
  markdownToProseMirrorDoc,
  proseMirrorDocToMarkdown,
} from '@core/markdown/markdownDocument'
import { MediaNode, type MediaAttributes } from './nodes/MediaNode'
import { ContentLinkAttributes } from './nodes/ContentLinkAttributes'
import { MediaUploadPlaceholder } from './nodes/MediaUploadPlaceholder'
import { useEditorMediaDrop } from './hooks/useEditorMediaDrop'
import {
  SlashCommand,
  type SlashCommandItem,
  type SlashExternalAction,
} from './components/BodySlashMenu/SlashCommand'
import {
  BodySlashMenu,
  type SlashMenuHandle,
} from './components/BodySlashMenu/BodySlashMenu'
import { BodyBubbleMenu } from './components/BodyBubbleMenu/BodyBubbleMenu'
import { BodyFloatingMenu } from './components/BodyFloatingMenu/BodyFloatingMenu'
import { MediaNodeToolbar } from './components/MediaNodeToolbar/MediaNodeToolbar'
import styles from './TiptapBodyEditor.module.css'

export interface TiptapBodyEditorHandle {
  /** Move focus into the editor (start of doc). */
  focusStart: () => void
  /** Insert plain text at the current selection. */
  insertText: (text: string) => void
  /** Insert a media node at the current selection (or replace selected media). */
  insertMedia: (attrs: MediaAttributes) => void
  /** Append a heading or paragraph at the end of the document. */
  appendBlock: (kind: 'heading' | 'paragraph') => void
}

export interface TiptapBodyEditorProps {
  markdown: string
  readOnly?: boolean
  /**
   * Counter bumped by the parent when the editor should focus the start
   * of its document (e.g. when the title field's Enter handler hands off
   * to the body). `0` is treated as "no focus requested yet".
   */
  focusSignal?: number
  editorRef?: Ref<TiptapBodyEditorHandle>
  onChange: (markdown: string) => void
  /**
   * Called when the user picks "Media" from the slash menu. The host
   * opens the media-picker modal; on confirm, it calls back into the
   * editor via `editorRef.insertMedia`.
   */
  onPickMedia: () => void
  /**
   * Called when the user picks "Data token" from the slash menu. The host
   * opens its data-binding dialog; on confirm, it calls
   * `editorRef.insertText('{source.field}')`.
   */
  onInsertDataToken: () => void
}

export function TiptapBodyEditor({
  markdown,
  readOnly = false,
  focusSignal = 0,
  editorRef,
  onChange,
  onPickMedia,
  onInsertDataToken,
}: TiptapBodyEditorProps) {
  // Slash menu handle. Mounted as a portal; the SlashCommand extension's
  // `render()` lifecycle calls back into this handle to open / update /
  // close the menu in response to ProseMirror events.
  const slashHandleRef = useRef<SlashMenuHandle | null>(null)
  // Latest external-action handlers; the extension is registered once
  // (via `useEditor`), so we read the current callbacks through a ref
  // rather than re-registering the extension when handlers change. The
  // ref is written in an effect (not during render) to satisfy the
  // react-compiler / react-hooks rules.
  const externalActionRef = useRef<(action: SlashExternalAction) => void>(() => undefined)
  useEffect(() => {
    externalActionRef.current = (action) => {
      if (action === 'media') onPickMedia()
      else if (action === 'dataToken') onInsertDataToken()
    }
  }, [onPickMedia, onInsertDataToken])

  // Paste / drop pipeline for inline media uploads. Returns the
  // ProseMirror handlers we spread into `editorProps` below, plus a
  // cancel callback that the placeholder NodeView's X button calls.
  // The hook owns its own AbortController map keyed by `uploadId`.
  const mediaEditorRef = useRef<Editor | null>(null)
  const mediaDrop = useEditorMediaDrop(mediaEditorRef)

  // The doc is parsed once at mount and fed to useEditor with an empty
  // deps array so the editor instance survives every parent re-render.
  // Subsequent inbound markdown changes (e.g. switching to a different
  // entry) are handled via `setContent` in the effect below.
  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      ContentLinkAttributes,
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        // The link extension's "open on click" handler is helpful in
        // read-only mode; in the editor we leave the default which
        // doesn't auto-navigate so the user can click into a link to
        // place the caret.
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
        },
      }),
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === 'heading') return 'Heading'
          return "Type '/' for commands, or just write…"
        },
        showOnlyCurrent: true,
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      // Alignment is persisted by the shared Markdown bridge.
      TextAlign.configure({
        types: ['paragraph', 'heading'],
        alignments: ['left', 'center', 'right', 'justify'],
        defaultAlignment: null,
      }),
      MediaNode,
      // Paste/drop placeholder + its cancel button wiring. The cancel
      // handler comes from the same hook that registers the editorProps
      // paste/drop handlers, so the X button on a placeholder NodeView
      // routes back to abort the in-flight XHR.
      MediaUploadPlaceholder.configure({
        onCancel: (uploadId) => mediaDrop.onCancel(uploadId),
      }),
      SlashCommand.configure({
        onExternal: (action) => externalActionRef.current(action),
        suggestion: {
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          command: ({ editor, range, props }) => {
            ;(props as SlashCommandItem).command({ editor, range })
          },
          render: () => ({
            onStart: (props) => {
              slashHandleRef.current?.open(
                props.editor,
                props.range,
                props.items as SlashCommandItem[],
                props.clientRect?.() ?? null,
              )
            },
            onUpdate: (props) => {
              slashHandleRef.current?.update(
                props.range,
                props.items as SlashCommandItem[],
                props.clientRect?.() ?? null,
              )
            },
            onKeyDown: ({ event }) => {
              return slashHandleRef.current?.onKeyDown(event) ?? false
            },
            onExit: () => {
              slashHandleRef.current?.close()
            },
          }),
        },
      }),
    ],
    content: markdownToProseMirrorDoc(markdown ?? ''),
    editorProps: {
      attributes: {
        class: styles.proseSurface,
        spellcheck: 'true',
        'aria-label': 'Post body',
        'data-testid': 'content-body-editor',
      },
      // Paste / drop handlers from `useEditorMediaDrop`: intercept files
      // and route them through `/admin/api/cms/media`, inserting a
      // progress placeholder at the drop position. Returns `false` for
      // non-media payloads so ProseMirror's default text-paste flow stays
      // intact.
      handlePaste: mediaDrop.editorProps.handlePaste as never,
      handleDrop: mediaDrop.editorProps.handleDrop as never,
    },
    onUpdate({ editor }) {
      onChange(proseMirrorDocToMarkdown(editor.getJSON()))
    },
  })

  // Sync inbound markdown changes (e.g. user switched to a different
  // entry). Tiptap won't re-mount on `markdown` changes alone — we have
  // to call `setContent` ourselves. Guard against the no-op case so we
  // don't blow away the caret on every keystroke.
  const lastSyncedMarkdownRef = useRef(markdown)
  useEffect(() => {
    if (!editor) return
    if (markdown === lastSyncedMarkdownRef.current) return
    const currentSerialized = proseMirrorDocToMarkdown(editor.getJSON())
    if (currentSerialized === markdown) {
      lastSyncedMarkdownRef.current = markdown
      return
    }
    lastSyncedMarkdownRef.current = markdown
    editor.commands.setContent(markdownToProseMirrorDoc(markdown), { emitUpdate: false })
  }, [editor, markdown])

  // Sync read-only flag.
  useEffect(() => {
    if (!editor) return
    if (editor.isEditable === !readOnly) return
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  // Keep the media-drop hook pointed at the live editor instance so its
  // paste/drop handlers (registered once via `editorProps`) can mutate the
  // doc. `useEditor` returns null on first render and the real instance
  // on the next, so this effect snapshots that transition.
  useEffect(() => {
    mediaEditorRef.current = editor
    return () => {
      mediaEditorRef.current = null
    }
  }, [editor])

  // Focus signal from the parent (title-Enter handoff, new-entry create).
  useEffect(() => {
    if (focusSignal === 0 || !editor || readOnly) return
    editor.commands.focus('start')
  }, [focusSignal, editor, readOnly])

  // Imperative handle.
  useImperativeHandle(
    editorRef,
    (): TiptapBodyEditorHandle => ({
      focusStart: () => editor?.commands.focus('start'),
      insertText: (text) => editor?.chain().focus().insertContent(text).run(),
      insertMedia: (attrs) => {
        if (!editor) return
        const isMediaSelected = editor.isActive('media')
        if (isMediaSelected) {
          editor.chain().focus().updateAttributes('media', attrs).run()
        } else {
          editor.chain().focus().insertContent({ type: 'media', attrs }).run()
        }
      },
      appendBlock: (kind) => {
        if (!editor) return
        const node =
          kind === 'heading'
            ? { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] }
            : { type: 'paragraph' }
        editor.chain().focus('end').insertContent(node).run()
      },
    }),
    [editor],
  )

  // Render scaffolding.
  return (
    <div className={styles.shell}>
      <EditorContent editor={editor} />
      {editor && !readOnly && (
        <>
          <BodyBubbleMenu editor={editor} />
          <BodyFloatingMenu editor={editor} onPickMedia={onPickMedia} />
          <MediaNodeToolbar editor={editor} onPickMedia={onPickMedia} />
        </>
      )}
      <BodySlashMenu handleRef={slashHandleRef} />
    </div>
  )
}
