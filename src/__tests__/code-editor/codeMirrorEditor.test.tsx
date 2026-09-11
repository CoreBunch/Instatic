import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { diagnosticCount } from '@codemirror/lint'
import CodeMirrorEditor from '@site/code-editor/CodeMirrorEditor'
import type {
  TypeScriptWorkerRequest,
  TypeScriptWorkerResponse,
} from '@site/code-editor/typescriptProtocol'
import { renderMarkdownDocumentation } from '@site/code-editor/markdownDocumentation'

afterEach(cleanup)

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

describe('CodeMirrorEditor', () => {
  it('renders TypeScript hover documentation as safe Markdown', () => {
    const container = document.createElement('div')
    renderMarkdownDocumentation(
      container,
      '**`window.document`** returns a reference.\n\n[MDN Reference](https://developer.mozilla.org/docs/Web/API/Window/document)',
    )

    expect(container.textContent).not.toContain('**')
    expect(container.querySelector('strong code')?.textContent).toBe('window.document')
    const link = container.querySelector<HTMLAnchorElement>('a')
    expect(link?.textContent).toBe('MDN Reference')
    expect(link?.href).toBe('https://developer.mozilla.org/docs/Web/API/Window/document')
    expect(link?.target).toBe('_blank')
  })

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

  it('merges semantic TypeScript diagnostics from the lazy worker', async () => {
    const originalWorker = globalThis.Worker
    const originalWindowWorker = window.Worker
    const reported: number[] = []

    class DiagnosticWorker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null

      postMessage(request: TypeScriptWorkerRequest) {
        if (request.type !== 'diagnostics') return
        const response: TypeScriptWorkerResponse = {
          type: 'diagnostics',
          requestId: request.requestId,
          diagnostics: [{
            code: 2322,
            severity: 'error',
            message: "Type 'string' is not assignable to type 'number'.",
            from: 6,
            to: 11,
            line: 1,
            column: 6,
          }],
        }
        queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: response })))
      }

      terminate() {}
    }

    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      writable: true,
      value: DiagnosticWorker,
    })
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      writable: true,
      value: DiagnosticWorker,
    })

    try {
      render(
        <CodeMirrorEditor
          docKey="script-typed"
          value="const title: number = document.title"
          language="ts"
          filePath="src/scripts/typed.ts"
          projectFiles={[{
            path: 'src/scripts/typed.ts',
            content: 'const title: number = document.title',
          }]}
          onChange={() => undefined}
          onTypeScriptDiagnosticsChange={(diagnostics) => reported.push(diagnostics.length)}
        />,
      )

      await waitFor(() => {
        const editor = document.querySelector<HTMLElement>('.cm-editor')
        const view = EditorView.findFromDOM(editor!)!
        expect(diagnosticCount(view.state)).toBe(1)
      })
      expect(reported).toContain(1)
      expect(document.querySelector('.cm-lint-marker-error')).toBeTruthy()
    } finally {
      Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWorker,
      })
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: originalWindowWorker,
      })
    }
  })
})
