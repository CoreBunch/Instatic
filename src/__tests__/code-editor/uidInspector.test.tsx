/**
 * uidInspector — the God Mode HTML panel's reverse mapping: which node's
 * markup the cursor is in (by the projection's `uid` attributes), and which
 * node a clicked tag name belongs to.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { html } from '@codemirror/lang-html'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'
import { uidAtCursor, uidOfTagNameAt } from '@site/code-editor/uidInspector'

afterEach(cleanup)

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const DOC = '<div uid="node-a" class="card"><p uid="node-b">Hi</p><span>new</span></div>'

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [html()] })
}

/** Position of `marker` in `doc` (the marker is removed). */
function at(doc: string, marker = '|'): { state: EditorState; pos: number } {
  const pos = doc.indexOf(marker)
  return { state: stateFor(doc.replace(marker, '')), pos }
}

describe('uidAtCursor', () => {
  it('maps a cursor inside an element — open tag, text, close tag — to its uid', () => {
    for (const doc of [
      '<div uid="node-a" class="card"><p uid="node-b">H|i</p></div>',
      '<div uid="node-a" class="card"><p| uid="node-b">Hi</p></div>',
      '<div uid="node-a" class="card"><p uid="node-b" |>Hi</p></div>',
      '<div uid="node-a" class="card"><p uid="node-b">Hi</|p></div>',
      '<div uid="node-a" class="card"><p uid="node-b">Hi</p> |</div>',
    ]) {
      const { state, pos } = at(doc)
      expect(uidAtCursor(state, pos)).toBe(doc.includes('</p> |') ? 'node-a' : 'node-b')
    }
  })

  it('reports nothing for uid-less content, even inside a uid-carrying parent, and outside every element', () => {
    expect(uidAtCursor(...Object.values(at('<div uid="node-a"><span>ne|w</span></div>')) as [EditorState, number])).toBeNull()
    expect(uidAtCursor(...Object.values(at('<div uid="node-a"><sp|an>new</span></div>')) as [EditorState, number])).toBeNull()
    expect(uidAtCursor(...Object.values(at('|<div uid="node-a">x</div>')) as [EditorState, number])).toBeNull()
    expect(uidAtCursor(...Object.values(at('<div uid="node-a">x</div>\n|')) as [EditorState, number])).toBeNull()
    expect(uidAtCursor(...Object.values(at('<div uid="">x|</div>')) as [EditorState, number])).toBeNull()
  })
})

describe('uidOfTagNameAt', () => {
  it('resolves a position on an open or close tag name to the element uid, and nothing elsewhere', () => {
    const doc = '<div uid="node-a" class="card"><p uid="node-b">Hi</p></div>'
    const state = stateFor(doc)
    expect(uidOfTagNameAt(state, doc.indexOf('div') + 1)).toBe('node-a')
    expect(uidOfTagNameAt(state, doc.indexOf('<p') + 1)).toBe('node-b')
    expect(uidOfTagNameAt(state, doc.indexOf('</p>') + 2)).toBe('node-b')
    expect(uidOfTagNameAt(state, doc.indexOf('</div>') + 3)).toBe('node-a')
    expect(uidOfTagNameAt(state, doc.indexOf('class'))).toBeNull()
    expect(uidOfTagNameAt(state, doc.indexOf('Hi'))).toBeNull()
    expect(uidOfTagNameAt(stateFor('<div uid="node-a"><span>x</span></div>'), 20)).toBeNull()
  })
})

describe('CodeMirrorEditor — onTagClick', () => {
  async function mountWithClicks(): Promise<{ view: EditorView; clicks: string[] }> {
    const clicks: string[] = []
    render(
      <CodeMirrorEditor
        docKey="html-panel"
        value={DOC}
        language="html"
        changeDelayMs={0}
        onChange={() => {}}
        onTagClick={(uid) => clicks.push(uid)}
      />,
    )
    await nextFrame()
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
    // No layout in the test DOM: resolve the pointer to the tag name directly.
    ;(view as unknown as { posAtCoords: () => number }).posAtCoords = () => DOC.indexOf('<p') + 1
    return { view, clicks }
  }

  function press(view: EditorView, from: [number, number], to: [number, number]) {
    act(() => {
      view.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: from[0], clientY: from[1] }))
      view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: to[0], clientY: to[1] }))
    })
  }

  it('reports the tag under a press-and-release, not under a drag or a range selection', async () => {
    const { view, clicks } = await mountWithClicks()
    press(view, [10, 10], [11, 10])
    expect(clicks).toEqual(['node-b'])
    press(view, [10, 10], [40, 10])
    expect(clicks).toEqual(['node-b'])
    act(() => {
      view.dispatch({ selection: { anchor: 0, head: 5 } })
    })
    press(view, [10, 10], [10, 10])
    expect(clicks).toEqual(['node-b'])
  })
})

describe('CodeMirrorEditor — onCursorUid', () => {
  // Blur → null is verified in the browser: happy-dom does not model
  // document focus, which CodeMirror's focusChanged depends on.
  it('reports the uid under the cursor as the selection moves', async () => {
    const seen: (string | null)[] = []
    render(
      <CodeMirrorEditor
        docKey="html-panel"
        value={DOC}
        language="html"
        changeDelayMs={0}
        onChange={() => {}}
        onCursorUid={(uid) => seen.push(uid)}
      />,
    )
    await nextFrame()
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
    act(() => {
      view.focus()
      view.dispatch({ selection: { anchor: DOC.indexOf('Hi') + 1 } })
    })
    expect(seen.at(-1)).toBe('node-b')
    act(() => {
      view.dispatch({ selection: { anchor: DOC.indexOf('new') + 1 } })
    })
    expect(seen.at(-1)).toBeNull()
    act(() => {
      view.dispatch({ selection: { anchor: DOC.indexOf('class') } })
    })
    expect(seen.at(-1)).toBe('node-a')
    // Same element again: no duplicate report.
    const count = seen.length
    act(() => {
      view.dispatch({ selection: { anchor: DOC.indexOf('class') + 2 } })
    })
    expect(seen.length).toBe(count)
  })
})
