/**
 * uidInspector — the God Mode HTML panel as an inspector: the projection's
 * `uid` attributes map the editor back onto the page tree, so
 *
 *   - the element whose markup the cursor is in is reported as it changes
 *     (the panel hover-highlights that node in canvas and layer panel), and
 *     null when the cursor leaves every uid-carrying element or the editor
 *     loses focus;
 *   - a click on a tag name (open or close tag) reports that element's uid
 *     (the panel selects the node). A click is a press and release without
 *     drag, detected from the mouse events: the browser's own `click` is
 *     unreliable here, because placing the caret makes CodeMirror redraw the
 *     line and the pressed node is gone by the time the button comes up.
 *
 * Only the nearest enclosing element counts: content without a uid — a tag
 * typed but not applied yet — maps to nothing, never to its parent. The
 * extension never moves focus; it only observes the view.
 *
 * Part of the lazy CodeMirror chunk (see codemirror-lazy-only.test.ts).
 */
import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { elementAttribute, enclosingElement, type SyntaxNode } from './syntaxNode'

function elementUid(state: EditorState, element: SyntaxNode): string | null {
  return elementAttribute(state, element, 'uid') || null
}

/** The uid of the element whose markup `pos` is in; null for uid-less or no element. */
export function uidAtCursor(state: EditorState, pos: number): string | null {
  const element = enclosingElement(syntaxTree(state).resolveInner(pos, -1))
  return element ? elementUid(state, element) : null
}

/** The uid of the element whose open or close tag NAME is at `pos`; null elsewhere. */
export function uidOfTagNameAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) {
    const node = tree.resolveInner(pos, side)
    if (node.name !== 'TagName') continue
    const element = enclosingElement(node.parent)
    return element ? elementUid(state, element) : null
  }
  return null
}

export interface UidInspectorHandlers {
  onCursorUid: (uid: string | null) => void
  onTagClick: (uid: string) => void
}

/** Pointer travel (px) beyond which a press-and-release is a drag, not a click. */
const CLICK_TRAVEL_PX = 3

export function uidInspector(handlers: () => UidInspectorHandlers): Extension {
  let reported: string | null = null
  const report = (uid: string | null) => {
    if (uid === reported) return
    reported = uid
    handlers().onCursorUid(uid)
  }
  let pressed: { x: number; y: number } | null = null
  return [
    EditorView.updateListener.of((update) => {
      if (update.focusChanged && !update.view.hasFocus) {
        report(null)
        return
      }
      if (update.selectionSet || update.docChanged || update.focusChanged) {
        report(uidAtCursor(update.state, update.state.selection.main.head))
      }
    }),
    EditorView.domEventObservers({
      mousedown(event) {
        pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null
      },
      mouseup(event, view) {
        const start = pressed
        pressed = null
        if (!start || event.button !== 0) return
        if (Math.abs(event.clientX - start.x) > CLICK_TRAVEL_PX || Math.abs(event.clientY - start.y) > CLICK_TRAVEL_PX) return
        if (!view.state.selection.main.empty) return
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null) return
        const uid = uidOfTagNameAt(view.state, pos)
        if (uid) handlers().onTagClick(uid)
      },
    }),
  ]
}
