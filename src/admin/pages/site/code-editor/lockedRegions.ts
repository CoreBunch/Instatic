/**
 * lockedRegions — read-only, folded-by-default ranges inside an otherwise
 * editable CodeMirror document (the God Mode CSS panel's framework-utility
 * blocks: locked everywhere else in the editor, shown here so the cascade
 * never lies, never editable).
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import { EditorState, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { foldEffect } from '@codemirror/language'

export interface LockedRange {
  from: number
  to: number
}

/** Locked ranges, mapped through every change so they follow edits above them. */
const lockedRangesField = StateField.define<readonly LockedRange[]>({
  create: () => [],
  update: (ranges, tr) =>
    tr.docChanged
      ? ranges.map((range) => ({
          from: tr.changes.mapPos(range.from, 1),
          to: tr.changes.mapPos(range.to, -1),
        }))
      : ranges,
})

const lockedLine = Decoration.line({ class: 'cm-lockedLine' })

const lockedLineDecorations = EditorView.decorations.compute([lockedRangesField], (state) => {
  const builder: Array<ReturnType<typeof lockedLine.range>> = []
  for (const range of state.field(lockedRangesField)) {
    const last = state.doc.lineAt(Math.max(range.from, Math.min(range.to, state.doc.length)))
    for (let line = state.doc.lineAt(range.from); ; line = state.doc.line(line.number + 1)) {
      builder.push(lockedLine.range(line.from))
      if (line.number >= last.number) break
    }
  }
  return Decoration.set(builder, true) as DecorationSet
})

/** Refuse any transaction that changes text inside a locked range. */
const rejectLockedChanges = EditorState.changeFilter.of((tr) => {
  const ranges = tr.startState.field(lockedRangesField)
  if (ranges.length === 0) return true
  let blocked = false
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (blocked) return
    for (const range of ranges) {
      if (fromA < range.to && toA > range.from) {
        blocked = true
        return
      }
    }
  })
  return !blocked
})

const lockedTheme = EditorView.theme({
  '.cm-lockedLine': {
    backgroundColor: 'var(--overlay-10)',
    color: 'var(--text-muted)',
  },
})

export function lockedRegions(initial: readonly LockedRange[]): Extension {
  return [
    lockedRangesField.init(() => initial.map((range) => ({ ...range }))),
    lockedLineDecorations,
    rejectLockedChanges,
    lockedTheme,
  ]
}

/**
 * Collapse each locked block's body (after its first line through its last)
 * so read-only utilities take one line until the user expands them from the
 * fold gutter.
 */
export function foldLockedRanges(view: EditorView, ranges: readonly LockedRange[]): void {
  const effects = ranges.flatMap((range) => {
    // Fold from the end of the opening line (the annotation comment) to the
    // end of the block; a single-line block has nothing to fold.
    const first = view.state.doc.lineAt(range.from)
    const to = Math.min(range.to, view.state.doc.length)
    return first.to < to ? [foldEffect.of({ from: first.to, to })] : []
  })
  if (effects.length > 0) view.dispatch({ effects })
}
