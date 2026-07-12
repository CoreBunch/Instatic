/**
 * AgentCodeView — read-only CodeMirror code + unified-diff blocks for the
 * agent panel's tool rows (what did `plugin_write_file` write, what did
 * `plugin_patch_file` change).
 *
 * LAZY-LOADED via React.lazy() in ToolCallRow — this module MUST NOT be
 * imported statically from the admin main chunk (CodeMirror is ~150 kB
 * min+gz; the codemirror-lazy-only gate pins the allowed importers). It
 * shares the editor chrome theme + language stacks with CodeMirrorEditor.
 *
 * `diffOriginal` switches the block into a unified merge view
 * (@codemirror/merge): deletions render inline above their replacements —
 * a real diff, not two stacked snippets.
 */
import { useEffect, useRef } from 'react'
import { EditorView, lineNumbers } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { syntaxHighlighting } from '@codemirror/language'
import { unifiedMergeView } from '@codemirror/merge'
import {
  editorChromeTheme,
  getLanguageExtensions,
  readableHighlightStyle,
  type CodeLanguage,
} from './CodeMirrorEditor'

/** Map a file path to the highlight language by extension. */
function codeLanguageForPath(path: string): CodeLanguage {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (extension) {
    case 'tsx':
    case 'jsx':
      return 'tsx'
    case 'ts':
    case 'js':
    case 'mjs':
      return 'ts'
    case 'css':
      return 'css'
    case 'json':
      return 'json'
    case 'md':
      return 'markdown'
    case 'html':
    case 'svg':
      return 'html'
    default:
      return 'text'
  }
}

interface AgentCodeViewProps {
  /** The (new) code to display. */
  code: string
  /** Path used only to pick the highlight language. */
  path: string
  /** When set, render a unified diff from this original to `code`. */
  diffOriginal?: string
}

export default function AgentCodeView({ code, path, diffOriginal }: AgentCodeViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: code,
        extensions: [
          // Chat rows are denser than the editor — drop the base 12px to
          // the fluid --text-xs token (~10-11px).
          EditorView.theme({ '&': { fontSize: 'var(--text-xs)' } }),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          lineNumbers(),
          editorChromeTheme,
          syntaxHighlighting(readableHighlightStyle),
          ...getLanguageExtensions(codeLanguageForPath(path)),
          ...(diffOriginal !== undefined
            ? [
                unifiedMergeView({
                  original: diffOriginal,
                  mergeControls: false,
                  gutter: true,
                }),
              ]
            : []),
        ],
      }),
    })
    return () => view.destroy()
  }, [code, path, diffOriginal])

  return <div ref={hostRef} data-testid="agent-code-view" />
}
