/**
 * Floating bubble menu surfaced over text selections in the body editor.
 *
 * Wires Tiptap's `BubbleMenu` plugin to a small toolbar of inline-mark
 * toggles. Visible whenever the selection is a non-collapsed range over
 * text (so it doesn't pop over an empty caret or a media-node selection).
 *
 * Includes inline-mark toggles (Bold / Italic / Strike / Code / Link)
 * plus a "Turn into…" dropdown for block-level type changes on the
 * selected paragraph (Paragraph, H2, H3, H4, Bullet list, Numbered list,
 * Quote, Code block). This lets authors restructure prose with the
 * selection still active — no need to retreat to the slash menu.
 */

import { useState, type ComponentType, type FormEvent, type ReactNode } from 'react'
import type { ChainedCommands, Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import type { IconProps } from 'pixel-art-icons/types'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { BoldIcon } from 'pixel-art-icons/icons/bold'
import { ItalicIcon } from 'pixel-art-icons/icons/italic'
import { UnderlineIcon } from 'pixel-art-icons/icons/underline'
import { StrikeIcon } from 'pixel-art-icons/icons/strike'
import { CodeIcon } from 'pixel-art-icons/icons/code'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { TextAlignLeftIcon } from 'pixel-art-icons/icons/text-align-left'
import { TextAlignCenterIcon } from 'pixel-art-icons/icons/text-align-center'
import { TextAlignRightIcon } from 'pixel-art-icons/icons/text-align-right'
import { TextAlignJustifyIcon } from 'pixel-art-icons/icons/text-align-justify'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { HeadingIcon } from 'pixel-art-icons/icons/heading'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { TextStartTIcon } from 'pixel-art-icons/icons/text-start-t'
import { TextPlusIcon } from 'pixel-art-icons/icons/text-plus'
import { MinusIcon } from 'pixel-art-icons/icons/minus'
import styles from './BodyBubbleMenu.module.css'

interface BodyBubbleMenuProps {
  editor: Editor
  /**
   * When set, the editor lives inside this iframe and the bubble menu
   * needs to be rendered in the host document but positioned over the
   * iframe's contents. We thread the iframe element through so we can
   * build an iframe-aware virtual reference for floating-ui — the
   * selection's coords are iframe-viewport coords and need to be
   * translated by `iframeEl.getBoundingClientRect()` to land in the
   * right place on screen. Leave undefined for the default in-host
   * Write-mode usage.
   */
  iframeEl?: HTMLIFrameElement | null
}

type BlockKind =
  | 'paragraph'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'bullet-list'
  | 'ordered-list'
  | 'blockquote'
  | 'code-block'

const BLOCK_OPTIONS: Array<{ kind: BlockKind; label: string }> = [
  { kind: 'paragraph', label: 'Paragraph' },
  { kind: 'heading-2', label: 'Heading 2' },
  { kind: 'heading-3', label: 'Heading 3' },
  { kind: 'heading-4', label: 'Heading 4' },
  { kind: 'bullet-list', label: 'Bullet list' },
  { kind: 'ordered-list', label: 'Numbered list' },
  { kind: 'blockquote', label: 'Quote' },
  { kind: 'code-block', label: 'Code block' },
]

export function BodyBubbleMenu({ editor, iframeEl }: BodyBubbleMenuProps) {
  const [linkDraft, setLinkDraft] = useState<string | null>(null)
  const [typeMenuRect, setTypeMenuRect] = useState<DOMRect | null>(null)
  const [insertMenuRect, setInsertMenuRect] = useState<DOMRect | null>(null)

  // When the editor lives inside an iframe (Live mode), the BubbleMenu
  // plugin needs a custom virtual reference whose `getBoundingClientRect`
  // returns host-viewport coords. The plugin's default reference uses
  // the editor view's selection coords directly — those are iframe-
  // viewport coords, so without translation the menu would appear
  // shifted by the iframe's offset.
  const iframeOverrides = !iframeEl
    ? undefined
    : {
        appendTo: () => document.body,
        options: {
          strategy: 'fixed' as const,
          // Clip the menu to the iframe's visible region so it can't
          // drift over the left content sidebar (or beyond any other
          // host chrome). floating-ui's `shift` middleware uses this
          // boundary to compute overflow corrections.
          shift: { boundary: iframeEl, padding: 8 },
          flip: { boundary: iframeEl, padding: 8 },
        },
        // Return type is checked structurally against floating-ui's
        // `VirtualElement` where this object is spread onto <BubbleMenu>.
        getReferencedVirtualElement: () => {
          if (editor.isDestroyed) return null
          const { from, to } = editor.state.selection
          // `coordsAtPos` returns viewport-relative coords for whichever
          // document the view lives in (here: the iframe doc). Build the
          // selection rect from the endpoints and translate to host
          // viewport by adding the iframe's bounding rect.
          const head = editor.view.coordsAtPos(from)
          const tail = editor.view.coordsAtPos(to)
          const iframeRect = iframeEl.getBoundingClientRect()
          const left = Math.min(head.left, tail.left) + iframeRect.left
          const right = Math.max(head.right, tail.right) + iframeRect.left
          const top = Math.min(head.top, tail.top) + iframeRect.top
          const bottom = Math.max(head.bottom, tail.bottom) + iframeRect.top
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

  // Subscribe to the editor's transactions so the toolbar's active /
  // pressed states reflect the current selection. Without this, the
  // bubble menu's React subtree only renders once when the menu first
  // appears — so `editor.isActive('bold')` is frozen to whatever it
  // was at first paint. Re-selecting a bold word would never light
  // up the B button.
  //
  // We deliberately *narrow* what useEditorState returns: only the
  // mark / block flags we render. The selector's shallow-equality
  // check then skips re-renders for transactions that don't touch
  // any of these (e.g., caret moves within the same plain paragraph).
  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      if (!ed) {
        return {
          isBold: false,
          isItalic: false,
          isUnderline: false,
          isStrike: false,
          isCode: false,
          isLink: false,
          linkHref: '',
          activeBlockLabel: 'Paragraph',
          activeBlockKind: 'paragraph' as BlockKind,
          textAlign: 'left' as TextAlignKind,
        }
      }
      const linkAttrs = ed.getAttributes('link') as { href?: string }
      return {
        isBold: ed.isActive('bold'),
        isItalic: ed.isActive('italic'),
        isUnderline: ed.isActive('underline'),
        isStrike: ed.isActive('strike'),
        isCode: ed.isActive('code'),
        isLink: ed.isActive('link'),
        linkHref: typeof linkAttrs.href === 'string' ? linkAttrs.href : '',
        activeBlockLabel: readActiveBlockLabel(ed),
        activeBlockKind: readActiveBlockKind(ed),
        textAlign: readActiveTextAlign(ed),
      }
    },
  })

  function applyBlockKind(kind: BlockKind): void {
    const chain = editor.chain().focus()
    switch (kind) {
      case 'paragraph':
        chain.setParagraph().run()
        return
      case 'heading-2':
        chain.setNode('heading', { level: 2 }).run()
        return
      case 'heading-3':
        chain.setNode('heading', { level: 3 }).run()
        return
      case 'heading-4':
        chain.setNode('heading', { level: 4 }).run()
        return
      case 'bullet-list':
        chain.toggleBulletList().run()
        return
      case 'ordered-list':
        chain.toggleOrderedList().run()
        return
      case 'blockquote':
        chain.toggleBlockquote().run()
        return
      case 'code-block':
        chain.toggleCodeBlock().run()
        return
    }
  }

  const currentBlockLabel = state.activeBlockLabel

  return (
    <BubbleMenu
      editor={editor}
      // No debounce — the menu opens the instant the user releases the
      // drag. The 250 ms default that Tiptap ships felt sluggish for a
      // formatting toolbar (a Linear / Notion-grade editor opens it
      // immediately).
      updateDelay={0}
      shouldShow={({ editor, from, to }) => {
        if (editor.isDestroyed || !editor.isEditable) return false
        if (from === to) return false
        // Hide over atomic *non-text* nodes (media, hr, etc.). Text nodes
        // report `isAtom: true` in ProseMirror's bundled model, so we
        // must exclude `isText` explicitly — otherwise every text
        // selection looks like an atom and the menu never shows.
        const { state } = editor
        const slice = state.doc.slice(from, to)
        return !sliceContainsNonTextAtom(slice.content)
      }}
      {...(iframeOverrides ?? {})}
    >
      <div className={styles.bar} data-testid="content-bubble-menu">
        {linkDraft === null ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              tooltip="Turn into…"
              className={styles.blockTypeButton}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                setTypeMenuRect(event.currentTarget.getBoundingClientRect())
              }}
            >
              <span>{currentBlockLabel}</span>
              <ChevronDownIcon size={11} aria-hidden="true" />
            </Button>
            <span className={styles.divider} aria-hidden="true" />
            <MarkButton
              label="Bold (Cmd-B)"
              icon={BoldIcon}
              active={state.isBold}
              onClick={() => editor.chain().focus().toggleBold().run()}
            />
            <MarkButton
              label="Italic (Cmd-I)"
              icon={ItalicIcon}
              active={state.isItalic}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            />
            <MarkButton
              label="Underline (Cmd-U)"
              icon={UnderlineIcon}
              active={state.isUnderline}
              onClick={() => editor.chain().focus().toggleUnderline().run()}
            />
            <MarkButton
              label="Strikethrough"
              icon={StrikeIcon}
              active={state.isStrike}
              onClick={() => editor.chain().focus().toggleStrike().run()}
            />
            <MarkButton
              label="Inline code"
              icon={CodeIcon}
              active={state.isCode}
              onClick={() => editor.chain().focus().toggleCode().run()}
            />
            <span className={styles.divider} aria-hidden="true" />
            <MarkButton
              label="Link (Cmd-K)"
              icon={LinkIcon}
              active={state.isLink}
              onClick={() => {
                setLinkDraft(state.linkHref)
              }}
            />
            <span className={styles.divider} aria-hidden="true" />
            <MarkButton
              label="Align left"
              icon={TextAlignLeftIcon}
              active={state.textAlign === 'left'}
              onClick={() => editor.chain().focus().setTextAlign('left').run()}
            />
            <MarkButton
              label="Align center"
              icon={TextAlignCenterIcon}
              active={state.textAlign === 'center'}
              onClick={() => editor.chain().focus().setTextAlign('center').run()}
            />
            <MarkButton
              label="Align right"
              icon={TextAlignRightIcon}
              active={state.textAlign === 'right'}
              onClick={() => editor.chain().focus().setTextAlign('right').run()}
            />
            <MarkButton
              label="Justify"
              icon={TextAlignJustifyIcon}
              active={state.textAlign === 'justify'}
              onClick={() => editor.chain().focus().setTextAlign('justify').run()}
            />
            <span className={styles.divider} aria-hidden="true" />
            <Button
              variant="ghost"
              size="xs"
              iconOnly
              tooltip="Insert block below"
              aria-label="Insert block below"
              className={styles.markButton}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                setInsertMenuRect(event.currentTarget.getBoundingClientRect())
              }}
            >
              <PlusIcon size={14} aria-hidden="true" />
            </Button>
          </>
        ) : (
          <LinkEditor
            initial={linkDraft}
            onCancel={() => setLinkDraft(null)}
            onClear={() => {
              editor.chain().focus().unsetLink().run()
              setLinkDraft(null)
            }}
            onSubmit={(href) => {
              const trimmed = href.trim()
              if (!trimmed) {
                editor.chain().focus().unsetLink().run()
              } else {
                editor.chain().focus().extendMarkRange('link').setLink({ href: trimmed }).run()
              }
              setLinkDraft(null)
            }}
          />
        )}
      </div>
      {typeMenuRect && typeof document !== 'undefined' && (
        <ContextMenu
          x={typeMenuRect.left}
          y={typeMenuRect.bottom + 4}
          width={160}
          minWidth={160}
          zIndex={10001}
          ariaLabel="Turn into"
          onClose={() => setTypeMenuRect(null)}
        >
          {BLOCK_OPTIONS.map((option) => (
            <ContextMenuItem
              key={option.kind}
              active={option.kind === state.activeBlockKind}
              onClick={() => {
                applyBlockKind(option.kind)
                setTypeMenuRect(null)
              }}
            >
              <span>{option.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
      {insertMenuRect && typeof document !== 'undefined' && (
        <ContextMenu
          x={insertMenuRect.left}
          y={insertMenuRect.bottom + 6}
          width={220}
          minWidth={220}
          zIndex={10001}
          ariaLabel="Insert block below"
          onClose={() => setInsertMenuRect(null)}
        >
          {INSERT_BELOW_OPTIONS.map((option) => (
            <ContextMenuItem
              key={option.label}
              onClick={() => {
                insertBlockBelow(editor, option.apply)
                setInsertMenuRect(null)
              }}
            >
              {option.icon}
              <span>{option.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenu>
      )}
    </BubbleMenu>
  )
}

// ---------------------------------------------------------------------------
// Insert-below catalog
// ---------------------------------------------------------------------------

interface InsertBelowOption {
  label: string
  icon: ReactNode
  apply: (chain: ChainedCommands) => boolean
}

// Mirrors the gutter "+" catalog but each option INSERTS a new block
// (vs. converts the current one). The host (`insertBlockBelow` below)
// positions the caret after the current block before handing the chain
// to `apply`, so the new block always lands after the selection.
const INSERT_BELOW_OPTIONS: InsertBelowOption[] = [
  {
    label: 'Paragraph',
    icon: <TextStartTIcon size={14} aria-hidden="true" />,
    apply: (chain) => chain.insertContent({ type: 'paragraph' }).run(),
  },
  {
    label: 'Heading 2',
    icon: <HeadingIcon size={14} aria-hidden="true" />,
    apply: (chain) => chain.insertContent({ type: 'heading', attrs: { level: 2 } }).run(),
  },
  {
    label: 'Heading 3',
    icon: <HeadingIcon size={14} aria-hidden="true" />,
    apply: (chain) => chain.insertContent({ type: 'heading', attrs: { level: 3 } }).run(),
  },
  {
    label: 'Heading 4',
    icon: <HeadingIcon size={14} aria-hidden="true" />,
    apply: (chain) => chain.insertContent({ type: 'heading', attrs: { level: 4 } }).run(),
  },
  {
    label: 'Bullet list',
    icon: <BulletlistSolidIcon size={14} aria-hidden="true" />,
    apply: (chain) =>
      chain
        .insertContent({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] })
        .run(),
  },
  {
    label: 'Quote',
    icon: <TextPlusIcon size={14} aria-hidden="true" />,
    apply: (chain) =>
      chain.insertContent({ type: 'blockquote', content: [{ type: 'paragraph' }] }).run(),
  },
  {
    label: 'Divider',
    icon: <MinusIcon size={14} aria-hidden="true" />,
    apply: (chain) => chain.setHorizontalRule().run(),
  },
]

/**
 * Move the selection to the END of the current top-level block, then
 * hand a focused chain to the caller. Insertion commands invoked on the
 * chain land in a fresh block right after the selection.
 */
function insertBlockBelow(editor: Editor, apply: (chain: ChainedCommands) => boolean): void {
  const { $from } = editor.state.selection
  // Walk up to find the closest top-level block. depth=0 is the doc, so
  // we want the LAST depth before that — typically 1 for paragraphs /
  // headings, deeper for list items / table cells (where we still land
  // the new block AFTER the wrapping block).
  let depth = $from.depth
  while (depth > 1) depth--
  const afterBlock = $from.after(depth)
  const chain = editor.chain().focus(afterBlock)
  apply(chain)
}

interface MarkButtonProps {
  label: string
  icon: ComponentType<IconProps>
  active: boolean
  onClick: () => void
}

function MarkButton({ label, icon: Icon, active, onClick }: MarkButtonProps) {
  return (
    <Button
      variant={active ? 'primary' : 'ghost'}
      size="xs"
      iconOnly
      tooltip={label}
      aria-label={label}
      aria-pressed={active}
      className={styles.markButton}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon size={14} aria-hidden="true" />
    </Button>
  )
}

interface LinkEditorProps {
  initial: string
  onCancel: () => void
  onClear: () => void
  onSubmit: (href: string) => void
}

function LinkEditor({ initial, onCancel, onClear, onSubmit }: LinkEditorProps) {
  const [value, setValue] = useState(initial)
  return (
    <form
      className={styles.linkForm}
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        onSubmit(value)
      }}
    >
      <Input
        autoFocus
        value={value}
        placeholder="https://"
        aria-label="Link URL"
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
        Apply
      </Button>
      {initial.length > 0 && (
        <Button type="button" variant="ghost" size="xs" onClick={onClear}>
          Remove
        </Button>
      )}
    </form>
  )
}

function sliceContainsNonTextAtom(content: {
  forEach: (cb: (child: { isAtom: boolean; isText: boolean; content?: unknown }) => void) => void
}): boolean {
  let found = false
  content.forEach((child) => {
    if (child.isAtom && !child.isText) found = true
  })
  return found
}

function readActiveBlockLabel(editor: Editor): string {
  return readActiveBlockKindLabel(readActiveBlockKind(editor))
}

function readActiveBlockKindLabel(kind: BlockKind): string {
  switch (kind) {
    case 'paragraph': return 'Paragraph'
    case 'heading-2': return 'Heading 2'
    case 'heading-3': return 'Heading 3'
    case 'heading-4': return 'Heading 4'
    case 'bullet-list': return 'Bullet list'
    case 'ordered-list': return 'Numbered list'
    case 'blockquote': return 'Quote'
    case 'code-block': return 'Code block'
  }
}

function readActiveBlockKind(editor: Editor): BlockKind {
  if (editor.isActive('heading', { level: 2 })) return 'heading-2'
  if (editor.isActive('heading', { level: 3 })) return 'heading-3'
  if (editor.isActive('heading', { level: 4 })) return 'heading-4'
  if (editor.isActive('bulletList')) return 'bullet-list'
  if (editor.isActive('orderedList')) return 'ordered-list'
  if (editor.isActive('blockquote')) return 'blockquote'
  if (editor.isActive('codeBlock')) return 'code-block'
  return 'paragraph'
}

type TextAlignKind = 'left' | 'center' | 'right' | 'justify'

// "left" is the implicit default — the TextAlign extension is configured
// with `defaultAlignment: null`, so a paragraph / heading that's never
// been aligned has no `textAlign` attribute at all. We display the Left
// button as the active state for those "default" cases so the toolbar
// always shows a single highlighted alignment.
function readActiveTextAlign(editor: Editor): TextAlignKind {
  if (editor.isActive({ textAlign: 'center' })) return 'center'
  if (editor.isActive({ textAlign: 'right' })) return 'right'
  if (editor.isActive({ textAlign: 'justify' })) return 'justify'
  return 'left'
}
