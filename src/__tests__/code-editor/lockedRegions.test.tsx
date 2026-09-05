/**
 * CodeMirrorEditor — locked regions + syntax gating (God Mode CSS panel).
 *
 * Locked ranges (framework utility blocks) reject edits, fold on mount and
 * carry a line class; `lintSyntax` reports the parser's error count with
 * every change so callers can hold back applies while the document is
 * mid-edit.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { foldedRanges } from '@codemirror/language'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'

afterEach(cleanup)

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const DOC = [
  '/* .card · class · used by 1 element */',
  '.card {',
  '  color: red;',
  '}',
  '',
  '/* .text-m · framework utility · read-only · used by 1 element */',
  '.text-m {',
  '  font-size: var(--text-m);',
  '}',
  '',
].join('\n')
const LOCKED_FROM = DOC.indexOf('/* .text-m')
const LOCKED_TO = DOC.lastIndexOf('}') + 1

async function mount(onChange: (content: string, info: { syntaxErrorCount: number }) => void) {
  render(
    <CodeMirrorEditor
      docKey="css-panel"
      value={DOC}
      language="css"
      changeDelayMs={0}
      lintSyntax
      lockedRanges={[{ from: LOCKED_FROM, to: LOCKED_TO }]}
      onChange={onChange}
    />,
  )
  await nextFrame()
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
  expect(view).toBeTruthy()
  return view
}

describe('CodeMirrorEditor — locked regions', () => {
  it('rejects edits inside a locked range and accepts edits outside it', async () => {
    const changes: string[] = []
    const view = await mount((content) => changes.push(content))

    view.dispatch({ changes: { from: DOC.indexOf('var(--text-m)'), to: DOC.indexOf('var(--text-m)') + 3, insert: 'xxx' } })
    await nextFrame()
    expect(view.state.doc.toString()).toBe(DOC)
    expect(changes).toEqual([])

    view.dispatch({ changes: { from: DOC.indexOf('red'), to: DOC.indexOf('red') + 3, insert: 'blue' } })
    await nextFrame()
    expect(view.state.doc.toString()).toContain('color: blue;')
    expect(changes).toHaveLength(1)

    // The locked range followed the edit and still guards the utility block.
    const shifted = view.state.doc.toString().indexOf('var(--text-m)')
    view.dispatch({ changes: { from: shifted, to: shifted + 3, insert: 'xxx' } })
    expect(view.state.doc.toString()).toContain('font-size: var(--text-m);')
  })

  it('folds the locked block on mount and marks its lines', async () => {
    const view = await mount(() => {})
    const folded: Array<[number, number]> = []
    foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
      folded.push([from, to])
    })
    expect(folded).toHaveLength(1)
    expect(view.state.doc.sliceString(folded[0][0], folded[0][1])).toContain('font-size')
    expect(document.querySelectorAll('.cm-lockedLine').length).toBeGreaterThan(0)
  })

  it('reports the syntax error count alongside each change', async () => {
    const infos: number[] = []
    const view = await mount((_content, info) => infos.push(info.syntaxErrorCount))

    const braceAt = DOC.indexOf('.card {') + '.card {'.length
    view.dispatch({ changes: { from: braceAt - 1, to: braceAt, insert: '' } })
    await nextFrame()
    view.dispatch({ changes: { from: braceAt - 1, insert: '{' } })
    await nextFrame()

    expect(infos[0]).toBeGreaterThan(0)
    expect(infos[1]).toBe(0)
  })
})
