/**
 * CodeMirrorEditor — `onSubmit` (Mod-Enter) and `readOnly` (God Mode HTML
 * panel: explicit apply, view-only Component internals).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'

afterEach(cleanup)
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
// CodeMirror binds `Mod` to Cmd on Mac platforms and Ctrl elsewhere.
const MOD = /Mac|iP/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }

async function mount(props: { onSubmit?: () => void; readOnly?: boolean; onChange?: (content: string) => void }) {
  render(
    <CodeMirrorEditor
      docKey="submit-test"
      value="<p>Hi</p>"
      language="html"
      changeDelayMs={0}
      onChange={props.onChange ?? (() => {})}
      onSubmit={props.onSubmit}
      readOnly={props.readOnly}
    />,
  )
  await nextFrame()
  return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
}

describe('CodeMirrorEditor — submit and read-only', () => {
  it('runs onSubmit on Mod-Enter after flushing the latest text', async () => {
    const seen: string[] = []
    let submitted = 0
    const view = await mount({
      onChange: (content) => seen.push(content),
      onSubmit: () => {
        submitted++
      },
    })
    view.dispatch({ changes: { from: 3, to: 5, insert: 'Hello' } })
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ...MOD, bubbles: true }))
    await nextFrame()
    expect(submitted).toBe(1)
    expect(seen.at(-1)).toBe('<p>Hello</p>')
    // A plain Enter is still a newline, not a submit.
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(submitted).toBe(1)
  })

  it('rejects edits while readOnly', async () => {
    const seen: string[] = []
    const view = await mount({ readOnly: true, onChange: (content) => seen.push(content) })
    view.dispatch({ changes: { from: 3, to: 5, insert: 'Hello' } })
    await nextFrame()
    expect(view.state.doc.toString()).toBe('<p>Hi</p>')
    expect(seen).toEqual([])
    expect(view.contentDOM.getAttribute('contenteditable')).toBe('false')
  })
})
