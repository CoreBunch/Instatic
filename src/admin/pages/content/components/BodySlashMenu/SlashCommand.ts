/**
 * Slash-command Tiptap extension.
 *
 * Wires the standard `@tiptap/suggestion` substrate to the `/` trigger
 * character. The actual menu rendering — the floating list, keyboard
 * selection, click handlers — lives in `BodySlashMenu.tsx`; this file
 * is just the plumbing between Tiptap's plugin layer and that React
 * component (which is mounted as a portal once per editor instance).
 *
 * Items are static — there is no async fetch — so `items` filters the
 * built-in catalogue by `query`. Selection invokes the item's `command`,
 * which is in turn responsible for performing the editor mutation
 * (e.g. `setNode('heading', { level })`, `toggleBulletList()`, etc.).
 *
 * External actions (media picker, data-token picker) are routed back to
 * the host component via the extension options' `onExternal` callback.
 * The slash menu invokes the callback synchronously after deleting the
 * trigger range so the host opens its dialog with a clean caret.
 */

import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'

export type SlashExternalAction = 'media' | 'dataToken'

export interface SlashCommandItem {
  id: string
  label: string
  description: string
  keywords: readonly string[]
  command: (props: { editor: Editor; range: Range }) => void
}

interface SlashCommandOptions {
  /**
   * Called when the user picks an item whose effect cannot be performed
   * from inside the editor (currently: opening the media picker or the
   * data-token binding dialog). The host component opens the dialog and,
   * on confirm, calls back into the editor with the selected payload.
   */
  onExternal: (action: SlashExternalAction) => void
  /**
   * Renderer plumbing — exposed via the extension's `addOptions` so the
   * React layer can mount its menu. The host attaches the four lifecycle
   * methods that `@tiptap/suggestion` expects (onStart / onUpdate /
   * onKeyDown / onExit).
   */
  suggestion: Omit<SuggestionOptions<SlashCommandItem>, 'editor' | 'items'>
}

const SLASH_COMMAND_NAME = 'slashCommand'

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: SLASH_COMMAND_NAME,

  addOptions() {
    return {
      onExternal: () => undefined,
      suggestion: {
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        command: ({ editor, range, props }) => {
          props.command({ editor, range })
        },
      },
    }
  },

  addProseMirrorPlugins() {
    const onExternal = this.options.onExternal
    return [
      Suggestion<SlashCommandItem>({
        editor: this.editor,
        ...this.options.suggestion,
        items: ({ query, editor }) => filterSlashItems(buildSlashItems(onExternal), query, editor),
      }),
    ]
  },
})

// ---------------------------------------------------------------------------
// Item catalogue
// ---------------------------------------------------------------------------

function buildSlashItems(onExternal: (action: SlashExternalAction) => void): SlashCommandItem[] {
  return [
    {
      id: 'heading-2',
      label: 'Heading 2',
      description: 'Section title',
      keywords: ['h2', 'heading', 'section', 'title'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
    },
    {
      id: 'heading-3',
      label: 'Heading 3',
      description: 'Sub-section',
      keywords: ['h3', 'heading', 'subsection'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
    },
    {
      id: 'heading-4',
      label: 'Heading 4',
      description: 'Small heading',
      keywords: ['h4', 'heading'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setNode('heading', { level: 4 }).run(),
    },
    {
      id: 'bullet-list',
      label: 'Bullet list',
      description: 'Unordered list',
      keywords: ['ul', 'list', 'bullet', 'unordered'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBulletList().run(),
    },
    {
      id: 'ordered-list',
      label: 'Numbered list',
      description: 'Ordered list',
      keywords: ['ol', 'list', 'number', 'ordered'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
    },
    {
      id: 'blockquote',
      label: 'Quote',
      description: 'Block quote',
      keywords: ['quote', 'blockquote'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
    },
    {
      id: 'code-block',
      label: 'Code block',
      description: 'Fenced code',
      keywords: ['code', 'pre', 'snippet'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
    },
    {
      id: 'horizontal-rule',
      label: 'Divider',
      description: 'Horizontal rule',
      keywords: ['hr', 'divider', 'separator', 'line'],
      command: ({ editor, range }) =>
        editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
    },
    {
      id: 'table',
      label: 'Table',
      description: '2-column, 3-row',
      keywords: ['table', 'grid'],
      command: ({ editor, range }) =>
        editor
          .chain()
          .focus()
          .deleteRange(range)
          .insertTable({ rows: 3, cols: 2, withHeaderRow: true })
          .run(),
    },
    {
      id: 'media',
      label: 'Media',
      description: 'Image or video from library',
      keywords: ['image', 'img', 'video', 'media', 'picture'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run()
        onExternal('media')
      },
    },
    {
      id: 'data-token',
      label: 'Data token',
      description: 'Insert {source.field}',
      keywords: ['data', 'token', 'binding', 'field', 'dynamic'],
      command: ({ editor, range }) => {
        editor.chain().focus().deleteRange(range).run()
        onExternal('dataToken')
      },
    },
  ]
}

function filterSlashItems(items: SlashCommandItem[], query: string, _editor: Editor): SlashCommandItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((item) => {
    if (item.label.toLowerCase().includes(q)) return true
    if (item.description.toLowerCase().includes(q)) return true
    return item.keywords.some((kw) => kw.includes(q))
  })
}
