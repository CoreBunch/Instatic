/**
 * cssVarShorthand — write a custom property reference by its name alone:
 * typing `;` after a bare `--name` value turns the declaration into
 * `prop: var(--name);`. (`--name` on its own is not a valid value, so no
 * meaning is lost; the completions offer the same expansion.)
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** `prop: --name` up to the cursor, with only whitespace around the name. */
const BARE_CUSTOM_PROPERTY_VALUE = /:\s*(--[\w-]+)\s*$/

export function cssVarShorthand(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== ';' || from !== to) return false
    const line = view.state.doc.lineAt(from)
    const before = view.state.sliceDoc(line.from, from)
    const match = BARE_CUSTOM_PROPERTY_VALUE.exec(before)
    if (!match) return false
    const nameFrom = line.from + before.lastIndexOf(match[1])
    const nameTo = nameFrom + match[1].length
    view.dispatch({
      changes: [
        { from: nameFrom, to: nameTo, insert: `var(${match[1]})` },
        { from, to, insert: ';' },
      ],
      selection: { anchor: from + 'var()'.length + 1 },
      userEvent: 'input.type',
    })
    return true
  })
}
