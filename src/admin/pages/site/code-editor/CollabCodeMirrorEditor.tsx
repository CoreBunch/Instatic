/**
 * CollabCodeMirrorEditor — the co-editing CodeMirror mount.
 *
 * A sibling lazy module to CodeMirrorEditor (same React.lazy rule — this
 * file and CodeMirrorEditor.tsx are the only static CodeMirror importers,
 * gated by codemirror-lazy-only.test.ts). Wraps the base editor with
 * y-codemirror.next's `yCollab` extension: local keystrokes splice the
 * bound Y.Text, remote peers' edits apply character-precise, and their
 * carets/selections render inline colored by each peer's awareness
 * identity. Undo is the passed Y.UndoManager — local-only by construction:
 * the base editor mounts WITHOUT its own `history()` (which would record
 * remote deltas as undoable steps), and the Y undo keymap takes precedence
 * over every other Mod-z binding in the stack.
 */
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import CodeMirrorEditor, { type CodeLanguage } from './CodeMirrorEditor'

/** Remote peer carets/selections — colors ride each peer's awareness
 *  `user.color`; class names come from y-codemirror.next. */
const remotePeerTheme = EditorView.theme({
  '.cm-yLineSelection': {
    padding: 0,
    margin: '0 var(--space-3xs)',
  },
  '.cm-ySelectionCaret': {
    position: 'relative',
    borderLeft: '1px solid',
    borderRight: '1px solid',
    marginLeft: '-1px',
    marginRight: '-1px',
    boxSizing: 'border-box',
    display: 'inline',
  },
  '.cm-ySelectionCaretDot': {
    borderRadius: '50%',
    position: 'absolute',
    width: '.4em',
    height: '.4em',
    top: '-.2em',
    left: '-.2em',
    backgroundColor: 'inherit',
    transition: 'transform .3s ease-in-out',
    boxSizing: 'border-box',
  },
  '.cm-ySelectionCaret:hover > .cm-ySelectionCaretDot': {
    transform: 'scale(0)',
  },
  '.cm-ySelectionInfo': {
    position: 'absolute',
    top: '-1.05em',
    left: '-1px',
    fontSize: 'var(--text-2xs)',
    fontFamily: 'var(--font-sans)',
    fontStyle: 'normal',
    fontWeight: 'normal',
    lineHeight: 'normal',
    userSelect: 'none',
    color: 'var(--bg-surface)',
    paddingLeft: 'var(--space-px)',
    paddingRight: 'var(--space-px)',
    zIndex: 101,
    transition: 'opacity .3s ease-in-out',
    backgroundColor: 'inherit',
    opacity: 0,
    transitionDelay: '0s',
    whiteSpace: 'nowrap',
  },
  '.cm-ySelectionCaret:hover > .cm-ySelectionInfo': {
    opacity: 1,
    transitionDelay: '0s',
  },
})

interface CollabCodeMirrorEditorProps {
  /** Stable identity — switching remounts the underlying view. */
  docKey: string
  language: CodeLanguage
  /** The live CRDT text this buffer edits. */
  text: Y.Text
  awareness: Awareness
  /** Local-only undo; false disables the binding's undo integration. */
  undoManager: Y.UndoManager | false
  readOnly: boolean
}

export default function CollabCodeMirrorEditor({
  docKey,
  language,
  text,
  awareness,
  undoManager,
  readOnly,
}: CollabCodeMirrorEditorProps) {
  // Recomputed per render is fine: CodeMirrorEditor captures `value` and
  // `extensions` at mount and only remounts when `docKey` changes.
  const extensions: Extension[] = [
    Prec.high(keymap.of(yUndoManagerKeymap)),
    yCollab(text, awareness, { undoManager }),
    remotePeerTheme,
    ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
  ]

  return (
    <CodeMirrorEditor
      docKey={docKey}
      value={text.toString()}
      language={language}
      // Content persistence is the Y binding's job — no onChange, no listener.
      extensions={extensions}
      localHistory={false}
    />
  )
}
