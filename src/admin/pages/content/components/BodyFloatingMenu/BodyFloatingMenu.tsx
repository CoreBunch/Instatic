/**
 * Inline "+" affordance shown in the editor's left gutter next to an empty
 * top-level paragraph.
 *
 * Earlier iterations of this component wrapped Tiptap's `FloatingMenu`
 * which anchors to the caret via floating-ui. That worked horizontally
 * when the caret was in the middle of a line, but on an empty paragraph
 * the caret sits at the line's left edge — exactly where the placeholder
 * text "Type '/' for commands…" starts — so the "+" ended up *overlapping*
 * the placeholder no matter what offset / placement we picked.
 *
 * The fix is to drop the caret-as-reference model and anchor the button
 * to the editor's content column instead: a fixed `left` offset in the
 * gutter, with only the `top` recomputed from the current paragraph's
 * coords. We subscribe to Tiptap's `selectionUpdate` + `focus` + `blur`
 * events for the y-coordinate refresh.
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@ui/components/ContextMenu'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { TextPlusIcon } from 'pixel-art-icons/icons/text-plus'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import { MoreVerticalSolidIcon } from 'pixel-art-icons/icons/more-vertical-solid'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { CopySolidIcon } from 'pixel-art-icons/icons/copy-solid'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { InsertLinkDialog } from './InsertLinkDialog'
import styles from './BodyFloatingMenu.module.css'
import type { ReactNode } from 'react'

interface BodyFloatingMenuProps {
  editor: Editor
  /**
   * Called when the user picks the "Media" item — the host opens its
   * picker modal and, on confirm, inserts a media node at the editor's
   * current selection via the imperative ref it already owns.
   */
  onPickMedia: () => void
  /**
   * When set, the editor lives inside this iframe and the gutter "+"
   * button needs to render in the host document with viewport-fixed
   * positioning offset by the iframe's bounding rect. Leaving this
   * undefined keeps the default in-host (Write mode) behaviour.
   */
  iframeEl?: HTMLIFrameElement | null
}

interface QuickInsertContext {
  onInsertLink: () => void
  editor: Editor
  /**
   * A pre-focused, pre-positioned chain — focus has been restored to the
   * snapshot caret position before this is handed to `apply`. Most items
   * just add one node-level command and `.run()`.
   */
  chain: ChainedCommands
  onPickMedia: () => void
}

interface QuickInsertOption {
  label: string
  description: string
  icon: ReactNode
  /**
   * Section the option belongs to. The menu groups items by section with
   * a divider between groups. Order of sections matches catalog order.
   */
  section: 'turn-into' | 'insert' | 'block'
  apply: (ctx: QuickInsertContext) => boolean
}

