import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { diagnosticCount } from '@codemirror/lint'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'

afterEach(cleanup)

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

describe('CodeMirrorEditor', () => {
  it('can emit changes immediately for modal command surfaces', async () => {
    const changes: string[] = []
    render(
      <CodeMirrorEditor
        docKey="import-html"
        value="<p>Old</p>"
        language="html"
        changeDelayMs={0}
        onChange={(content) => changes.push(content)}
      />,
    )
    await nextFrame()

    const editor = document.querySelector<HTMLElement>('.cm-editor')
    expect(editor).toBeTruthy()

    const view = EditorView.findFromDOM(editor!)
    expect(view).toBeTruthy()
    view!.dispatch({
      changes: {
        from: 0,
        to: view!.state.doc.length,
        insert: '<section>New</section>',
      },
    })
    await nextFrame()

    expect(changes).toEqual(['<section>New</section>'])
  })

  it('updates compiler diagnostics without remounting the editor', async () => {
    const { rerender } = render(
      <CodeMirrorEditor
        docKey="script-1"
        value={'const value = true\n'}
        language="ts"
        onChange={() => undefined}
        diagnostics={[]}
      />,
    )
    await nextFrame()

    const editor = document.querySelector<HTMLElement>('.cm-editor')
    const view = EditorView.findFromDOM(editor!)!
    expect(diagnosticCount(view.state)).toBe(0)

    rerender(
      <CodeMirrorEditor
        docKey="script-1"
        value={'const value = true\n'}
        language="ts"
        onChange={() => undefined}
        diagnostics={[{
          code: 'runtime-bundle-error',
          severity: 'error',
          message: 'Expected identifier',
          line: 1,
          column: 6,
        }]}
      />,
    )
    await nextFrame()

    expect(EditorView.findFromDOM(editor!)).toBe(view)
    expect(diagnosticCount(view.state)).toBe(1)
    expect(document.querySelector('.cm-lint-marker-error')).toBeTruthy()
  })
})
