/**
 * CodeMirrorEditor — uid attribute widgets (God Mode HTML panel).
 *
 * With `foldUidAttributes`, every `uid="…"` attribute is replaced on screen
 * by the Instatic mark; the text itself stays in the document (the apply
 * path needs it). Clicking the mark reveals that uid next to it; clicking
 * again hides it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'

afterEach(cleanup)

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const DOC = '<div uid="node-a" class="card"><p uid="node-b">Hi</p></div>'

async function mount(fold = true) {
  render(
    <CodeMirrorEditor
      docKey="html-panel"
      value={DOC}
      language="html"
      changeDelayMs={0}
      foldUidAttributes={fold}
      onChange={() => {}}
    />,
  )
  await nextFrame()
  await nextFrame()
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
  expect(view).toBeTruthy()
  return view
}

const marks = () => document.querySelectorAll<HTMLElement>('.cm-uidMark')
const visibleText = (view: EditorView) => view.contentDOM.textContent ?? ''

describe('CodeMirrorEditor — uid attribute widgets', () => {
  it('replaces every uid attribute with a mark while keeping the document text intact', async () => {
    const view = await mount()
    expect(marks().length).toBe(2)
    expect(visibleText(view)).not.toContain('uid="node-a"')
    expect(visibleText(view)).not.toContain('node-b')
    expect(visibleText(view)).toContain('class="card"')
    expect(view.state.doc.toString()).toBe(DOC)
  })

  it('reveals a uid on click and hides it again on the next click', async () => {
    const view = await mount()
    const first = marks()[0]
    expect(first.getAttribute('aria-pressed')).toBe('false')
    act(() => {
      first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await nextFrame()
    expect(visibleText(view)).toContain('uid="node-a"')
    expect(visibleText(view)).not.toContain('node-b')
    expect(marks().length).toBe(2)
    expect(marks()[0].getAttribute('aria-pressed')).toBe('true')

    act(() => {
      marks()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await nextFrame()
    expect(visibleText(view)).not.toContain('uid="node-a"')
    expect(marks()[0].getAttribute('aria-pressed')).toBe('false')
    expect(view.state.doc.toString()).toBe(DOC)
  })

  it('leaves the attributes visible when the option is off', async () => {
    const view = await mount(false)
    expect(marks().length).toBe(0)
    expect(visibleText(view)).toContain('uid="node-a"')
  })
})