// Catalog groups items by section so the host can render dividers
// between groups. Order matches the visual order in the menu.
const QUICK_INSERT: QuickInsertOption[] = [
  // ── Turn into ────────────────────────────────────────────────────────
  // Convert the current block into a different type. setNode-based;
  // works whether the current block is empty or has content.
  {
    section: 'turn-into',
    label: 'Paragraph',
    description: 'Plain text',
    icon: <TextStartTIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.setParagraph().run(),
  },
  {
    section: 'turn-into',
    label: 'Heading 2',
    description: 'Section title',
    icon: <HeadingIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.setNode('heading', { level: 2 }).run(),
  },
  {
    section: 'turn-into',
    label: 'Heading 3',
    description: 'Sub-section',
    icon: <HeadingIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.setNode('heading', { level: 3 }).run(),
  },
  {
    section: 'turn-into',
    label: 'Heading 4',
    description: 'Small heading',
    icon: <HeadingIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.setNode('heading', { level: 4 }).run(),
  },
  {
    section: 'turn-into',
    label: 'Bullet list',
    description: 'Unordered list',
    icon: <BulletlistSolidIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.toggleBulletList().run(),
  },
  {
    section: 'turn-into',
    label: 'Numbered list',
    description: 'Ordered list',
    icon: <BulletlistSolidIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.toggleOrderedList().run(),
  },
  {
    section: 'turn-into',
    label: 'Quote',
    description: 'Block quote',
    icon: <TextPlusIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.toggleBlockquote().run(),
  },
  {
    section: 'turn-into',
    label: 'Code block',
    description: 'Fenced code',
    icon: <CodeIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.toggleCodeBlock().run(),
  },

  // ── Insert ───────────────────────────────────────────────────────────
  {
    section: 'insert',
    label: 'Link',
    description: 'Insert a text link',
    icon: <LinkIcon size={14} aria-hidden="true" />,
    apply: ({ onInsertLink }) => {
      onInsertLink()
      return true
    },
  },
  {
    section: 'insert',
    label: 'Image / Video',
    description: 'From media library',
    icon: <ImagesSolidIcon size={14} aria-hidden="true" />,
    apply: ({ onPickMedia }) => {
      // The host opens the existing media-picker modal and handles
      // insertion via the editor's imperative ref once the user picks
      // an asset. We don't need to position the caret here — the
      // chain's `.focus(snapshotPos)` already restored selection to
      // the block, and `insertMedia` splits at the caret as expected.
      onPickMedia()
      return true
    },
  },
  {
    section: 'insert',
    label: 'Divider',
    description: 'Horizontal rule',
    icon: <MinusIcon size={14} aria-hidden="true" />,
    apply: ({ chain }) => chain.setHorizontalRule().run(),
  },

  // ── Block actions ────────────────────────────────────────────────────
  // Operate on the current top-level block as a unit. Use the editor
  // (not the chain) because we need to read the block's bounds from
  // the doc tree before issuing the transaction.
  {
    section: 'block',
    label: 'Duplicate',
    description: 'Clone this block below',
    icon: <CopySolidIcon size={14} aria-hidden="true" />,
    apply: ({ editor }) => duplicateCurrentBlock(editor),
  },
  {
    section: 'block',
    label: 'Delete',
    description: 'Remove this block',
    icon: <TrashSolidIcon size={14} aria-hidden="true" />,
    apply: ({ editor }) => deleteCurrentBlock(editor),
  },
]

/**
 * Find the top-level block that contains the current selection and
 * insert a clone of it immediately after. `$from.before(1)` is the
 * position of the block's opening tag — `before(0)` is `-1` (before
 * the doc itself) so we clamp the depth to 1.
 */
function duplicateCurrentBlock(editor: Editor): boolean {
  const { $from } = editor.state.selection
  const depth = Math.max(1, $from.depth >= 1 ? 1 : $from.depth)
  if (depth < 1) return false
  const blockNode = $from.node(depth)
  const blockPos = $from.before(depth)
  const blockEnd = blockPos + blockNode.nodeSize
  editor.chain().focus().insertContentAt(blockEnd, blockNode.toJSON()).run()
  return true
}

function deleteCurrentBlock(editor: Editor): boolean {
  const { $from } = editor.state.selection
  const depth = Math.max(1, $from.depth >= 1 ? 1 : $from.depth)
  if (depth < 1) return false
  const blockNode = $from.node(depth)
  const blockPos = $from.before(depth)
  const blockEnd = blockPos + blockNode.nodeSize
  editor.chain().focus().deleteRange({ from: blockPos, to: blockEnd }).run()
  return true
}

interface ButtonPosition {
  /** Pixel y-offset (wrapper-relative in Write mode, viewport-relative in Live mode). */
  top: number
  /**
   * Pixel x-offset in viewport coords. Only set in iframe (Live) mode —
   * in Write mode the gutter button uses a fixed `left: -36px` from CSS
   * and only the `top` is JS-driven.
   */
  left?: number
}

