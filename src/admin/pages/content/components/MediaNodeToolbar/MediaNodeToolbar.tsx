/**
 * Floating toolbar that appears when a `media` node is selected.
 *
 * Tiptap's `BubbleMenu` plugin is built around text-range selections,
 * but it also fires on `NodeSelection` (the type Tiptap uses when you
 * click a media node). We use a custom `shouldShow` that returns true
 * iff the active selection IS a single media node, and we render a
 * compact action bar with the three operations authors actually want
 * on an image / video:
 *
 *   - **Replace** — open the media picker; on confirm the host's
 *     `insertMedia` already detects an existing media node and updates
 *     its attrs in place (no need for a separate "update attrs" call
 *     here — `editorRef.insertMedia` does the right thing).
 *   - **Alt text** — inline editor for the `alt` attribute (images
 *     only; videos don't render alt text). Persists on `Enter` / blur.
 *   - **Delete** — remove the media node.
 *
 * The toolbar lives in its own component (separate from `BodyBubbleMenu`
 * because the two have completely different `shouldShow` triggers + UI
 * shapes — sharing a parent BubbleMenu would force one of them to win).
 */

import { useState, type FormEvent } from 'react'
import { NodeSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import type { VirtualElement } from '@floating-ui/dom'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import styles from './MediaNodeToolbar.module.css'

interface MediaNodeToolbarProps {
  editor: Editor
  /**
   * Opens the host's media-picker modal. The host's existing pick
   * handler routes through the editor's imperative ref and either
   * inserts or updates the media node in place — so the toolbar's
   * "Replace" action just needs to open the picker.
   */
  onPickMedia: () => void
  /**
   * When set, the editor lives inside this iframe and the toolbar
   * needs to render in the host document but position over the
   * iframe's contents. See `BodyBubbleMenu` for the same pattern.
   */
  iframeEl?: HTMLIFrameElement | null
}

interface MediaSelectionState {
  /** True when the active selection is a single media node. */
  isMediaSelected: boolean
  /** Current attrs (defaults when nothing selected). */
  mediaType: 'image' | 'video'
  alt: string
  src: string
}

export function MediaNodeToolbar({ editor, onPickMedia, iframeEl }: MediaNodeToolbarProps) {
  // Iframe-aware overrides for the underlying BubbleMenu plugin — see
  // `BodyBubbleMenu` for the same pattern. The reference rect is the
  // selected media node's DOM rect (not selection coords) so the
  // toolbar lines up against the asset, not the caret.
  const iframeOverrides = !iframeEl
    ? undefined
    : {
        appendTo: () => document.body,
        options: {
          strategy: 'fixed' as const,
          // Same boundary clipping as `BodyBubbleMenu` — keep the
          // toolbar inside the iframe's visible region so it never
          // drifts behind the host's content sidebar.
          shift: { boundary: iframeEl, padding: 8 },
          flip: { boundary: iframeEl, padding: 8 },
        },
        getReferencedVirtualElement: (): VirtualElement | null => {
          if (editor.isDestroyed) return null
          const sel = editor.state.selection
          if (!(sel instanceof NodeSelection)) return null
          const dom = editor.view.nodeDOM(sel.from) as HTMLElement | null
          if (!dom || typeof dom.getBoundingClientRect !== 'function') return null
          const nodeRect = dom.getBoundingClientRect()
          const iframeRect = iframeEl.getBoundingClientRect()
          const left = nodeRect.left + iframeRect.left
          const top = nodeRect.top + iframeRect.top
          const right = nodeRect.right + iframeRect.left
          const bottom = nodeRect.bottom + iframeRect.top
          return {
            getBoundingClientRect: () => ({
              x: left,
              y: top,
              width: right - left,
              height: bottom - top,
              top,
              left,
              bottom,
              right,
            }),
          }
        },
      }

  // Editing state for the alt-text inline editor. Keyed by `src` so a
  // user switching to a different media node naturally invalidates a
  // stale open editor — no useEffect cleanup, no set-state-in-effect
  // lint trap. When the rendered `src` doesn't match the captured one,
  // `showAltEditor` is false and we render the read-only toolbar.
  const [altDraft, setAltDraft] = useState<{ src: string; value: string } | null>(null)

  // Re-render whenever the selection changes so attrs (esp. alt text)
  // stay in sync.
  const state = useEditorState<MediaSelectionState>({
    editor,
    selector: ({ editor: ed }) => readMediaSelection(ed),
  })

  const showAltEditor = altDraft !== null && altDraft.src === state.src

  return (
    <BubbleMenu
      editor={editor}
      updateDelay={0}
      shouldShow={({ editor }) => {
        if (editor.isDestroyed || !editor.isEditable) return false
        const selection = editor.state.selection
        if (!(selection instanceof NodeSelection)) return false
        return selection.node.type.name === 'media'
      }}
      {...(iframeOverrides ?? {})}
    >
      <div className={styles.bar} data-testid="content-media-toolbar">
        {!showAltEditor ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              tooltip="Replace media"
              aria-label="Replace media"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPickMedia()}
              className={styles.button}
            >
              <ImagesSolidIcon size={14} aria-hidden="true" />
            </Button>
            {state.mediaType === 'image' && (
              <Button
                variant="ghost"
                size="xs"
                tooltip="Edit alt text"
                aria-label="Edit alt text"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setAltDraft({ src: state.src, value: state.alt })}
                className={styles.altButton}
              >
                Alt
              </Button>
            )}
            <span className={styles.divider} aria-hidden="true" />
            <Button
              variant="ghost"
              size="xs"
              tooltip="Delete media"
              aria-label="Delete media"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                editor.chain().focus().deleteSelection().run()
              }}
              tone="danger"
              dangerHover
              className={styles.button}
            >
              <TrashSolidIcon size={14} aria-hidden="true" />
            </Button>
          </>
        ) : (
          <AltEditor
            initial={altDraft?.value ?? ''}
            onCancel={() => setAltDraft(null)}
            onSubmit={(next) => {
              editor.chain().focus().updateAttributes('media', { alt: next }).run()
              setAltDraft(null)
            }}
          />
        )}
      </div>
    </BubbleMenu>
  )
}

interface AltEditorProps {
  initial: string
  onCancel: () => void
  onSubmit: (value: string) => void
}

function AltEditor({ initial, onCancel, onSubmit }: AltEditorProps) {
  const [value, setValue] = useState(initial)
  return (
    <form
      className={styles.altForm}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        onSubmit(value)
      }}
    >
      <Input
        autoFocus
        value={value}
        placeholder="Describe the image…"
        aria-label="Alt text"
        fieldSize="sm"
        emphasis="strong"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
          }
        }}
      />
      <Button type="submit" variant="primary" size="xs">
        Save
      </Button>
    </form>
  )
}

function readMediaSelection(editor: Editor | null): MediaSelectionState {
  if (!editor) {
    return { isMediaSelected: false, mediaType: 'image', alt: '', src: '' }
  }
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'media') {
    return { isMediaSelected: false, mediaType: 'image', alt: '', src: '' }
  }
  const attrs = sel.node.attrs as { mediaType?: string; alt?: string; src?: string }
  return {
    isMediaSelected: true,
    mediaType: attrs.mediaType === 'video' ? 'video' : 'image',
    alt: typeof attrs.alt === 'string' ? attrs.alt : '',
    src: typeof attrs.src === 'string' ? attrs.src : '',
  }
}
