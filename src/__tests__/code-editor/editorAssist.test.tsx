/**
 * CodeMirrorEditor assists: Tab accepts an open completion, a bare
 * `--name;` in CSS expands to `var(--name);`, `syncValue` patches the
 * buffer in place without re-entering onChange, the lint gutter can be
 * turned off, and `format()` reports unsupported documents.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { CompletionContext, completionStatus, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { css } from '@codemirror/lang-css'
import CodeMirrorEditor, { type CodeMirrorEditorHandle } from '@site/code-editor/CodeMirrorEditor'
import { contextCompletions } from '@site/code-editor/contextCompletions'
import type { CssCompletionCatalog } from '@site/code-editor/completionCatalog'

afterEach(cleanup)

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

const cssCatalog: CssCompletionCatalog = {
  kind: 'css',
  classes: [],
  customProperties: [{ name: '--primary', value: 'blue', origin: 'framework', declaredIn: 'Framework · colors' }],
}

interface Mounted {
  view: EditorView
  changes: string[]
  rerender: (value: string) => void
  handle: CodeMirrorEditorHandle
}

async function mount(props: {
  value: string
  language: 'css' | 'html' | 'text'
  syncValue?: boolean
  lintGutter?: boolean
}): Promise<Mounted> {
  const changes: string[] = []
  const handleRef: { current: CodeMirrorEditorHandle | null } = { current: null }
  const element = (value: string) => (
    <CodeMirrorEditor
      ref={handleRef}
      docKey="assist"
      value={value}
      language={props.language}
      changeDelayMs={0}
      syncValue={props.syncValue}
      lintGutter={props.lintGutter}
      completions={props.language === 'css' ? cssCatalog : undefined}
      onChange={(text) => changes.push(text)}
    />
  )
  const rendered = render(element(props.value))
  await nextFrame()
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
  return { view, changes, rerender: (value) => rendered.rerender(element(value)), handle: handleRef.current! }
}

function typeText(view: EditorView, text: string) {
  act(() => {
    const handlers = view.state.facet(EditorView.inputHandler)
    const from = view.state.selection.main.head
    if (!handlers.some((handler) => handler(view, from, from, text, () => view.state.update()))) {
      view.dispatch({ changes: { from, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' })
    }
  })
}

describe('CodeMirrorEditor assists', () => {
  it('expands a bare custom property value into var() when ; is typed', async () => {
    const { view } = await mount({ value: '.card { color: --primary', language: 'css' })
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
    })
    typeText(view, ';')
    expect(view.state.doc.toString()).toBe('.card { color: var(--primary);')
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    // Not for anything that is not a bare custom property.
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' margin: 1px' }, selection: { anchor: view.state.doc.length + 12 } })
    })
    typeText(view, ';')
    expect(view.state.doc.toString()).toBe('.card { color: var(--primary); margin: 1px;')
  })

  it('offers site custom properties for a bare -- value, completing to var(--name)', async () => {
    const doc = '.card { color: --pr'
    const state = EditorState.create({ doc, extensions: [css(), contextCompletions(() => cssCatalog)] })
    const sources = state.languageDataAt<CompletionSource>('autocomplete', doc.length)
    const context = new CompletionContext(state, doc.length, false)
    const results = (await Promise.all(sources.map((source) => source(context)))).filter((r) => r !== null)
    const option = results.flatMap((r) => r.options).find((o) => o.label === '--primary')
    expect(option?.apply).toBe('var(--primary)')
    // A custom property NAME being declared is not a value.
    const declaring = '.card { --pr'
    const declaringState = EditorState.create({ doc: declaring, extensions: [css(), contextCompletions(() => cssCatalog)] })
    const declaringResults = (await Promise.all(
      declaringState.languageDataAt<CompletionSource>('autocomplete', declaring.length)
        .map((source) => source(new CompletionContext(declaringState, declaring.length, false))),
    )).filter((r) => r !== null)
    expect(declaringResults.flatMap((r) => r.options).some((o) => o.apply === 'var(--primary)')).toBe(false)
  })

  it('accepts an open completion with Tab', async () => {
    const { view } = await mount({ value: '.card { color: var(--pr', language: 'css' })
    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      view.focus()
      startCompletion(view)
    })
    await nextFrame()
    // acceptCompletion ignores keys inside the interaction delay after opening.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(completionStatus(view.state)).toBe('active')
    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    expect(view.state.doc.toString()).toBe('.card { color: var(--primary')
  })

  it('patches the buffer in place when value changes with syncValue, keeping the caret and skipping onChange', async () => {
    const { view, changes, rerender } = await mount({ value: '<div>\n  <p>Hi</p>\n  <span>x</span>\n</div>', language: 'html', syncValue: true })
    const caret = '<div>\n  <p>Hi</p>\n  <span>'.length + 1
    act(() => {
      view.dispatch({ selection: { anchor: caret } })
    })
    act(() => {
      rerender('<div>\n  <p uid="a">Hi</p>\n  <span>x</span>\n</div>')
    })
    expect(view.state.doc.toString()).toBe('<div>\n  <p uid="a">Hi</p>\n  <span>x</span>\n</div>')
    expect(view.state.selection.main.head).toBe(caret + ' uid="a"'.length)
    expect(changes).toEqual([])
    expect(EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)).toBe(view)
  })

  it('ignores value changes without syncValue (the caller re-keys instead)', async () => {
    const { view, rerender } = await mount({ value: 'a', language: 'text' })
    act(() => {
      rerender('b')
    })
    expect(view.state.doc.toString()).toBe('a')
  })

  it('omits the lint gutter when asked', async () => {
    await mount({ value: '.card {}', language: 'css', lintGutter: false })
    expect(document.querySelector('.cm-gutter-lint')).toBeNull()
    cleanup()
    await mount({ value: '.card {}', language: 'css' })
    expect(document.querySelector('.cm-gutter-lint')).toBeTruthy()
  })

  it('formats a document with Prettier through the handle, keeping the caret in the same token', async () => {
    const { view, handle, changes } = await mount({ value: '.card{color:red;margin:0}', language: 'css' })
    act(() => {
      view.dispatch({ selection: { anchor: '.card{color:re'.length } })
    })
    const result = await act(() => handle.format())
    expect(result).toEqual({ ok: true })
    expect(view.state.doc.toString()).toBe('.card {\n  color: red;\n  margin: 0;\n}\n')
    expect(view.state.doc.sliceString(view.state.selection.main.head - 2, view.state.selection.main.head)).toBe('re')
    expect(changes.at(-1)).toBe('.card {\n  color: red;\n  margin: 0;\n}\n')
  })

  it('reports an unformattable document instead of throwing', async () => {
    const { handle } = await mount({ value: 'plain', language: 'text' })
    expect(await handle.format()).toEqual({ ok: false, error: 'This document type cannot be formatted' })
  })
})