export function BodyFloatingMenu({ editor, onPickMedia, iframeEl }: BodyFloatingMenuProps) {
  const [linkPosition, setLinkPosition] = useState<number | null>(null)
  // The button's vertical position. `null` means "don't render" — the
  // selection isn't on an empty top-level paragraph, or the editor is
  // blurred and we don't want a sticky affordance.
  const [position, setPosition] = useState<ButtonPosition | null>(null)
  // The quick-insert menu's anchor rect; opens on "+" click.
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null)
  // Editor doc position at the moment the menu opened. Snapshot then
  // restored on apply so the option lands on the paragraph the gutter
  // button was pointing at — independent of where the editor's focus
  // travels while the menu is open.
  const selectionSnapshotRef = useRef<number | null>(null)

  useEffect(() => {
    if (!editor) return

    const refresh = () => {
      if (editor.isDestroyed || !editor.isEditable) {
        setPosition(null)
        return
      }
      const next = computeGutterPosition(editor, iframeEl ?? null)
      setPosition(next)
    }

    editor.on('selectionUpdate', refresh)
    editor.on('focus', refresh)
    editor.on('blur', refresh)
    editor.on('update', refresh)
    // Initial mount may run before the editor has measured layout —
    // schedule a microtask refresh so the first render lands correctly.
    queueMicrotask(refresh)

    // In iframe (Live) mode the gutter button uses viewport-fixed
    // positioning, so any scroll inside the iframe or in the host page
    // moves the visual anchor under the cursor. Subscribe to scroll +
    // resize on both ends so the button tracks.
    const iframeWindow = iframeEl?.contentWindow ?? null
    const hostHandler = () => refresh()
    if (iframeEl) {
      iframeWindow?.addEventListener('scroll', hostHandler, { passive: true })
      window.addEventListener('scroll', hostHandler, { passive: true })
      window.addEventListener('resize', hostHandler)
    }

    return () => {
      editor.off('selectionUpdate', refresh)
      editor.off('focus', refresh)
      editor.off('blur', refresh)
      editor.off('update', refresh)
      if (iframeEl) {
        iframeWindow?.removeEventListener('scroll', hostHandler)
        window.removeEventListener('scroll', hostHandler)
        window.removeEventListener('resize', hostHandler)
      }
    }
  }, [editor, iframeEl])

  // The button hides when the selection is no longer on an empty
  // paragraph (or the editor is blurred). The MENU, however, stays
  // mounted as long as `menuRect` is set — otherwise the act of
  // opening it (ContextMenu autofocuses its first item, blurring the
  // editor) would immediately unmount it and the user could never
  // click an option.
  if (!position && !menuRect && linkPosition === null) return null

  return (
    <>
      {position && (
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          tooltip="Block options"
          aria-label="Block options"
          data-testid="content-floating-menu"
          className={styles.gutterButton}
          // In Write mode the button uses the CSS-defined absolute
          // positioning (left: -36px relative to the editor wrapper)
          // and we only override `top`. In Live mode the button is
          // rendered in the host but anchored to coordinates inside
          // the iframe — switch to viewport-fixed positioning and
          // supply both axes.
          style={
            position.left !== undefined
              ? { position: 'fixed', top: position.top, left: position.left }
              : { top: position.top }
          }
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            // Snapshot the editor's current selection BEFORE the menu opens.
            // Opening ContextMenu auto-focuses its first item, which blurs
            // the editor and could leave its `state.selection` pointing at
            // the wrong place by the time the user picks an option.
            // Restoring the snapshot inside `apply` keeps the click target
            // honest: "Heading" turns the paragraph the user was on into
            // a heading, even if focus has moved.
            selectionSnapshotRef.current = editor.state.selection.from
            setMenuRect(event.currentTarget.getBoundingClientRect())
          }}
        >
          <MoreVerticalSolidIcon size={12} aria-hidden="true" />
        </Button>
      )}

      {menuRect && typeof document !== 'undefined' && (
        <ContextMenu
          x={menuRect.right + 6}
          y={menuRect.top}
          width={220}
          minWidth={220}
          zIndex={10001}
          ariaLabel="Block options"
          onClose={() => setMenuRect(null)}
        >
          {QUICK_INSERT.map((option, index) => {
            // Insert a divider whenever we cross a section boundary.
            // The first item never gets a leading divider.
            const prev = index > 0 ? QUICK_INSERT[index - 1] : null
            const showDivider = prev !== null && prev.section !== option.section
            return (
              <Fragment key={option.label}>
                {showDivider && <ContextMenuSeparator />}
                <ContextMenuItem
                  onClick={() => {
                    // Build a single transaction: focus at the snapshot
                    // position (or wherever the editor's current selection
                    // happens to be) THEN apply the node-level command in
                    // the same chain. Wrapping it all in one chain means
                    // there's no inter-command window where Tiptap could
                    // refocus / reset selection.
                    const restoredPos = selectionSnapshotRef.current
                    const chain = restoredPos !== null
                      ? editor.chain().focus(restoredPos)
                      : editor.chain().focus()
                    option.apply({
                      editor, chain, onPickMedia,
                      onInsertLink: () => setLinkPosition(restoredPos ?? editor.state.selection.from),
                    })
                    setMenuRect(null)
                    selectionSnapshotRef.current = null
                  }}
                >
                  {option.icon}
                  <span>{option.label}</span>
                </ContextMenuItem>
              </Fragment>
            )
          })}
        </ContextMenu>
      )}
      {linkPosition !== null && (
        <InsertLinkDialog editor={editor} position={linkPosition} onClose={() => setLinkPosition(null)} />
      )}
    </>
  )
}

/**
 * Decide whether to show the gutter "+" and, if so, where vertically.
 *
 * Rules:
 *   - Editor must be focused (we don't want a phantom button after blur).
 *   - Selection must be collapsed (the bubble menu owns ranges; showing
 *     both at once is noisy).
 *   - The enclosing block must be a TOP-LEVEL textual block: paragraph,
 *     heading, blockquote, or codeBlock. We deliberately skip list items
 *     and table cells — their gutter alignment is tricky and the bubble
 *     menu's "Turn into" already covers conversions inside them.
 *   - Atomic / media nodes are skipped (you can't "Turn into" them).
 *
 * The y-offset aligns to the **first line of the block**, not the caret
 * line. That keeps the "+" anchored to its block while the user types,
 * even when the caret moves down through a multi-line paragraph or a
 * heading that wraps.
 *
 * Returns the y-offset (relative to the editor surface's wrapper) the
 * "+" button should align to, or `null` to suppress rendering.
 */
const ALLOWED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'codeBlock',
])

function computeGutterPosition(
  editor: Editor,
  iframeEl: HTMLIFrameElement | null,
): ButtonPosition | null {
  if (!editor.isFocused) return null
  const state = editor.state
  const selection = state.selection
  if (!selection.empty) return null

  const $from = selection.$from
  // Walk up to the first allowed block ancestor. For nested structures
  // (e.g., a paragraph inside a blockquote) we still align to the
  // blockquote — that's the block users want to convert.
  let depth = $from.depth
  let blockNode = null
  let blockPos = -1
  while (depth >= 0) {
    const candidate = $from.node(depth)
    if (ALLOWED_BLOCK_TYPES.has(candidate.type.name)) {
      blockNode = candidate
      blockPos = depth === 0 ? 0 : $from.before(depth)
      break
    }
    depth--
  }
  if (!blockNode || blockPos < 0) return null

  // The grandparent must be `doc` — we only show on top-level blocks.
  // (A paragraph inside a list item or table cell falls through here
  // because its grandparent is `listItem` or `tableCell`.)
  if (depth > 1) return null

  const view = editor.view
  const wrapper = view.dom.parentElement
  if (!wrapper) return null

  // Use the FIRST inline position inside the block for the coords —
  // that's the block's top-left text edge. `blockPos + 1` is just after
  // the block's opening tag, i.e. the first valid position inside it.
  const firstInlinePos = Math.min(blockPos + 1, state.doc.content.size)
  const firstCoords = view.coordsAtPos(firstInlinePos)
  const buttonHeight = 24
  const buttonWidth = 24
  const gutterOffset = 12 // space between block's left edge and the button

  if (iframeEl) {
    // Live mode: render with viewport-fixed positioning. `firstCoords`
    // are iframe-viewport coords; translate to host viewport by adding
    // the iframe's bounding rect. Use the block's left edge as the
    // anchor (`coordsAtPos` returns the caret line, which for an empty
    // block is the same column as the text would start at).
    const iframeRect = iframeEl.getBoundingClientRect()
    const lineMid = (firstCoords.top + firstCoords.bottom) / 2
    const top = Math.round(lineMid + iframeRect.top - buttonHeight / 2)
    // Clamp `left` so the gutter button can never drift past the
    // iframe's own left edge — otherwise a block flush against the
    // iframe's left margin would push the "+" under the host's
    // content sidebar. We keep an 8px breathing room from the iframe
    // edge, matching the bubble-menu boundary padding.
    const desiredLeft = firstCoords.left + iframeRect.left - buttonWidth - gutterOffset
    const minLeft = iframeRect.left + 8
    const left = Math.round(Math.max(desiredLeft, minLeft))
    return { top, left }
  }

  // Write mode: position relative to the editor wrapper. The CSS owns
  // the horizontal offset (`left: -36px`) so only `top` is JS-driven.
  const wrapperRect = wrapper.getBoundingClientRect()
  const lineMid = (firstCoords.top + firstCoords.bottom) / 2
  const top = Math.round(lineMid - wrapperRect.top - buttonHeight / 2)
  return { top }
}
